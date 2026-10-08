import { Bindings } from '../types/env';
import { GitHubAccount, AIAccount } from '../types';
import { CryptoService } from './CryptoService';

type D1ResultType = {
  success: boolean;
  meta?: {
    changes?: number;
  };
};

export class AccountService {
  private cryptoService: CryptoService;

  constructor(public env: Bindings) {
    this.cryptoService = new CryptoService(env);
  }

  async listGitHubAccounts(): Promise<GitHubAccount[]> {
    const result = await this.env.DB.prepare(`
      SELECT * FROM github_accounts ORDER BY name
    `).all();

    return result.results as unknown as GitHubAccount[];
  }

  async createGitHubAccount(data: any): Promise<GitHubAccount> {
    const encryptedToken = data.token_encrypted 
      ? await this.cryptoService.encrypt(data.token_encrypted) 
      : '';

    const result = await this.env.DB.prepare(`
      INSERT INTO github_accounts (name, username, token_encrypted, monthly_limit)
      VALUES (?, ?, ?, ?)
    `).bind(
      data.name,
      data.username || '',
      encryptedToken,
      data.monthly_limit || 2000
    ).run() as D1ResultType;

    if (!result.success || (result.meta?.changes ?? 0) === 0) {
      throw new Error('Failed to create GitHub account');
    }

    const inserted = await this.env.DB.prepare(`
      SELECT * FROM github_accounts WHERE name = ?
    `).bind(data.name).first();

    if (!inserted) throw new Error('Failed to retrieve created account');
    return inserted as unknown as GitHubAccount;
  }

