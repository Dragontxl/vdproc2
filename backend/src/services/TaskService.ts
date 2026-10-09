import { Bindings } from '../types/env';
import { Task, TaskPhase, TaskStatus, Shot, Character, ShotDetail, CharacterFrame } from '../types';
import { CryptoService } from './CryptoService';
import { MaterialCheckService } from './MaterialCheckService';

const phaseOrder: TaskPhase[] = ['DETECT', 'ANALYZE', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'];

const phaseStatusMap: Record<TaskPhase, { running: TaskStatus; done: TaskStatus }> = {
  DETECT: { running: 'DETECTING', done: 'DETECTED' },
  ANALYZE: { running: 'ANALYZING', done: 'ANALYZED' },
  CROP_SHOTS: { running: 'CROPPING_SHOTS', done: 'SHOTS_CROPPED' },
  CONVERT_FRAMES: { running: 'CONVERTING_FRAMES', done: 'FRAMES_CONVERTED' },
  GENERATE_SHOTS: { running: 'GENERATING_SHOTS', done: 'SHOTS_GENERATED' },
  COMPOSE: { running: 'COMPOSING', done: 'COMPLETED' },
};

const phasesRequiringAI: Partial<Record<TaskPhase, string>> = {
  ANALYZE: 'text',
  CONVERT_FRAMES: 'image',
  GENERATE_SHOTS: 'video',
};

export class TaskService {
  private cryptoService: CryptoService;

  constructor(public env: Bindings) {
    this.cryptoService = new CryptoService(env);
  }

  /**
   * 返回任务阶段的顺序数组（供路由层与范围执行逻辑使用）
   */
  getPhaseOrder(): TaskPhase[] {
    return phaseOrder;
  }

  async createTask(data: {
    title: string;
    videoPath: string;
    fps: number;
    prompt: string;
    outputFps: number;
    priority?: number;
    tags?: string;
    analyzeDialogueLanguage?: string;
    analyzeDialogueStyle?: string;
    scheduledAt?: string;
  }): Promise<Task> {
    const task: Task = {
      id: this.generateUUID(data.title),
      user_id: 'default_user',
      title: data.title,
      video_path: data.videoPath,
      fps: data.fps,
      prompt: data.prompt,
      output_fps: data.outputFps,
      priority: data.priority || 0,
      tags: data.tags || '',
      status: 'PENDING',
      current_phase: 'DETECT',
      progress: 0,
      total_frames: 0,
      processed_frames: 0,
      failed_frames: 0,
      retry_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      analyze_dialogue_language: data.analyzeDialogueLanguage || null,
      analyze_dialogue_style: data.analyzeDialogueStyle || null,
      scheduled_at: data.scheduledAt || null,
    };

    await this.env.DB.prepare(`
      INSERT INTO tasks (id, user_id, title, status, current_phase, video_path, fps, prompt, output_fps, priority, tags, progress, total_frames, processed_frames, failed_frames, retry_count, created_at, updated_at, analyze_dialogue_language, analyze_dialogue_style, scheduled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        task.id,
        task.user_id,
        task.title,
        task.status,
        task.current_phase,
        task.video_path,
        task.fps,
        task.prompt,
        task.output_fps,
        task.priority,
        task.tags,
        task.progress,
        task.total_frames,
        task.processed_frames,
        task.failed_frames || 0,
        task.retry_count,
        task.created_at,
        task.updated_at,
        task.analyze_dialogue_language,
        task.analyze_dialogue_style,
        task.scheduled_at
      )
      .run();

    return task;
  }

  /**
   * 查询当前可以启动的 PENDING 任务（无定时时间或定时时间已到）
   * scheduled_at 与 D1 CURRENT_TIMESTAMP 一致，使用 UTC 'YYYY-MM-DD HH:MM:SS' 格式存储
   */
  async listStartablePendingTasks(limit: number): Promise<Task[]> {
    const nowUtc = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const result = await this.env.DB.prepare(`
      SELECT * FROM tasks
      WHERE status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= ?)
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `).bind(nowUtc, limit).all();
    return (result.results as unknown) as Task[];
  }

  async getTask(id: string): Promise<Task | null> {
    const result = await this.env.DB.prepare(
      `SELECT * FROM tasks WHERE id = ?`
    ).bind(id).first();
    return result as Task | null;
  }

  async listTasks(filters: {
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<Task[]> {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const offset = (page - 1) * limit;

    let query = `SELECT * FROM tasks WHERE 1=1`;
    const params: (string | number)[] = [];

    if (filters.status) {
      query += ` AND status = ?`;
      params.push(filters.status);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const result = await this.env.DB.prepare(query).bind(...params).all();
    return (result.results as unknown) as Task[];
  }

  async updateTask(id: string, data: Partial<Task>): Promise<Task | null> {
    const fields = Object.keys(data).filter(k => k !== 'id');
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => (data as any)[f]);

    await this.env.DB.prepare(`
      UPDATE tasks SET ${setClause}, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `).bind(...values, id).run();

    return this.getTask(id);
  }

  private async deleteR2Prefix(prefix: string): Promise<number> {
    let deletedCount = 0;

    while (true) {
      const objects = await this.env.R2.list({
        prefix,
        limit: 1000,
      });
      const keys = objects.objects.map(object => object.key);

      if (keys.length === 0) {
        break;
      }

      await this.env.R2.delete(keys);
      deletedCount += keys.length;
    }

    return deletedCount;
  }

  async deleteTask(id: string): Promise<boolean> {
    const task = await this.getTask(id);
    if (!task) {
      return false;
    }

    let deletedFileCount: number;
    try {
      deletedFileCount = await this.deleteR2Prefix(`${id}/`);
    } catch (error) {
      console.error(`Failed to delete R2 objects for task ${id}:`, error);
      throw new Error('R2 项目文件删除失败，任务未删除，请重试');
    }

    await this.env.DB.prepare(`DELETE FROM phase_subtasks WHERE task_id = ?`).bind(id).run();
    await this.env.DB.prepare(`DELETE FROM operation_logs WHERE task_id = ?`).bind(id).run();
    await this.env.DB.prepare(`DELETE FROM task_queue WHERE task_id = ?`).bind(id).run();
    await this.env.DB.prepare(`DELETE FROM frame_tasks WHERE task_id = ?`).bind(id).run();

    const result = await this.env.DB.prepare(
      `DELETE FROM tasks WHERE id = ?`
    ).bind(id).run();
    console.log(`Deleted task ${id} and ${deletedFileCount} R2 objects`);
    return (result as any).changes > 0;
  }

  async batchCreateTasks(tasksData: Array<{
    title: string;
    videoPath: string;
    fps: number;
    prompt: string;
    outputFps: number;
    priority?: number;
    tags?: string;
  }>): Promise<Task[]> {
    const results: Task[] = [];
    for (const data of tasksData) {
      const task = await this.createTask(data);
      results.push(task);
    }
    return results;
  }

  async startTask(id: string): Promise<Task | null> {
    const task = await this.getTask(id);
    if (!task) {
      return null;
    }

    if (task.status !== 'PENDING') {
      return null;
    }

    // 范围执行模式：从 DETECT 执行到 COMPOSE
    await this.triggerPhase(id, 'DETECT', undefined, undefined, 'DETECT', 'COMPOSE');
    return this.getTask(id);
  }

  async cancelTask(id: string): Promise<Task | null> {
    const task = await this.getTask(id);
    if (!task) {
      return null;
    }

    if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
      return task;
    }

    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `).bind('CANCELLED', id).run();

    return this.getTask(id);
  }

  async retryTask(id: string): Promise<Task | null> {
    const task = await this.getTask(id);
    if (!task) {
      return null;
    }

    if (task.status !== 'FAILED') {
      return null;
    }

    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, retry_count = retry_count + 1, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `).bind('PENDING', id).run();

    await this.triggerPhase(id, task.current_phase as TaskPhase);
    return this.getTask(id);
  }

  async triggerPhase(taskId: string, phase: TaskPhase, ghAccountId?: number, aiAccountId?: number, startPhase?: TaskPhase, endPhase?: TaskPhase) {
    console.log('triggerPhase called:', { taskId, phase, ghAccountId, aiAccountId, startPhase, endPhase });
    
    const task = await this.getTask(taskId);
    if (!task) {
      console.error('triggerPhase: Task not found, taskId:', taskId);
      throw new Error('Task not found');
    }

    const accountService = await import('./AccountService');
    let ghAccount: any = ghAccountId ? null : null;
    let aiAccount: any = aiAccountId ? null : null;

    try {
      if (!ghAccountId) {
        ghAccount = await new accountService.AccountService(this.env).selectAvailableGitHubAccount();
        
        if (!ghAccount) {
          console.error('triggerPhase: No available GitHub account');
          throw new Error('No available GitHub account');
        }
        ghAccountId = ghAccount.id;
      }

      const effectiveStartPhase = startPhase || phase;
      const effectiveEndPhase = endPhase || phase;
      const isRangeExecution = effectiveStartPhase !== effectiveEndPhase;

      if (!isRangeExecution) {
        const requiredApiType = phasesRequiringAI[phase];
        if (requiredApiType) {
          if (!aiAccountId && ghAccountId !== undefined) {
            aiAccount = await new accountService.AccountService(this.env).selectAIAccountForGitHub(ghAccountId, requiredApiType);
            if (!aiAccount) {
              console.error('triggerPhase: No available AI account for phase:', phase);
              throw new Error('No available AI account');
            }
            aiAccountId = aiAccount.id;
          }
        }

        await this.env.DB.prepare(`
        UPDATE phase_subtasks SET status = 'PENDING', output_path = '', error_msg = '', retry_count = 0, started_at = NULL, completed_at = NULL 
        WHERE task_id = ? AND phase = ? AND id IN (SELECT MAX(id) FROM phase_subtasks WHERE task_id = ? AND phase = ? GROUP BY subtask_index)
      `).bind(taskId, phase, taskId, phase).run();
      
      await this.dispatchGitHubWorkflow(taskId, phase, ghAccountId, aiAccountId);
      } else {
        for (let p of this.getPhaseOrder()) {
          const phaseIndex = this.getPhaseOrder().indexOf(p);
          const startIndex = this.getPhaseOrder().indexOf(effectiveStartPhase as TaskPhase);
          const endIndex = this.getPhaseOrder().indexOf(effectiveEndPhase as TaskPhase);
          if (phaseIndex >= startIndex && phaseIndex <= endIndex) {
            await this.env.DB.prepare(`
              UPDATE phase_subtasks SET status = 'PENDING', output_path = '', error_msg = '', retry_count = 0, started_at = NULL, completed_at = NULL 
              WHERE task_id = ? AND phase = ? AND id IN (SELECT MAX(id) FROM phase_subtasks WHERE task_id = ? AND phase = ? GROUP BY subtask_index)
            `).bind(taskId, p, taskId, p).run();
          }
        }
        
        await this.dispatchRangeWorkflow(taskId, effectiveStartPhase, effectiveEndPhase, ghAccountId as number);
      }
      
      await this.env.DB.prepare(`
        UPDATE tasks SET github_account_id = ?, current_phase = ?, status = ?, start_phase = ?, end_phase = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind(ghAccountId, phase, phaseStatusMap[phase].running, effectiveStartPhase, effectiveEndPhase, taskId).run();

      if (aiAccountId) {
        await this.env.DB.prepare(`
          UPDATE tasks SET ai_account_id = ? WHERE id = ?
        `).bind(aiAccountId, taskId).run();
      }

      const logMsg = isRangeExecution 
        ? `Range execution triggered: ${effectiveStartPhase} to ${effectiveEndPhase}`
        : `Phase ${phase} triggered`;
      await this.logTask(taskId, phase, 'INFO', logMsg);
      console.log('triggerPhase completed successfully:', { taskId, phase, isRangeExecution });
    } catch (error) {
      console.error('triggerPhase: Failed to dispatch workflow:', error);
      const errMsg = (error as Error).message;

      if (aiAccountId) {
        try {
          await new accountService.AccountService(this.env).releaseAIAccount(aiAccountId);
          console.log('triggerPhase: Released AI account', aiAccountId, 'after failure');
        } catch (releaseErr) {
          console.error('triggerPhase: Failed to release AI account:', releaseErr);
        }
      }

      await this.env.DB.prepare(`
        UPDATE tasks SET status = ?, error_msg = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind('FAILED', errMsg, taskId).run();
      await this.logTask(taskId, phase, 'ERROR', `Failed to trigger phase ${phase}: ${errMsg}`);
      throw error;
    }
  }

  async dispatchGitHubWorkflow(taskId: string, phase: TaskPhase, ghAccountId?: number, aiAccountId?: number, startPhase?: TaskPhase, endPhase?: TaskPhase) {
    console.log('dispatchGitHubWorkflow called:', { taskId, phase, ghAccountId, aiAccountId, startPhase, endPhase });
    
    const owner = this.env.GITHUB_REPO_OWNER;
    const repo = this.env.GITHUB_REPO_NAME;
    
    console.log('dispatchGitHubWorkflow: GitHub config:', { owner, repo });
    
    if (!owner || !repo) {
      console.error('dispatchGitHubWorkflow: GitHub repository not configured');
      throw new Error('GitHub repository not configured');
    }

    let ghApiKey = '';
    if (ghAccountId) {
      console.log('dispatchGitHubWorkflow: Fetching GitHub account, id:', ghAccountId);
      const accountResult = await this.env.DB.prepare(`
        SELECT token_encrypted FROM github_accounts WHERE id = ?
      `).bind(ghAccountId).first();

      if (!accountResult) {
        console.error('dispatchGitHubWorkflow: GitHub account not found, id:', ghAccountId);
        throw new Error('GitHub account not found');
      }

      const storedToken = (accountResult as { token_encrypted: string }).token_encrypted;
      
      if (!storedToken) {
        console.error('dispatchGitHubWorkflow: GitHub account token is empty');
        throw new Error('GitHub account token is empty');
      }
      
      if (storedToken.startsWith('ghp_') || storedToken.startsWith('github_pat_')) {
        console.log('dispatchGitHubWorkflow: Token is plaintext, using directly');
        ghApiKey = storedToken;
      } else {
        try {
          ghApiKey = await this.cryptoService.decrypt(storedToken);
          console.log('dispatchGitHubWorkflow: Token decrypted successfully, length:', ghApiKey.length);
        } catch (decryptError) {
          console.log('dispatchGitHubWorkflow: Decryption failed, using stored token as plaintext');
          ghApiKey = storedToken;
        }
      }
      
      if (!ghApiKey) {
        console.error('dispatchGitHubWorkflow: GitHub account token is empty');
        throw new Error('GitHub account token is empty');
      }
    } else {
      console.error('dispatchGitHubWorkflow: ghAccountId is undefined');
      throw new Error('GitHub account ID is undefined');
    }

    const task = await this.getTask(taskId);
    if (!task) {
      console.error('dispatchGitHubWorkflow: Task not found, taskId:', taskId);
      throw new Error('Task not found');
    }

    let aiApiKey = '';
    let aiBaseUrl = '';
    let aiAccountsJson = '';
    
    if (aiAccountId) {
      const aiAccountResult = await this.env.DB.prepare(`
        SELECT api_key_encrypted, base_url FROM ai_accounts WHERE id = ?
      `).bind(aiAccountId).first();

      if (aiAccountResult) {
        const storedKey = (aiAccountResult as { api_key_encrypted: string }).api_key_encrypted;
        if (storedKey) {
          try {
            aiApiKey = await this.cryptoService.decrypt(storedKey);
            console.log('dispatchGitHubWorkflow: AI API key decrypted successfully, length:', aiApiKey.length, 'starts with:', aiApiKey.substring(0, 4));
          } catch (decryptErr) {
            console.error('dispatchGitHubWorkflow: AI API key decryption failed:', (decryptErr as Error).message);
            console.log('dispatchGitHubWorkflow: Stored key length:', storedKey.length, 'starts with:', storedKey.substring(0, 4));
          }
        }
        aiBaseUrl = (aiAccountResult as { base_url: string }).base_url || '';
      }
    }

    const maxConcurrentConfigResult = await this.env.DB.prepare(`
      SELECT value FROM system_config WHERE key = 'max_concurrent_jobs_per_github_account'
    `).first();
    const maxConcurrent = maxConcurrentConfigResult ? parseInt((maxConcurrentConfigResult as { value: string }).value) : 2;

    const requiredApiType = phasesRequiringAI[phase];
    if (requiredApiType) {
      const result = await this.getDecryptedAIAccounts(requiredApiType, maxConcurrent, ghAccountId);
      aiAccountsJson = result.aiAccountsJson;
    }

    const eventType = phase.toLowerCase().replace(/_/g, '-');
    const payload = {
      event_type: `video-processing-${eventType}`,
      client_payload: {
        task_id: taskId,
        phase: phase,
        start_phase: startPhase || phase,
        end_phase: endPhase || phase,
        gh_account_id: ghAccountId,
        ai_api_key: aiApiKey,
        ai_base_url: aiBaseUrl,
        ai_accounts: aiAccountsJson,
        config: JSON.stringify({
          video_path: task.video_path,
          fps: task.fps,
          prompt: task.prompt,
          output_fps: task.output_fps,
          max_concurrent: maxConcurrent,
          analyze_dialogue_language: task.analyze_dialogue_language || '',
          analyze_dialogue_style: task.analyze_dialogue_style || '',
        }),
      },
    };

    console.log('dispatchGitHubWorkflow: owner:', JSON.stringify(owner), 'repo:', JSON.stringify(repo));

    const authHeader = ghApiKey.startsWith('ghp_')
      ? `token ${ghApiKey}`
      : `Bearer ${ghApiKey}`;

    const githubUrl = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
    console.log('dispatchGitHubWorkflow: Full URL:', githubUrl);
    console.log('dispatchGitHubWorkflow: event_type:', payload.event_type);

    const payloadStr = JSON.stringify(payload);
    console.log('dispatchGitHubWorkflow: payload size:', payloadStr.length, 'bytes');
    console.log('dispatchGitHubWorkflow: client_payload field count:', Object.keys(payload.client_payload).length);
    console.log('dispatchGitHubWorkflow: ai_api_key length:', aiApiKey.length, 'ai_base_url length:', aiBaseUrl.length);
    console.log('dispatchGitHubWorkflow: ai_accounts length:', aiAccountsJson.length);
    
    const response = await fetch(githubUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'User-Agent': 'AI-Video-Processor',
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    console.log('dispatchGitHubWorkflow: Response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('dispatchGitHubWorkflow: GitHub API error:', { status: response.status, errorText });
      throw new Error(`Failed to dispatch workflow: ${response.status} ${errorText}`);
    }

    console.log('dispatchGitHubWorkflow: GitHub workflow dispatched successfully for task', taskId);
    console.log('dispatchGitHubWorkflow: event_type sent:', eventType);
  }

  async dispatchRangeWorkflow(taskId: string, startPhase: TaskPhase, endPhase: TaskPhase, ghAccountId: number) {
    console.log('dispatchRangeWorkflow called:', { taskId, startPhase, endPhase, ghAccountId });
    
    const owner = this.env.GITHUB_REPO_OWNER;
    const repo = this.env.GITHUB_REPO_NAME;
    
    if (!owner || !repo) {
      console.error('dispatchRangeWorkflow: GitHub repository not configured');
      throw new Error('GitHub repository not configured');
    }

    let ghApiKey = '';
    const accountResult = await this.env.DB.prepare(`
      SELECT token_encrypted FROM github_accounts WHERE id = ?
    `).bind(ghAccountId).first();

    if (!accountResult) {
      console.error('dispatchRangeWorkflow: GitHub account not found, id:', ghAccountId);
      throw new Error('GitHub account not found');
    }

    const storedToken = (accountResult as { token_encrypted: string }).token_encrypted;
    
    if (!storedToken) {
      console.error('dispatchRangeWorkflow: GitHub account token is empty');
      throw new Error('GitHub account token is empty');
    }
    
    if (storedToken.startsWith('ghp_') || storedToken.startsWith('github_pat_')) {
      console.log('dispatchRangeWorkflow: Token is plaintext, using directly');
      ghApiKey = storedToken;
    } else {
      try {
        ghApiKey = await this.cryptoService.decrypt(storedToken);
        console.log('dispatchRangeWorkflow: Token decrypted successfully, length:', ghApiKey.length);
      } catch (decryptError) {
        console.log('dispatchRangeWorkflow: Decryption failed, using stored token as plaintext');
        ghApiKey = storedToken;
      }
    }

    const task = await this.getTask(taskId);
    if (!task) {
      console.error('dispatchRangeWorkflow: Task not found, taskId:', taskId);
      throw new Error('Task not found');
    }

    const maxConcurrentConfigResult = await this.env.DB.prepare(`
      SELECT value FROM system_config WHERE key = 'max_concurrent_jobs_per_github_account'
    `).first();
    const maxConcurrent = maxConcurrentConfigResult ? parseInt((maxConcurrentConfigResult as { value: string }).value) : 2;

    let aiAccountsJson = '';
    let primaryAiApiKey = '';
    let primaryAiBaseUrl = '';
    
    const startIndex = phaseOrder.indexOf(startPhase);
    const endIndex = phaseOrder.indexOf(endPhase);
    
    const seenApiTypes = new Set<string>();
    for (let i = startIndex; i <= endIndex; i++) {
      const currentPhase = phaseOrder[i];
      const requiredApiType = phasesRequiringAI[currentPhase];
      if (requiredApiType && !seenApiTypes.has(requiredApiType)) {
        seenApiTypes.add(requiredApiType);
        const result = await this.getDecryptedAIAccounts(requiredApiType, maxConcurrent, ghAccountId);
        if (result.aiAccountsJson) {
          const newAccounts = JSON.parse(result.aiAccountsJson);
          const existingAccounts = aiAccountsJson ? JSON.parse(aiAccountsJson) : [];
          existingAccounts.push(...newAccounts);
          aiAccountsJson = JSON.stringify(existingAccounts);
        }
        if (!primaryAiApiKey && result.aiApiKey) {
          primaryAiApiKey = result.aiApiKey;
          primaryAiBaseUrl = result.aiBaseUrl || '';
        }
      }
    }

    const payload = {
      event_type: 'video-processing-range',
      client_payload: {
        task_id: taskId,
        start_phase: startPhase,
        end_phase: endPhase,
        gh_account_id: ghAccountId,
        ai_accounts: aiAccountsJson,
        ai_api_key: primaryAiApiKey,
        ai_base_url: primaryAiBaseUrl,
        config: JSON.stringify({
          video_path: task.video_path,
          fps: task.fps,
          prompt: task.prompt,
          output_fps: task.output_fps,
          max_concurrent: maxConcurrent,
          analyze_dialogue_language: task.analyze_dialogue_language || '',
          analyze_dialogue_style: task.analyze_dialogue_style || '',
        }),
      },
    };

    console.log('dispatchRangeWorkflow: owner:', JSON.stringify(owner), 'repo:', JSON.stringify(repo));

    const authHeader = ghApiKey.startsWith('ghp_')
      ? `token ${ghApiKey}`
      : `Bearer ${ghApiKey}`;

    const githubUrl = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
    console.log('dispatchRangeWorkflow: Full URL:', githubUrl);
    console.log('dispatchRangeWorkflow: event_type:', payload.event_type);

    const payloadStr = JSON.stringify(payload);
    console.log('dispatchRangeWorkflow: payload size:', payloadStr.length, 'bytes');
    console.log('dispatchRangeWorkflow: ai_accounts length:', aiAccountsJson.length);
    
    const response = await fetch(githubUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'User-Agent': 'AI-Video-Processor',
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    console.log('dispatchRangeWorkflow: Response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('dispatchRangeWorkflow: GitHub API error:', { status: response.status, errorText });
      throw new Error(`Failed to dispatch range workflow: ${response.status} ${errorText}`);
    }

    console.log('dispatchRangeWorkflow: GitHub range workflow dispatched successfully for task', taskId);
  }

  async updateTaskProgress(body: any) {
    const { task_id: taskId, phase, processed_count: processedCount, total_count: totalCount, failed_count: failedCount, message } = body;

    console.log('updateTaskProgress called:', { taskId, phase, processedCount, totalCount, failedCount, message });

    const taskResult = await this.env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(taskId).first() as any;
    if (taskResult?.status === 'COMPLETED') {
      console.log('updateTaskProgress: Task', taskId, 'is already completed, skipping progress update');
      return { success: true, taskId };
    }

    const phaseIndex = phaseOrder.indexOf(phase as TaskPhase);
    const phasesCount = phaseOrder.length;
    const runningStatus = phaseStatusMap[phase as TaskPhase]?.running || phaseStatusMap[phaseOrder[0]].running;

    // 如果有失败子任务，不覆盖任务状态（保留 FAILED 状态）
    const shouldKeepStatus = failedCount > 0;

    // 只在任务仍在运行时更新进度，避免覆盖 FAILED/CANCELLED 等终止状态
    const terminalStatusClause = "status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')";

    if (totalCount > 0) {
      const phaseProgress = Math.round((processedCount / totalCount) * 100);
      const progress = Math.round(((phaseIndex / phasesCount) * 100) + ((phaseProgress / 100) * (100 / phasesCount)));

      if (shouldKeepStatus) {
        // 只更新进度和帧数，不改变 status
        await this.env.DB.prepare(`
          UPDATE tasks SET progress = ?, current_phase = ?, processed_frames = ?, total_frames = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND ${terminalStatusClause}
        `).bind(progress, phase, processedCount, totalCount, taskId).run();
        console.log('updateTaskProgress: Progress updated for task', taskId, 'phase:', phase, 'progress:', progress, '(status preserved due to failures)');
      } else {
        await this.env.DB.prepare(`
          UPDATE tasks SET progress = ?, current_phase = ?, status = ?, processed_frames = ?, total_frames = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND ${terminalStatusClause}
        `).bind(progress, phase, runningStatus, processedCount, totalCount, taskId).run();
        console.log('updateTaskProgress: Progress updated for task', taskId, 'phase:', phase, 'progress:', progress);
      }
    } else {
      const progress = Math.round((phaseIndex / phasesCount) * 100);

      if (shouldKeepStatus) {
        await this.env.DB.prepare(`
          UPDATE tasks SET progress = ?, current_phase = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND ${terminalStatusClause}
        `).bind(progress, phase, taskId).run();
        console.log('updateTaskProgress: Phase only updated for task', taskId, 'phase:', phase, 'progress:', progress, '(status preserved due to failures)');
      } else {
        await this.env.DB.prepare(`
          UPDATE tasks SET progress = ?, current_phase = ?, status = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND ${terminalStatusClause}
        `).bind(progress, phase, runningStatus, taskId).run();
        console.log('updateTaskProgress: Phase only updated for task', taskId, 'phase:', phase, 'progress:', progress);
      }
    }

    if (failedCount) {
      await this.env.DB.prepare(`
        UPDATE tasks SET failed_frames = ? WHERE id = ?
      `).bind(failedCount, taskId).run();
    }

    if (message) {
      await this.env.DB.prepare(`
        UPDATE tasks SET status_message = ? WHERE id = ?
      `).bind(message, taskId).run();
    }

    return { success: true, taskId };
  }

  async handleTaskComplete(body: any) {
    const { task_id: taskId, phase, data } = body;
    
    console.log('handleTaskComplete called:', { taskId, phase, data });
    
    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, current_phase = ?, progress = 100, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind('COMPLETED', phase || 'COMPOSE', taskId).run();
    
    await this.releaseTaskAIAccount(taskId);
    console.log('handleTaskComplete: Released task AI account');
    
    await this.logTask(taskId, phase, 'INFO', `Task completed: ${JSON.stringify(data)}`);
    console.log('handleTaskComplete: Task marked as completed:', taskId);
    return { success: true, taskId };
  }

  async handleTaskError(body: any) {
    const { task_id: taskId, phase, error } = body;
    
    console.log('handleTaskError called:', { taskId, phase, error });
    
    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, failed_frames = failed_frames + 1, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind('FAILED', taskId).run();
    
    await this.releaseTaskAIAccount(taskId);
    console.log('handleTaskError: Released task AI account');
    
    await this.logTask(taskId, phase, 'ERROR', `Task error: ${error}`);
    console.log('handleTaskError: Task marked as failed:', taskId);
    return { success: true, taskId };
  }

  async handleAccountError(body: any) {
    const { task_id: taskId, account_id: accountId, error_type: errorType, message: errorMsg } = body;
    
    console.log('handleAccountError called:', { taskId, accountId, errorType, errorMsg });
    
    const accountService = new (await import('./AccountService')).AccountService(this.env);
    
    await accountService.markAccountUnhealthy(accountId, errorMsg || errorType);
    await accountService.releaseAIAccount(accountId);
    
    await this.logTask(taskId, 'ACCOUNT', 'WARNING', `AI账户 ${accountId} 标记为不健康: ${errorType} - ${errorMsg}`);
    
    const task = await this.getTask(taskId);
    if (task && task.github_account_id) {
      const requiredApiType = phasesRequiringAI[task.current_phase as TaskPhase];
      const newAccount = await accountService.selectAIAccountForGitHub(task.github_account_id, requiredApiType);
      
      if (newAccount) {
        await this.env.DB.prepare(`
          UPDATE tasks SET ai_account_id = ? WHERE id = ?
        `).bind(newAccount.id, taskId).run();
        
        console.log('handleAccountError: Replaced AI account', accountId, 'with', newAccount.id);
        await this.logTask(taskId, 'ACCOUNT', 'INFO', `AI账户已更换: ${accountId} → ${newAccount.id}`);
        
        return { success: true, new_account: newAccount };
      }
    }
    
    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, error_msg = ? WHERE id = ?
    `).bind('FAILED', `AI账户失效且无可用备用账户: ${errorType}`, taskId).run();
    
    await this.logTask(taskId, 'ACCOUNT', 'ERROR', `AI账户失效且无可用备用账户: ${errorType}`);
    
    return { success: false, message: 'No available AI accounts' };
  }

  async handleGitHubCallback(body: any) {
    const { task_id: taskId, phase, status, run_id: runId, start_phase: startPhase, end_phase: endPhase } = body;

    console.log('handleGitHubCallback called:', { taskId, phase, status, runId, startPhase, endPhase });

    const task = await this.getTask(taskId);
    if (task) {
      await this.releaseAllAIAccountCooldowns();
      if (task.github_account_id) {
        await this.env.DB.prepare(`
          UPDATE github_accounts SET monthly_used_minutes = monthly_used_minutes + 1
          WHERE id = ?
        `).bind(task.github_account_id).run();
      }
    }

    await this.env.DB.prepare(`
      UPDATE tasks SET current_run_id = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(runId, taskId).run();

    if (status === 'success') {
      try {
        if (startPhase && endPhase && startPhase !== endPhase) {
          // 范围执行完成（startPhase 和 endPhase 不同），标记任务为完成
          console.log('handleGitHubCallback: Range execution completed, marking task as completed');
          await this.env.DB.prepare(`
            UPDATE tasks SET status = ?, completed_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?
          `).bind('COMPLETED', taskId).run();
          await this.logTask(taskId, phase, 'INFO', `Range execution completed: ${startPhase} to ${endPhase}`);
        } else if (startPhase && endPhase && startPhase === endPhase) {
          // 单阶段执行完成（startPhase 和 endPhase 相同），触发 advancePhase 推进到下一阶段
          console.log('handleGitHubCallback: Single phase execution completed, advancing to next phase');
          await this.advancePhase(taskId);
        } else {
          // startPhase 和 endPhase 都不存在，属于异常情况，记录警告但不触发 advancePhase
          console.warn('handleGitHubCallback: Missing startPhase/endPhase, skipping advancePhase:', { startPhase, endPhase });
          await this.logTask(taskId, phase, 'WARNING', `Missing phase range: start=${startPhase}, end=${endPhase}`);
        }
      } catch (error) {
        console.error('handleGitHubCallback: Failed to process completion:', error);
        await this.env.DB.prepare(`
          UPDATE tasks SET status = ?, error_msg = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
        `).bind('FAILED', (error as Error).message, taskId).run();
      }
    } else {
      await this.env.DB.prepare(`
        UPDATE tasks SET status = ?, failed_frames = failed_frames + 1, error_msg = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind('FAILED', `Phase ${phase} failed in GitHub Actions run ${runId}`, taskId).run();

      await this.logTask(taskId, phase, 'ERROR', `Phase ${phase} failed`);
    }
  }

  async advancePhase(taskId: string) {
    const task = await this.getTask(taskId);
    if (!task) {
      console.log('advancePhase: Task not found, taskId:', taskId);
      return;
    }

    console.log('advancePhase: Current task state:', { taskId, currentPhase: task.current_phase, status: task.status });

    const currentPhase = task.current_phase as TaskPhase || 'DETECT';
    const currentIndex = phaseOrder.indexOf(currentPhase);
    const nextPhase = phaseOrder[currentIndex + 1];

    console.log('advancePhase: Phase transition:', { currentPhase, nextPhase });

    if (!nextPhase) {
      console.log('advancePhase: No next phase found for:', currentPhase);
      if (currentPhase === 'COMPOSE') {
        await this.env.DB.prepare(`
          UPDATE tasks SET status = ?, completed_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
        `).bind('COMPLETED', taskId).run();
        console.log('advancePhase: Task marked as completed:', taskId);
      }
      return;
    }

    const doneStatus = phaseStatusMap[currentPhase].done;
    
    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, current_phase = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(doneStatus, nextPhase, taskId).run();
    console.log('advancePhase: Task status updated to:', { status: doneStatus, currentPhase: nextPhase });

    // 释放本任务上一阶段占用的 AI 账户，确保下一阶段可以正常获取账户
    await this.releaseTaskAIAccount(taskId);

    await this.triggerPhase(taskId, nextPhase);
  }

  async logTask(taskId: string, phase: string, level: string, message: string) {
    await this.env.DB.prepare(`
      INSERT INTO operation_logs (task_id, phase, level, message)
      VALUES (?, ?, ?, ?)
    `).bind(taskId, phase, level, message).run();
  }

  async getTaskLogs(taskId: string) {
    const result = await this.env.DB.prepare(`
      SELECT * FROM operation_logs WHERE task_id = ? ORDER BY created_at DESC
    `).bind(taskId).all();
    return result.results || [];
  }

  async updateProgress(taskId: string, phase: string, processedCount: number, totalCount: number) {
    const phaseIndex = phaseOrder.indexOf(phase as TaskPhase);
    const phasesCount = phaseOrder.length;
    const phaseProgress = totalCount > 0 ? Math.round((processedCount / totalCount) * 100) : 0;
    
    const progress = Math.round(((phaseIndex / phasesCount) * 100) + ((phaseProgress / 100) * (100 / phasesCount)));
    const runningStatus = phaseStatusMap[phase as TaskPhase]?.running || phaseStatusMap[phaseOrder[0]].running;
    
    await this.env.DB.prepare(`
      UPDATE tasks SET progress = ?, current_phase = ?, status = ?, processed_frames = ?, total_frames = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(progress, phase, runningStatus, processedCount, totalCount, taskId).run();
  }

  async getPhaseSubtasks(taskId: string, phase?: string) {
    let query = 'SELECT * FROM phase_subtasks WHERE id IN (SELECT MAX(id) FROM phase_subtasks WHERE task_id = ?';
    const params: (string | number)[] = [taskId];
    
    if (phase) {
      query += ' AND phase = ?';
      params.push(phase);
    }
    
    query += ' GROUP BY phase, subtask_index)';
    
    query += ' ORDER BY phase, subtask_index';
    
    const result = await this.env.DB.prepare(query).bind(...params).all();
    let subtasks = result.results || [];

    const taskResult = await this.env.DB.prepare('SELECT prompt, fps, output_fps FROM tasks WHERE id = ?').bind(taskId).first() as any;
    const taskPrompt = taskResult?.prompt || '';
    const taskFps = taskResult?.fps || 30;
    const taskOutputFps = taskResult?.output_fps || 24;

    // 将 "HH:MM:SS.mmm" 格式的时间字符串解析为秒数
    const parseTimeToSeconds = (timeStr: string): number => {
      if (!timeStr || typeof timeStr !== 'string') return 0;
      const parts = timeStr.split(':');
      const hours = parseInt(parts[0]) || 0;
      const minutes = parseInt(parts[1]) || 0;
      const seconds = parseFloat(parts[2]) || 0;
      return hours * 3600 + minutes * 60 + seconds;
    };

    let shotData: Record<number, { positive_prompt: string; scene_description: string; dialogue: string; video_summary: string; characters: any[]; camera_movement: string; dialogues: any[]; first_keyframe_characters: any[]; last_keyframe_characters: any[]; characters_present: string[]; start_time: number; end_time: number; duration: number }> = {};

    try {
      const r2Obj = await this.env.R2.get(`${taskId}/analysis_result.json`);
      if (r2Obj && r2Obj.body) {
        const jsonStr = await r2Obj.text();
        const analysis = JSON.parse(jsonStr);
        if (analysis.storyboards && Array.isArray(analysis.storyboards)) {
          const videoSummary = analysis.video_summary || '';
          const characters = analysis.characters || [];
          for (let i = 0; i < analysis.storyboards.length; i++) {
            const shot = analysis.storyboards[i];
            const startTime = parseTimeToSeconds(shot.start_time);
            const endTime = parseTimeToSeconds(shot.end_time);
            shotData[i] = {
              positive_prompt: shot.positive_prompt || '',
              scene_description: shot.scene_description || '',
              dialogue: shot.subtitles || shot.dialogue || '',
              video_summary: videoSummary,
              characters: characters,
              camera_movement: shot.camera_movement || '',
              dialogues: shot.dialogues || [],
              first_keyframe_characters: shot.first_keyframe_characters || [],
              last_keyframe_characters: shot.last_keyframe_characters || [],
              characters_present: shot.characters_present || [],
              start_time: startTime,
              end_time: endTime,
              duration: endTime - startTime,
            };
          }
        }
      }
    } catch (e) {
      console.log('Failed to load analysis_result.json from R2:', e);
    }

    if (Object.keys(shotData).length === 0) {
      try {
        const shotsResult = await this.env.DB.prepare('SELECT shot_index, positive_prompt, scene_description, dialogue, start_time, end_time, duration FROM shot_details WHERE task_id = ?').bind(taskId).all();
        for (const row of (shotsResult.results || []) as any[]) {
          shotData[row.shot_index] = {
            positive_prompt: row.positive_prompt || '',
            scene_description: row.scene_description || '',
            dialogue: row.dialogue || '',
            video_summary: '',
            characters: [],
            camera_movement: '',
            dialogues: [],
            first_keyframe_characters: [],
            last_keyframe_characters: [],
            characters_present: [],
            start_time: row.start_time || 0,
            end_time: row.end_time || 0,
            duration: row.duration || 0,
          };
        }
      } catch (e) {
        console.log('Failed to load shot_details from DB:', e);
      }
    }

    if (phase === 'GENERATE_SHOTS' && subtasks.length === 0 && Object.keys(shotData).length > 0) {
      for (const shotIndexStr of Object.keys(shotData)) {
        const shotIndex = parseInt(shotIndexStr);
        const sd = shotData[shotIndex];
        
        const characterDescriptions: string[] = [];
        const charMap: Record<string, any> = {};
        if (sd.characters && Array.isArray(sd.characters)) {
          for (const c of sd.characters) {
            charMap[c.role_id] = c;
          }
        }

        const firstPositions: Record<string, { x: number; y: number }> = {};
        const lastPositions: Record<string, { x: number; y: number }> = {};
        if (sd.first_keyframe_characters && Array.isArray(sd.first_keyframe_characters)) {
          for (const c of sd.first_keyframe_characters) {
            firstPositions[c.role_id] = { x: c.x ?? 0.5, y: c.y ?? 0.3 };
          }
        }
        if (sd.last_keyframe_characters && Array.isArray(sd.last_keyframe_characters)) {
          for (const c of sd.last_keyframe_characters) {
            lastPositions[c.role_id] = { x: c.x ?? 0.5, y: c.y ?? 0.3 };
          }
        }

        const presentRoles = new Set<string>();
        if (sd.characters_present && Array.isArray(sd.characters_present)) {
          for (const roleId of sd.characters_present) {
            presentRoles.add(roleId);
          }
        }
        if (sd.dialogues && Array.isArray(sd.dialogues)) {
          for (const d of sd.dialogues) {
            if (d.speaker) {
              presentRoles.add(d.speaker);
            }
          }
        }

        for (const roleId of presentRoles) {
          const char = charMap[roleId];
          if (char) {
            const charName = char.name || roleId;
            if (firstPositions[roleId]) {
              const { x, y } = firstPositions[roleId];
              const xDesc = x < 0.3 ? '左侧' : (x > 0.7 ? '右侧' : '中央');
              const yDesc = y < 0.3 ? '上方' : (y > 0.7 ? '下方' : '中间');
              characterDescriptions.push(`${charName}在首帧位于画面${xDesc}${yDesc}`);
            } else if (lastPositions[roleId]) {
              const { x, y } = lastPositions[roleId];
              const xDesc = x < 0.3 ? '左侧' : (x > 0.7 ? '右侧' : '中央');
              const yDesc = y < 0.3 ? '上方' : (y > 0.7 ? '下方' : '中间');
              characterDescriptions.push(`${charName}在尾帧位于画面${xDesc}${yDesc}`);
            } else {
              characterDescriptions.push(charName);
            }
          } else {
            characterDescriptions.push(roleId);
          }
        }

        let subtitlesPart = '';
        if (sd.dialogues && Array.isArray(sd.dialogues) && sd.dialogues.length > 0) {
          const dialogueParts: string[] = [];
          for (const d of sd.dialogues) {
            const speaker = d.speaker || '';
            const text = d.text || '';
            if (speaker && text && speaker !== 'null' && text !== 'null') {
              let speakerName = speaker;
              const charInfo = charMap[speaker];
              if (charInfo && charInfo.name) {
                speakerName = charInfo.name;
              }
              dialogueParts.push(`${speakerName}：${text}`);
            } else if (text && text !== 'null') {
              dialogueParts.push(text);
            }
          }
          if (dialogueParts.length > 0) {
            subtitlesPart = '，' + dialogueParts.join('；');
          }
        }

        const originalPrompt = `场景背景：${sd.video_summary}，本片段是其中的一个分镜。
角色描述：${characterDescriptions.join('；')}
镜头运动：${sd.camera_movement}
场景描述：${sd.scene_description}
人物对话：${subtitlesPart}
关键帧要求：第1张图片为起始帧，第2张图片为结束帧
字幕要求：不要显示任何字幕，如果关键帧含有字幕，在生成片段时要去掉字幕
语言要求：人物对话必须严格按照提供的对话文本生成，包括文本内容、语种。如果对话文本是中文，则使用中文对话；如果对话文本是英文，则使用英文对话。人物必须与对话文本精确匹配，人物的口型必须与对话内容精确匹配。
对话要求：当人物对话为空时不要生成任何对话，也不要有对话的口型。`;
        
        subtasks.push({
          id: null,
          task_id: taskId,
          phase: 'GENERATE_SHOTS',
          subtask_index: shotIndex,
          subtask_type: 'shot',
          status: 'PENDING',
          input_path: '',
          output_path: '',
          ai_account_id: null,
          retry_count: 0,
          max_retries: 3,
          started_at: null,
          completed_at: null,
          error_msg: '',
          metadata: '',
          created_at: '',
          original_prompt: originalPrompt,
        });
      }
      subtasks.sort((a: any, b: any) => (a.subtask_index as number) - (b.subtask_index as number));
    }

    // CONVERT_FRAMES 阶段自动生成缺失的子任务（与 convert-frames.sh 中的编号规则一致）
    // 每个分镜有首帧（偶数索引）和尾帧（奇数索引）两个子任务
    if (phase === 'CONVERT_FRAMES' && Object.keys(shotData).length > 0) {
      // 收集已存在的 subtask_index
      const existingIndices = new Set<number>();
      for (const st of subtasks as any[]) {
        existingIndices.add(st.subtask_index);
      }

      // 检查每个分镜的首帧和尾帧是否存在，缺失则补充
      for (const shotIndexStr of Object.keys(shotData)) {
        const shotIndex = parseInt(shotIndexStr);
        const frameTypes: Array<'first' | 'last'> = ['first', 'last'];
        for (const frameType of frameTypes) {
          const subtaskIndex = shotIndex * 2 + (frameType === 'first' ? 0 : 1);
          if (!existingIndices.has(subtaskIndex)) {
            const inputPath = `${taskId}/shot_frames/shot_${shotIndex}_${frameType}.jpg`;
            const metadata = JSON.stringify({ shot_index: shotIndex, frame_type: frameType });
            subtasks.push({
              id: null,
              task_id: taskId,
              phase: 'CONVERT_FRAMES',
              subtask_index: subtaskIndex,
              subtask_type: `frame_${frameType}`,
              status: 'PENDING',
              input_path: inputPath,
              output_path: '',
              ai_account_id: null,
              retry_count: 0,
              max_retries: 3,
              started_at: null,
              completed_at: null,
              error_msg: '',
              metadata: metadata,
              created_at: '',
              original_prompt: '',
            });
          }
        }
      }
      subtasks.sort((a: any, b: any) => (a.subtask_index as number) - (b.subtask_index as number));
    }

    for (const subtask of subtasks as any[]) {
      if (!subtask.original_prompt) {
        let originalPrompt = '';
        if (subtask.phase === 'CONVERT_FRAMES') {
          originalPrompt = taskPrompt || '修改为美式动画风格，保留原始图片的元素和内容, 只改变风格。';
        } else if (subtask.phase === 'GENERATE_SHOTS') {
          const sd = shotData[subtask.subtask_index];
          if (sd) {
            const characterDescriptions: string[] = [];
            const charMap: Record<string, any> = {};
            if (sd.characters && Array.isArray(sd.characters)) {
              for (const c of sd.characters) {
                charMap[c.role_id] = c;
              }
            }

            const firstPositions: Record<string, { x: number; y: number }> = {};
            const lastPositions: Record<string, { x: number; y: number }> = {};
            if (sd.first_keyframe_characters && Array.isArray(sd.first_keyframe_characters)) {
              for (const c of sd.first_keyframe_characters) {
                firstPositions[c.role_id] = { x: c.x ?? 0.5, y: c.y ?? 0.3 };
              }
            }
            if (sd.last_keyframe_characters && Array.isArray(sd.last_keyframe_characters)) {
              for (const c of sd.last_keyframe_characters) {
                lastPositions[c.role_id] = { x: c.x ?? 0.5, y: c.y ?? 0.3 };
              }
            }

            const presentRoles = new Set<string>();
            if (sd.characters_present && Array.isArray(sd.characters_present)) {
              for (const roleId of sd.characters_present) {
                presentRoles.add(roleId);
              }
            }
            if (sd.dialogues && Array.isArray(sd.dialogues)) {
              for (const d of sd.dialogues) {
                if (d.speaker) {
                  presentRoles.add(d.speaker);
                }
              }
            }

            for (const roleId of presentRoles) {
              const char = charMap[roleId];
              if (char) {
                const charName = char.name || roleId;
                if (firstPositions[roleId]) {
                  const { x, y } = firstPositions[roleId];
                  const xDesc = x < 0.3 ? '左侧' : (x > 0.7 ? '右侧' : '中央');
                  const yDesc = y < 0.3 ? '上方' : (y > 0.7 ? '下方' : '中间');
                  characterDescriptions.push(`${charName}在首帧位于画面${xDesc}${yDesc}`);
                } else if (lastPositions[roleId]) {
                  const { x, y } = lastPositions[roleId];
                  const xDesc = x < 0.3 ? '左侧' : (x > 0.7 ? '右侧' : '中央');
                  const yDesc = y < 0.3 ? '上方' : (y > 0.7 ? '下方' : '中间');
                  characterDescriptions.push(`${charName}在尾帧位于画面${xDesc}${yDesc}`);
                } else {
                  characterDescriptions.push(charName);
                }
              } else {
                characterDescriptions.push(roleId);
              }
            }

            let subtitlesPart = '';
            if (sd.dialogues && Array.isArray(sd.dialogues) && sd.dialogues.length > 0) {
              const dialogueParts: string[] = [];
              for (const d of sd.dialogues) {
                const speaker = d.speaker || '';
                const text = d.text || '';
                if (speaker && text && speaker !== 'null' && text !== 'null') {
                  let speakerName = speaker;
                  const charInfo = charMap[speaker];
                  if (charInfo && charInfo.name) {
                    speakerName = charInfo.name;
                  }
                  dialogueParts.push(`${speakerName}：${text}`);
                } else if (text && text !== 'null') {
                  dialogueParts.push(text);
                }
              }
              if (dialogueParts.length > 0) {
                subtitlesPart = '，' + dialogueParts.join('；');
              }
            }

            originalPrompt = `场景背景：${sd.video_summary}，本片段是其中的一个分镜。
角色描述：${characterDescriptions.join('；')}
镜头运动：${sd.camera_movement}
场景描述：${sd.scene_description}
人物对话：${subtitlesPart}
关键帧要求：第1张图片为起始帧，第2张图片为结束帧
字幕要求：不要显示任何字幕，如果关键帧含有字幕，在生成片段时要去掉字幕
语言要求：人物对话必须严格按照提供的对话文本生成，包括文本内容、语种。如果对话文本是中文，则使用中文对话；如果对话文本是英文，则使用英文对话。人物必须与对话文本精确匹配，人物的口型必须与对话内容精确匹配。
对话要求：当人物对话为空时不要生成任何对话，也不要有对话的口型。`;
          }
        }
        subtask.original_prompt = originalPrompt;
      }
    }

    // 为每个子任务附加分镜时长和帧数信息
    for (const subtask of subtasks as any[]) {
      // CONVERT_FRAMES 阶段每个分镜有首帧、尾帧两个子任务，shot_index = floor(subtask_index / 2)
      // GENERATE_SHOTS 阶段 subtask_index 直接对应 shot_index
      const shotIndex = subtask.phase === 'CONVERT_FRAMES'
        ? Math.floor(subtask.subtask_index / 2)
        : subtask.subtask_index;
      const sd = shotData[shotIndex];
      if (sd) {
        subtask.duration = sd.duration;
        // 视频生成模型要求 num_frames 符合 8n+1 规则（9, 17, 25, 33, ...），最小为 9
        // 此逻辑与 generate-shots.sh 中的计算保持一致
        const targetFrames = Math.floor(sd.duration * taskOutputFps);
        let numFrames: number;
        if (targetFrames < 9) {
          numFrames = 9;
        } else {
          const n = Math.floor((targetFrames - 1) / 8);
          numFrames = n * 8 + 1;
          if (numFrames < 9) {
            numFrames = 9;
          }
        }
        subtask.frames = numFrames;
      } else {
        subtask.duration = 0;
        subtask.frames = 0;
      }
    }

    return subtasks;
  }

  async createPhaseSubtask(taskId: string, phase: string, subtaskIndex: number, subtaskType: string, inputPath?: string, metadata?: string) {
    await this.env.DB.prepare(`
      DELETE FROM phase_subtasks WHERE task_id = ? AND phase = ? AND subtask_index = ?
    `).bind(taskId, phase, subtaskIndex).run();

    await this.env.DB.prepare(`
      INSERT INTO phase_subtasks (task_id, phase, subtask_index, subtask_type, input_path, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(taskId, phase, subtaskIndex, subtaskType, inputPath || '', metadata || '').run();
  }

  async updatePhaseSubtaskStatus(taskId: string, phase: string, subtaskIndex: number, status: string, outputPath?: string, errorMsg?: string) {
    await this.env.DB.prepare(`
      UPDATE phase_subtasks SET status = ?, output_path = ?, error_msg = ?, 
        completed_at = CASE WHEN status = 'COMPLETED' THEN STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE completed_at END,
        started_at = CASE WHEN status = 'PROCESSING' THEN STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE started_at END,
        retry_count = CASE WHEN status = 'FAILED' THEN retry_count + 1 ELSE retry_count END
      WHERE id = (SELECT MAX(id) FROM phase_subtasks WHERE task_id = ? AND phase = ? AND subtask_index = ?)
    `).bind(status, outputPath || '', errorMsg || '', taskId, phase, subtaskIndex).run();

    if (status === 'COMPLETED' || status === 'FAILED') {
      await this.releaseTaskAIAccount(taskId);

      // 检查该任务的当前阶段所有子任务是否都已终止
      // 如果全部完成则推进阶段；如果有失败则标记任务失败
      await this.checkPhaseCompletion(taskId, phase);
    }
  }

  private async releaseTaskAIAccount(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (task?.ai_account_id) {
      const accountService = new (await import('./AccountService')).AccountService(this.env);
      await accountService.releaseAIAccount(task.ai_account_id);
      console.log(`releaseTaskAIAccount: Released AI account ${task.ai_account_id} for task ${taskId}`);
    }
    await this.releaseAllAIAccountCooldowns();
  }

  private async releaseAllAIAccountCooldowns(): Promise<void> {
    await this.env.DB.prepare(`
      UPDATE ai_accounts SET cooldown_until = NULL
      WHERE cooldown_until IS NOT NULL
    `).run();
    console.log('releaseAllAIAccountCooldowns: Released all AI account cooldowns');
  }

  private async checkPhaseCompletion(taskId: string, phase: string) {
    const task = await this.getTask(taskId);
    if (!task) return;

    // 只在任务状态仍为运行中时检查（避免已处理过的场景）
    if (task.status === 'COMPLETED' || task.status === 'FAILED' || task.status === 'CANCELLED') {
      return;
    }

    // 检查是否在范围执行模式中
    // 如果 start_phase !== end_phase，说明是范围执行模式，不应触发 advancePhase
    if (task.start_phase && task.end_phase && task.start_phase !== task.end_phase) {
      console.log(`checkPhaseCompletion: Task ${taskId} is in range execution mode (${task.start_phase} to ${task.end_phase}), skipping advancePhase`);
      return;
    }

    // 查询该任务当前阶段的所有子任务
    const allSubtasks = await this.env.DB.prepare(`
      SELECT status FROM phase_subtasks
      WHERE task_id = ? AND phase = ?
      AND id IN (SELECT MAX(id) FROM phase_subtasks WHERE task_id = ? AND phase = ? GROUP BY subtask_index)
    `).bind(taskId, phase, taskId, phase).all();

    const subtasks = allSubtasks.results as Array<{ status: string }>;
    if (subtasks.length === 0) return;

    const terminalStatuses = new Set(['COMPLETED', 'FAILED']);
    const allTerminal = subtasks.every(s => terminalStatuses.has(s.status));

    if (!allTerminal) {
      return;
    }

    const failedCount = subtasks.filter(s => s.status === 'FAILED').length;
    const completedCount = subtasks.filter(s => s.status === 'COMPLETED').length;

    console.log(`checkPhaseCompletion: All subtasks finished for ${taskId}/${phase}`, {
      total: subtasks.length, completed: completedCount, failed: failedCount
    });

    if (failedCount > 0) {
      // 只要有任何子任务失败，整个阶段就标记为 FAILED
      // 这样前端会显示重试按钮，用户可以手动重试失败的子任务
      await this.env.DB.prepare(`
        UPDATE tasks SET status = ?, failed_frames = ?, error_msg = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind('FAILED', failedCount, `阶段 ${phase} 失败: ${failedCount}/${subtasks.length} 个子任务失败`, taskId).run();
      await this.logTask(taskId, phase, 'ERROR', `Phase ${phase} failed: ${failedCount}/${subtasks.length} subtasks failed`);
      console.log(`checkPhaseCompletion: Task ${taskId} marked as FAILED (${failedCount} failed, ${completedCount} completed)`);
    } else {
      // 所有子任务都成功了，推进到下一阶段
      console.log(`checkPhaseCompletion: Task ${taskId} phase ${phase} all completed, advancing...`);
      await this.advancePhase(taskId);
    }
  }

  async prepareSubtask(taskId: string, phase: string, subtaskIndex: number, customPrompt?: string) {
    const batchResults = await this.env.DB.batch([
      this.env.DB.prepare(`
        SELECT * FROM phase_subtasks WHERE id = (SELECT MAX(id) FROM phase_subtasks WHERE task_id = ? AND phase = ? AND subtask_index = ?)
      `).bind(taskId, phase, subtaskIndex),
      this.env.DB.prepare(`
        SELECT id, github_account_id, video_path, fps, prompt, output_fps FROM tasks WHERE id = ?
      `).bind(taskId),
      this.env.DB.prepare(`
        SELECT value FROM system_config WHERE key = 'max_concurrent_jobs_per_github_account'
      `),
    ]);
    
    const subtaskResult = batchResults[0].results?.[0];
    const taskResult = batchResults[1].results?.[0];
    const maxConcurrentConfigResult = batchResults[2].results?.[0];
    
    if (!subtaskResult) {
      throw new Error('Subtask not found');
    }
    
    if (!taskResult || !(taskResult as any).github_account_id) {
      throw new Error('Task or GitHub account not found');
    }
    
    const subtask = subtaskResult as any;
    const task = taskResult as any;
    const ghAccountId = task.github_account_id;
    const maxConcurrent = maxConcurrentConfigResult ? parseInt((maxConcurrentConfigResult as { value: string }).value) : 2;
    
    await this.updatePhaseSubtaskStatus(taskId, phase, subtaskIndex, 'PROCESSING');
    
    let aiAccountsJson = '';
    let aiApiKey = '';
    let aiBaseUrl = '';
    
    const requiredApiType = phasesRequiringAI[phase as TaskPhase];
    if (requiredApiType) {
      const result = await this.getDecryptedAIAccounts(requiredApiType, maxConcurrent, ghAccountId);
      aiAccountsJson = result.aiAccountsJson;
      aiApiKey = result.aiApiKey;
      aiBaseUrl = result.aiBaseUrl;
    }
    
    const ghAccountResult = await this.env.DB.prepare(`
      SELECT token_encrypted FROM github_accounts WHERE id = ?
    `).bind(ghAccountId).first();
    
    if (!ghAccountResult) {
      throw new Error('GitHub account not found');
    }
    
    const storedToken = (ghAccountResult as { token_encrypted: string }).token_encrypted;
    let ghApiKey = storedToken;
    if (!storedToken.startsWith('ghp_') && !storedToken.startsWith('github_pat_')) {
      try {
        ghApiKey = await this.cryptoService.decrypt(storedToken);
      } catch {
        ghApiKey = storedToken;
      }
    }
    
    const authHeader = ghApiKey.startsWith('ghp_')
      ? `token ${ghApiKey}`
      : `Bearer ${ghApiKey}`;
    
    const subtaskData = {
      task_id: taskId,
      phase: phase,
      subtask_index: subtaskIndex,
      gh_account_id: ghAccountId,
      ai_api_key: aiApiKey,
      ai_base_url: aiBaseUrl,
      ai_accounts: aiAccountsJson,
      config: JSON.stringify({
        video_path: task.video_path,
        fps: task.fps,
        prompt: task.prompt,
        custom_prompt: customPrompt,
        output_fps: task.output_fps,
        max_concurrent: maxConcurrent,
        subtask_type: subtask.subtask_type,
        input_path: subtask.input_path,
        metadata: subtask.metadata,
      }),
    };
    
    return {
      githubPayload: {
        event_type: `video-processing-subtask-${phase.toLowerCase().replace(/_/g, '-')}`,
        client_payload: subtaskData,
        auth_header: authHeader,
      },
    };
  }
  
  async dispatchGitHubWorkflowAsync(taskId: string, phase: string, payload: any) {
    try {
      const owner = this.env.GITHUB_REPO_OWNER;
      const repo = this.env.GITHUB_REPO_NAME;
      
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': payload.auth_header,
          'User-Agent': 'AI-Video-Processor',
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          event_type: payload.event_type,
          client_payload: payload.client_payload,
        }),
        redirect: 'follow',
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Failed to dispatch subtask workflow for ${taskId}-${phase}: ${response.status} ${errorText}`);
      } else {
        console.log(`Subtask workflow dispatched successfully for ${taskId}-${phase}`);
      }
    } catch (error) {
      console.error(`Error dispatching subtask workflow for ${taskId}-${phase}:`, error);
    }
  }
  
  async runSubtask(taskId: string, phase: string, subtaskIndex: number, customPrompt?: string) {
    const result = await this.prepareSubtask(taskId, phase, subtaskIndex, customPrompt);
    
    if (result.githubPayload) {
      await this.dispatchGitHubWorkflowAsync(taskId, phase, result.githubPayload);
    }
    
    return { success: true, message: 'Subtask dispatched successfully' };
  }

  async batchRunSubtasks(
    taskId: string,
    subtasks: { phase: string; subtask_index: number }[],
    customPrompts: Record<string, string>
  ) {
    const task = await this.getTask(taskId);
    if (!task || !task.github_account_id) {
      throw new Error('Task or GitHub account not found');
    }

    const ghAccountId = task.github_account_id;

    const validatedSubtasks: Array<{
      phase: string;
      subtask_index: number;
      subtask_type: string;
      input_path: string;
      metadata: string;
      custom_prompt: string;
    }> = [];

    for (const st of subtasks) {
      const subtaskResult = await this.env.DB.prepare(`
        SELECT * FROM phase_subtasks WHERE id = (SELECT MAX(id) FROM phase_subtasks WHERE task_id = ? AND phase = ? AND subtask_index = ?)
      `).bind(taskId, st.phase, st.subtask_index).first();

      if (!subtaskResult) {
        console.warn(`Subtask not found: ${st.phase}-${st.subtask_index}, skipping`);
        continue;
      }

      const subtask = subtaskResult as any;
      const key = `${st.phase}-${st.subtask_index}`;
      const customPrompt = customPrompts[key] || '';

      validatedSubtasks.push({
        phase: st.phase,
        subtask_index: st.subtask_index,
        subtask_type: subtask.subtask_type,
        input_path: subtask.input_path,
        metadata: subtask.metadata,
        custom_prompt: customPrompt,
      });

      await this.updatePhaseSubtaskStatus(taskId, st.phase, st.subtask_index, 'PROCESSING');
    }

    if (validatedSubtasks.length === 0) {
      throw new Error('No valid subtasks found');
    }

    const phases = [...new Set(validatedSubtasks.map((s) => s.phase))];
    const maxPhase = phases.reduce((a, b) => phasesRequiringAI[a as TaskPhase] && !phasesRequiringAI[b as TaskPhase] ? a : b);
    const requiredApiType = phasesRequiringAI[maxPhase as TaskPhase];

    const maxConcurrentConfigResult = await this.env.DB.prepare(`
      SELECT value FROM system_config WHERE key = 'max_concurrent_jobs_per_github_account'
    `).first();
    const maxConcurrent = maxConcurrentConfigResult ? parseInt((maxConcurrentConfigResult as { value: string }).value) : 2;

    let aiApiKey = '';
    let aiBaseUrl = '';
    let aiAccountsJson = '';

    if (requiredApiType) {
      const result = await this.getDecryptedAIAccounts(requiredApiType, maxConcurrent, ghAccountId);
      aiAccountsJson = result.aiAccountsJson;
      aiApiKey = result.aiApiKey;
      aiBaseUrl = result.aiBaseUrl;
    }

    const owner = this.env.GITHUB_REPO_OWNER;
    const repo = this.env.GITHUB_REPO_NAME;

    const ghAccountResult = await this.env.DB.prepare(`
      SELECT token_encrypted FROM github_accounts WHERE id = ?
    `).bind(ghAccountId).first();

    if (!ghAccountResult) {
      throw new Error('GitHub account not found');
    }

    const storedToken = (ghAccountResult as { token_encrypted: string }).token_encrypted;
    let ghApiKey = storedToken;
    if (!storedToken.startsWith('ghp_') && !storedToken.startsWith('github_pat_')) {
      try {
        ghApiKey = await this.cryptoService.decrypt(storedToken);
      } catch {
        ghApiKey = storedToken;
      }
    }

    const authHeader = ghApiKey.startsWith('ghp_')
      ? `token ${ghApiKey}`
      : `Bearer ${ghApiKey}`;

    const subtasksData = JSON.stringify(validatedSubtasks);
    const configData = JSON.stringify({
      video_path: task.video_path,
      fps: task.fps,
      prompt: task.prompt,
      output_fps: task.output_fps,
      max_concurrent: maxConcurrent,
    });

    const payload = {
      event_type: 'video-processing-subtask-batch',
      client_payload: {
        task_id: taskId,
        gh_account_id: ghAccountId,
        subtasks: subtasksData,
        config: configData,
        ai_api_key: aiApiKey,
        ai_base_url: aiBaseUrl,
        ai_accounts: aiAccountsJson,
      },
    };

    console.log('batchRunSubtasks: dispatching batch workflow for', validatedSubtasks.length, 'subtasks');
    console.log('batchRunSubtasks: phases:', phases.join(', '));

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'User-Agent': 'AI-Video-Processor',
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to dispatch batch workflow: ${response.status} ${errorText}`);
    }

    return {
      success: true,
      message: `Batch of ${validatedSubtasks.length} subtasks dispatched successfully`,
      subtasks_count: validatedSubtasks.length,
    };
  }

  private async lockAIAccounts(apiType?: string, limit?: number, ghAccountId?: string): Promise<any[]> {
    const lockTime = new Date(Date.now() + 3600 * 1000);
    const typeCondition = apiType ? ' AND ai_accounts.api_type = ?' : '';
    const selectTypeCondition = apiType ? ' AND aa.api_type = ?' : '';
    const params: (string | number)[] = [];

    await this.env.DB.prepare(`
      UPDATE ai_accounts SET cooldown_until = NULL
      WHERE cooldown_until IS NOT NULL AND cooldown_until < DATETIME('now')
    `).run();
    
    const lockQuery = `
      UPDATE ai_accounts
      SET cooldown_until = ?
      WHERE is_active = TRUE 
        AND is_healthy = TRUE
        AND (cooldown_until IS NULL OR cooldown_until < DATETIME('now'))
        ${typeCondition}
        AND EXISTS (
          SELECT 1 FROM github_ai_bindings gab 
          WHERE gab.ai_account_id = ai_accounts.id AND gab.is_active = TRUE
        )
      ORDER BY 
        CASE WHEN ${ghAccountId ? 'EXISTS (SELECT 1 FROM github_ai_bindings gab2 WHERE gab2.ai_account_id = ai_accounts.id AND gab2.github_account_id = ? AND gab2.is_active = TRUE)' : 'FALSE'} THEN 0 ELSE 1 END,
        last_used_at ASC NULLS FIRST,
        total_usage ASC
      LIMIT ?
    `;
    
    params.push(lockTime.toISOString());
    if (apiType) params.push(apiType);
    if (ghAccountId) params.push(ghAccountId);
    params.push(limit || 1);
    
    await this.env.DB.prepare(lockQuery).bind(...params).run();
    
    const selectQuery = `
      SELECT aa.id, aa.api_key_encrypted, aa.base_url, aa.model_name, aa.account_alias, aa.api_type 
      FROM ai_accounts aa
      WHERE is_active = TRUE 
        AND cooldown_until = ?
        ${selectTypeCondition}
    `;
    const selectParams: (string | number)[] = [lockTime.toISOString()];
    if (apiType) selectParams.push(apiType);
    
    const result = await this.env.DB.prepare(selectQuery).bind(...selectParams).all();
    return result.results || [];
  }

  private async getDecryptedAIAccounts(apiType: string, maxConcurrent: number, ghAccountId: number): Promise<{
    aiAccountsJson: string;
    aiApiKey: string;
    aiBaseUrl: string;
  }> {
    const lockedAccounts = await this.lockAIAccounts(apiType, maxConcurrent, ghAccountId !== undefined ? String(ghAccountId) : undefined);
    if (lockedAccounts.length === 0) {
      return { aiAccountsJson: '', aiApiKey: '', aiBaseUrl: '' };
    }
    const decryptedAccounts = await Promise.all(
      (lockedAccounts as any[]).map(async (acc) => {
        let decryptedKey = '';
        if (acc.api_key_encrypted) {
          try {
            decryptedKey = await this.cryptoService.decrypt(acc.api_key_encrypted);
          } catch (decryptErr) {
            console.error('getDecryptedAIAccounts: Failed to decrypt API key for account', acc.id || acc.account_alias, ':', (decryptErr as Error).message);
          }
        }
        return {
          ...acc,
          api_key_encrypted: decryptedKey,
          base_url: (acc.base_url || '').trim(),
          model_name: (acc.model_name || '').trim()
        };
      })
    );
    return {
      aiAccountsJson: JSON.stringify(decryptedAccounts),
      aiApiKey: decryptedAccounts[0].api_key_encrypted,
      aiBaseUrl: decryptedAccounts[0].base_url || ''
    };
  }

  private generateUUID(title: string): string {
    const cleanedTitle = title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
    const truncatedTitle = cleanedTitle.slice(0, 50);
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const timestamp = `${year}${month}${day}${hour}${minute}`;
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    return `${truncatedTitle}${timestamp}${randomSuffix}`;
  }

  async cleanupTimedOutSubtasks(timeoutMinutes: number = 60, taskId?: string): Promise<number> {
    let query = `
      UPDATE phase_subtasks
      SET status = 'FAILED',
          error_msg = ?,
          completed_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
          retry_count = retry_count + 1
      WHERE status = 'PROCESSING'
        AND started_at IS NOT NULL
        AND STRFTIME('%s', 'now') - STRFTIME('%s', started_at) > ?
    `;
    const binds: any[] = [`Subtask timed out after ${timeoutMinutes} minutes`, timeoutMinutes * 60];

    if (taskId) {
      query += ` AND task_id = ?`;
      binds.push(taskId);
    }

    query += ` AND id IN (SELECT MAX(id) FROM phase_subtasks WHERE task_id = phase_subtasks.task_id AND phase = phase_subtasks.phase AND subtask_index = phase_subtasks.subtask_index)`;

    const result = await this.env.DB.prepare(query).bind(...binds).run();

    const changedRows = (result as any).changes || 0;
    if (changedRows > 0) {
      console.log(`cleanupTimedOutSubtasks: Marked ${changedRows} subtasks as FAILED due to timeout`);

      await this.env.DB.prepare(`
        UPDATE ai_accounts SET cooldown_until = NULL
        WHERE cooldown_until IS NOT NULL AND cooldown_until < DATETIME('now')
      `).run();
      console.log('cleanupTimedOutSubtasks: Cleared expired AI account locks');
    }

    return changedRows;
  }

  async cleanupStaleSubtasks(taskId?: string): Promise<number> {
    let debugQuery = `SELECT id, task_id, phase, subtask_index, status FROM phase_subtasks WHERE status = 'PROCESSING'`;
    if (taskId) {
      debugQuery += ` AND task_id = ?`;
    }
    const debugResult = await this.env.DB.prepare(debugQuery).bind(...(taskId ? [taskId] : [])).all();
    console.log(`cleanupStaleSubtasks debug: Found ${debugResult.results?.length || 0} PROCESSING subtasks`, JSON.stringify(debugResult.results));

    let query = `
      UPDATE phase_subtasks
      SET status = 'FAILED',
          error_msg = ?,
          completed_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
          retry_count = retry_count + 1
      WHERE status = 'PROCESSING'
    `;
    const binds: any[] = ['Subtask marked as FAILED by manual refresh (stale status)'];

    if (taskId) {
      query += ` AND task_id = ?`;
      binds.push(taskId);
    }

    query += ` AND id IN (SELECT MAX(id) FROM phase_subtasks WHERE 1=1`;
    if (taskId) {
      query += ` AND task_id = ?`;
      binds.push(taskId);
    }
    query += ` GROUP BY phase, subtask_index)`;

    const result = await this.env.DB.prepare(query).bind(...binds).run();

    const changedRows = (result as any).changes || 0;
    console.log(`cleanupStaleSubtasks: Changed ${changedRows} rows`);
    if (changedRows > 0) {
      console.log(`cleanupStaleSubtasks: Marked ${changedRows} subtasks as FAILED by manual refresh`);

      await this.env.DB.prepare(`
        UPDATE ai_accounts SET cooldown_until = NULL
        WHERE cooldown_until IS NOT NULL AND cooldown_until < DATETIME('now')
      `).run();
      console.log('cleanupStaleSubtasks: Cleared expired AI account locks');
    }

    return changedRows;
  }
}