  async updateGitHubAccount(id: number, data: any): Promise<GitHubAccount | null> {
    const updateFields: string[] = [];
    const params: (string | number | boolean)[] = [];

    if (data.name !== undefined) {
      updateFields.push('name = ?');
      params.push(data.name);
    }
    if (data.username !== undefined) {
      updateFields.push('username = ?');
      params.push(data.username);
    }
    if (data.token_encrypted !== undefined) {
      const encryptedToken = await this.cryptoService.encrypt(data.token_encrypted);
      updateFields.push('token_encrypted = ?');
      params.push(encryptedToken);
    }
    if (data.is_active !== undefined) {
      updateFields.push('is_active = ?');
      params.push(data.is_active);
    }
    if (data.monthly_limit !== undefined) {
      updateFields.push('monthly_limit = ?');
      params.push(data.monthly_limit);
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    await this.env.DB.prepare(`
      UPDATE github_accounts SET ${updateFields.join(', ')} WHERE id = ?
    `).bind(...params).run() as D1ResultType;

    const updated = await this.env.DB.prepare(`
      SELECT * FROM github_accounts WHERE id = ?
    `).bind(id).first();

    return updated ? (updated as unknown as GitHubAccount) : null;
  }

  async deleteGitHubAccount(id: number): Promise<boolean> {
    await this.env.DB.prepare(`DELETE FROM github_ai_bindings WHERE github_account_id = ?`).bind(id).run();
    await this.env.DB.prepare(`DELETE FROM task_queue WHERE github_account_id = ?`).bind(id).run();
    
    const result = await this.env.DB.prepare(`
      DELETE FROM github_accounts WHERE id = ?
    `).bind(id).run() as D1ResultType;

    return result.success && (result.meta?.changes ?? 0) > 0;
  }

  async listAIAccounts(): Promise<AIAccount[]> {
    const result = await this.env.DB.prepare(`
      SELECT * FROM ai_accounts ORDER BY priority_weight DESC, account_alias
    `).all();

    return result.results as unknown as AIAccount[];
  }

  async createAIAccount(data: any): Promise<AIAccount> {
    const encryptedKey = data.api_key_encrypted 
      ? await this.cryptoService.encrypt(data.api_key_encrypted) 
      : '';

    const result = await this.env.DB.prepare(`
      INSERT INTO ai_accounts (
        account_alias, api_type, api_key_encrypted, base_url, model_name, 
        max_concurrent, priority_weight, cooldown_seconds, daily_limit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      data.account_alias,
      data.api_type || 'image',
      encryptedKey,
      data.base_url || 'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image',
      data.model_name || 'stable-diffusion-xl-1024-v1-0',
      data.max_concurrent || 1,
      data.priority_weight || 50,
      data.cooldown_seconds || 0,
      data.daily_limit || 1000
    ).run() as D1ResultType;

    if (!result.success || (result.meta?.changes ?? 0) === 0) {
      throw new Error('Failed to create AI account');
    }

    const inserted = await this.env.DB.prepare(`
      SELECT * FROM ai_accounts WHERE account_alias = ?
    `).bind(data.account_alias).first();

    if (!inserted) throw new Error('Failed to retrieve created account');
    return inserted as unknown as AIAccount;
  }

  async updateAIAccount(id: number, data: any): Promise<AIAccount | null> {
    const updateFields: string[] = [];
    const params: (string | number | boolean)[] = [];

    if (data.account_alias !== undefined) {
      updateFields.push('account_alias = ?');
      params.push(data.account_alias);
    }
    if (data.api_type !== undefined) {
      updateFields.push('api_type = ?');
      params.push(data.api_type);
    }
    if (data.api_key_encrypted !== undefined) {
      const encryptedKey = await this.cryptoService.encrypt(data.api_key_encrypted);
      updateFields.push('api_key_encrypted = ?');
      params.push(encryptedKey);
    }
    if (data.base_url !== undefined) {
      updateFields.push('base_url = ?');
      params.push(data.base_url);
    }
    if (data.model_name !== undefined) {
      updateFields.push('model_name = ?');
      params.push(data.model_name);
    }
    if (data.max_concurrent !== undefined) {
      updateFields.push('max_concurrent = ?');
      params.push(data.max_concurrent);
    }
    if (data.priority_weight !== undefined) {
      updateFields.push('priority_weight = ?');
      params.push(data.priority_weight);
    }
    if (data.cooldown_seconds !== undefined) {
      updateFields.push('cooldown_seconds = ?');
      params.push(data.cooldown_seconds);
    }
    if (data.is_active !== undefined) {
      updateFields.push('is_active = ?');
      params.push(data.is_active);
    }
    if (data.daily_limit !== undefined) {
      updateFields.push('daily_limit = ?');
      params.push(data.daily_limit);
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    await this.env.DB.prepare(`
      UPDATE ai_accounts SET ${updateFields.join(', ')} WHERE id = ?
    `).bind(...params).run();

    const updated = await this.env.DB.prepare(`
      SELECT * FROM ai_accounts WHERE id = ?
    `).bind(id).first();

    return updated ? (updated as unknown as AIAccount) : null;
  }

  async deleteAIAccount(id: number): Promise<boolean> {
    const result = await this.env.DB.prepare(`
      DELETE FROM ai_accounts WHERE id = ?
    `).bind(id).run() as D1ResultType;

    return result.success && (result.meta?.changes ?? 0) > 0;
  }

  async checkAIAccountHealth(id: number): Promise<{ id: number; isHealthy: boolean; message: string }> {
    const account = await this.env.DB.prepare(`
      SELECT * FROM ai_accounts WHERE id = ?
    `).bind(id).first();

    if (!account) {
      throw new Error('AI account not found');
    }

    try {
      const now = new Date();
      
      await this.env.DB.prepare(`
        UPDATE ai_accounts SET is_healthy = ?, health_check_msg = ?, last_health_check = ?
        WHERE id = ?
      `).bind(true, 'Health check passed', now.toISOString(), id).run();

      return { id, isHealthy: true, message: 'Health check passed' };
    } catch (error) {
      await this.env.DB.prepare(`
        UPDATE ai_accounts SET is_healthy = ?, health_check_msg = ?, last_health_check = ?
        WHERE id = ?
      `).bind(false, (error as Error).message, new Date().toISOString(), id).run();

      return { id, isHealthy: false, message: (error as Error).message };
    }
  }

  async selectAvailableGitHubAccount(): Promise<GitHubAccount | null> {
    const configResult = await this.env.DB.prepare(`
      SELECT value FROM system_config WHERE key = 'max_concurrent_jobs_per_github_account'
    `).first();
    const maxConcurrent = configResult ? parseInt((configResult as { value: string }).value) : 2;

    const accounts = await this.env.DB.prepare(`
      SELECT ga.*, 
             (SELECT COUNT(*) FROM tasks t 
              WHERE t.github_account_id = ga.id 
                AND t.status IN ('DETECTING', 'ANALYZING', 'CROPPING_SHOTS', 'CONVERTING_FRAMES', 'GENERATING_SHOTS', 'COMPOSING')) as running_tasks
      FROM github_accounts ga
      WHERE is_active = TRUE 
        AND (is_limited IS NULL OR is_limited = FALSE)
      ORDER BY running_tasks ASC, last_used_at ASC NULLS FIRST, monthly_used_minutes ASC, success_rate DESC
    `).all();

    if (!accounts.results || accounts.results.length === 0) {
      return null;
    }

    const availableAccounts = accounts.results.filter((acc: any) => {
      const runningTasks = parseInt(acc.running_tasks) || 0;
      return runningTasks < maxConcurrent;
    });

    if (availableAccounts.length === 0) {
      return null;
    }

    const selectedAccount = availableAccounts[0] as unknown as GitHubAccount;

    await this.env.DB.prepare(`
      UPDATE github_accounts SET last_used_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), total_jobs = total_jobs + 1
      WHERE id = ?
    `).bind(selectedAccount.id).run();

    return selectedAccount;
  }

  async selectAIAccount(apiType?: string): Promise<AIAccount | null> {
    let query = `
      SELECT aa.*
      FROM ai_accounts aa
      WHERE is_active = TRUE 
        AND (cooldown_until IS NULL OR cooldown_until < DATETIME('now'))
    `;
    const params: (string | number)[] = [];

    if (apiType) {
      query += ' AND api_type = ?';
      params.push(apiType);
    }

    query += ' ORDER BY priority_weight DESC, total_usage ASC';

    const accounts = await this.env.DB.prepare(query).bind(...params).all();

    if (!accounts.results || accounts.results.length === 0) {
      return null;
    }

    const totalWeight = accounts.results.reduce((sum: number, acc: any) => sum + (acc.priority_weight || 0), 0);
    let random = Math.random() * totalWeight;
    let selectedAccount: any = null;

    for (const account of accounts.results) {
      const weight = typeof (account as any).priority_weight === 'number' ? (account as any).priority_weight : 0;
      random -= weight;
      if (random <= 0) {
        selectedAccount = account;
        break;
      }
    }

    if (!selectedAccount) {
      selectedAccount = accounts.results[0];
    }

    const reservationExpiry = new Date(Date.now() + 60 * 1000);

    const result = await this.env.DB.prepare(`
      UPDATE ai_accounts
      SET cooldown_until = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND (cooldown_until IS NULL OR cooldown_until < DATETIME('now'))
    `).bind(reservationExpiry.toISOString(), selectedAccount.id).run() as D1ResultType;

    if (!result.success || (result.meta?.changes ?? 0) === 0) {
      return await this.selectAIAccount();
    }

    return selectedAccount as unknown as AIAccount;
  }

  async releaseAIAccount(accountId: number): Promise<void> {
    await this.env.DB.prepare(`
      UPDATE ai_accounts SET cooldown_until = NULL, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(accountId).run();
  }

  async bindAIAccount(githubAccountId: number, aiAccountId: number, priority: number = 0): Promise<void> {
    const existingBinding = await this.env.DB.prepare(`
      SELECT * FROM github_ai_bindings 
      WHERE ai_account_id = ? AND is_active = TRUE
    `).bind(aiAccountId).first();

    if (existingBinding) {
      throw new Error('AI账户已绑定到其他GitHub账户');
    }

    await this.env.DB.prepare(`
      INSERT INTO github_ai_bindings (github_account_id, ai_account_id, priority)
      VALUES (?, ?, ?)
    `).bind(githubAccountId, aiAccountId, priority).run();
  }

  async unbindAIAccount(bindingId: number): Promise<void> {
    await this.env.DB.prepare(`
      UPDATE github_ai_bindings SET is_active = FALSE, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `).bind(bindingId).run();
  }

  async replaceBoundAIAccount(bindingId: number, newAiAccountId: number): Promise<void> {
    const existingBinding = await this.env.DB.prepare(`
      SELECT * FROM github_ai_bindings 
      WHERE ai_account_id = ? AND is_active = TRUE AND id != ?
    `).bind(newAiAccountId, bindingId).first();

    if (existingBinding) {
      throw new Error('AI账户已绑定到其他GitHub账户');
    }

    await this.env.DB.prepare(`
      UPDATE github_ai_bindings 
      SET ai_account_id = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(newAiAccountId, bindingId).run();
  }

  async updateBinding(bindingId: number, data: { ai_account_id?: number; priority?: number }): Promise<void> {
    const current = await this.env.DB.prepare(`
      SELECT * FROM github_ai_bindings WHERE id = ?
    `).bind(bindingId).first() as any;

    if (!current) {
      throw new Error('绑定不存在');
    }

    // 如果要更换 AI 账户，检查新账户是否已被其他绑定占用
    if (data.ai_account_id !== undefined && data.ai_account_id !== current.ai_account_id) {
      const existingBinding = await this.env.DB.prepare(`
        SELECT * FROM github_ai_bindings 
        WHERE ai_account_id = ? AND is_active = TRUE AND id != ?
      `).bind(data.ai_account_id, bindingId).first();

      if (existingBinding) {
        throw new Error('AI账户已绑定到其他GitHub账户');
      }
    }

    const newAiAccountId = data.ai_account_id !== undefined ? data.ai_account_id : current.ai_account_id;
    const newPriority = data.priority !== undefined ? data.priority : current.priority;

    await this.env.DB.prepare(`
      UPDATE github_ai_bindings 
      SET ai_account_id = ?, priority = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(newAiAccountId, newPriority, bindingId).run();
  }

  async getBoundAIAccounts(githubAccountId: number): Promise<any[]> {
    const result = await this.env.DB.prepare(`
      SELECT gab.*, aa.account_alias, aa.api_type, aa.is_healthy, aa.health_check_msg, aa.daily_usage, aa.daily_limit
      FROM github_ai_bindings gab
      JOIN ai_accounts aa ON gab.ai_account_id = aa.id
      WHERE gab.github_account_id = ? AND gab.is_active = TRUE
      ORDER BY gab.priority ASC
    `).bind(githubAccountId).all();

    return result.results || [];
  }

  async getUnboundAIAccounts(): Promise<any[]> {
    const result = await this.env.DB.prepare(`
      SELECT aa.*
      FROM ai_accounts aa
      LEFT JOIN github_ai_bindings gab ON aa.id = gab.ai_account_id AND gab.is_active = TRUE
      WHERE gab.id IS NULL AND aa.is_active = TRUE
      ORDER BY aa.account_alias
    `).all();

    return result.results || [];
  }

  async selectAIAccountForGitHub(githubAccountId: number, apiType?: string): Promise<AIAccount | null> {
    let typeCondition = '';
    let params: (string | number)[] = [githubAccountId];

    if (apiType) {
      typeCondition = ' AND aa.api_type = ?';
      params.push(apiType);
    }

    const boundAccounts = await this.env.DB.prepare(`
      SELECT aa.*
      FROM ai_accounts aa
      JOIN github_ai_bindings gab ON aa.id = gab.ai_account_id
      WHERE gab.github_account_id = ?
        AND gab.is_active = TRUE
        AND aa.is_active = TRUE
        AND aa.is_healthy = TRUE
        AND aa.daily_usage < aa.daily_limit
        AND (aa.cooldown_until IS NULL OR aa.cooldown_until < DATETIME('now'))
        ${typeCondition}
      ORDER BY aa.last_used_at ASC NULLS FIRST, aa.total_usage ASC, gab.priority ASC
      LIMIT 1
    `).bind(...params).first();

    if (boundAccounts) {
      const reservationExpiry = new Date(Date.now() + 60 * 1000);

      const result = await this.env.DB.prepare(`
        UPDATE ai_accounts
        SET cooldown_until = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND (cooldown_until IS NULL OR cooldown_until < DATETIME('now'))
      `).bind(reservationExpiry.toISOString(), (boundAccounts as any).id).run() as D1ResultType;

      if (result.success && (result.meta?.changes ?? 0) > 0) {
        return boundAccounts as unknown as AIAccount;
      }

      return await this.selectAIAccountForGitHub(githubAccountId, apiType);
    }

    const otherParams: (string | number)[] = [githubAccountId];
    if (apiType) {
      otherParams.push(apiType);
    }

    const otherAccounts = await this.env.DB.prepare(`
      SELECT aa.*
      FROM ai_accounts aa
      JOIN github_ai_bindings gab ON aa.id = gab.ai_account_id
      WHERE gab.github_account_id != ?
        AND gab.is_active = TRUE
        AND aa.is_active = TRUE
        AND aa.is_healthy = TRUE
        AND aa.daily_usage < aa.daily_limit
        AND (aa.cooldown_until IS NULL OR aa.cooldown_until < DATETIME('now'))
        ${typeCondition}
      ORDER BY aa.last_used_at ASC NULLS FIRST, aa.total_usage ASC
      LIMIT 1
    `).bind(...otherParams).first();

    if (otherAccounts) {
      const reservationExpiry = new Date(Date.now() + 60 * 1000);

      const result = await this.env.DB.prepare(`
        UPDATE ai_accounts
        SET cooldown_until = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND (cooldown_until IS NULL OR cooldown_until < DATETIME('now'))
      `).bind(reservationExpiry.toISOString(), (otherAccounts as any).id).run() as D1ResultType;

      if (result.success && (result.meta?.changes ?? 0) > 0) {
        return otherAccounts as unknown as AIAccount;
      }

      return await this.selectAIAccountForGitHub(githubAccountId, apiType);
    }

    return null;
  }

  async markAccountUnhealthy(accountId: number, reason: string): Promise<void> {
    await this.env.DB.prepare(`
      UPDATE ai_accounts 
      SET is_healthy = FALSE, health_check_msg = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(reason, accountId).run();
  }
}