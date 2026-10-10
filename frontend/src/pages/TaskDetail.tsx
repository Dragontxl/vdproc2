import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Card, Descriptions, Tag, Timeline, Button, message, Space, Row, Col, Divider, Alert, Progress, Select, Table, Popconfirm, Input, Modal, Upload, Radio, Form, InputNumber, DatePicker } from 'antd';
import {
  PlayCircleOutlined,
  StopOutlined,
  DeleteOutlined,
  VideoCameraOutlined,
  RotateLeftOutlined,
  PauseCircleOutlined,
  CheckCircleOutlined,
  RocketOutlined,
  ReloadOutlined,
  EyeOutlined,
  CopyOutlined,
  DownloadOutlined,
  UploadOutlined,
  FileImageOutlined,
  SendOutlined,
  FolderOpenOutlined,
} from '@ant-design/icons';
import api, { taskApi, fileApi } from '../api';
import { copyTextToClipboard } from '../utils/clipboard';
import dayjs from 'dayjs';
import 'dayjs/plugin/utc';

const dayjsUtc = (time: string) => dayjs.utc(time).local();
import FileBrowser from './FileBrowser';

const { Option } = Select;

type TaskPhase = 'DETECT' | 'ANALYZE' | 'CROP_SHOTS' | 'CONVERT_FRAMES' | 'GENERATE_SHOTS' | 'COMPOSE';

const normalizeImageFile = async (
  file: File,
  filename: string,
  mimeType: 'image/jpeg' | 'image/png',
): Promise<File> => {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('无法创建图片转换画布');
    }

    if (mimeType === 'image/jpeg') {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(bitmap, 0, 0);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        result => result ? resolve(result) : reject(new Error('图片格式转换失败')),
        mimeType,
        mimeType === 'image/jpeg' ? 0.95 : undefined,
      );
    });
    return new File([blob], filename, { type: mimeType });
  } finally {
    bitmap.close();
  }
};

const phaseConfig: Record<TaskPhase, { label: string; description: string; icon: React.ReactNode }> = {
  DETECT: { label: '镜头检测', description: '使用PySceneDetect检测视频镜头边界', icon: <VideoCameraOutlined /> },
  ANALYZE: { label: '剧情分析', description: '使用Gemini分析剧情并生成分镜详情', icon: <RocketOutlined /> },
  CROP_SHOTS: { label: '分镜裁切', description: '裁切分镜片段并抽取首尾帧', icon: <VideoCameraOutlined /> },
  CONVERT_FRAMES: { label: '首尾帧转化', description: '将首尾帧转化为动画风格', icon: <PlayCircleOutlined /> },
  GENERATE_SHOTS: { label: '分镜生成', description: '生成完整分镜视频片段', icon: <PlayCircleOutlined /> },
  COMPOSE: { label: '视频合成', description: '合成分镜片段为完整视频', icon: <VideoCameraOutlined /> },
};

const statusConfig: Record<string, { color: string; text: string }> = {
  PENDING: { color: 'default', text: '等待中' },
  DETECTING: { color: 'blue', text: '镜头检测中' },
  DETECTED: { color: 'blue', text: '镜头检测完成' },
  ANALYZING: { color: 'purple', text: '剧情分析中' },
  ANALYZED: { color: 'purple', text: '剧情分析完成' },
  CROPPING_SHOTS: { color: 'orange', text: '分镜裁切中' },
  SHOTS_CROPPED: { color: 'orange', text: '分镜裁切完成' },
  CONVERTING_FRAMES: { color: 'red', text: '首尾帧转化中' },
  FRAMES_CONVERTED: { color: 'red', text: '首尾帧转化完成' },
  GENERATING_SHOTS: { color: 'pink', text: '分镜生成中' },
  SHOTS_GENERATED: { color: 'pink', text: '分镜生成完成' },
  COMPOSING: { color: 'yellow', text: '合成中' },
  COMPLETED: { color: 'success', text: '已完成' },
  FAILED: { color: 'error', text: '失败' },
  CANCELLED: { color: 'default', text: '已取消' },
};

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<any>(null);
  const [logs, setLogs] = useState([]);
  const [phaseStatus, setPhaseStatus] = useState<Record<string, { ready: boolean; missing: string[]; available: string[] }>>({});
  const [startPhaseValue, setStartPhaseValue] = useState<TaskPhase>('DETECT');
  const [endPhaseValue, setEndPhaseValue] = useState<TaskPhase>('COMPOSE');
  const [subtasks, setSubtasks] = useState<any[]>([]);
  const [selectedSubtaskPhase, setSelectedSubtaskPhase] = useState<TaskPhase | ''>('');
  const [subtaskLoading, setSubtaskLoading] = useState(false);
  const [customPrompts, setCustomPrompts] = useState<Record<string, string>>({});
  const [selectedSubtaskKeys, setSelectedSubtaskKeys] = useState<React.Key[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  // 上传帧 Modal 相关状态
  const [uploadFrameModalVisible, setUploadFrameModalVisible] = useState(false);
  const [frameType, setFrameType] = useState<'first' | 'last' | 'both'>('both');
  const [selectedFrameFiles, setSelectedFrameFiles] = useState<any[]>([]);
  const [uploadingFrames, setUploadingFrames] = useState(false);
  // 复用模板 Modal 相关状态
  const [reuseModalVisible, setReuseModalVisible] = useState(false);
  const [reuseVideoPickerOpen, setReuseVideoPickerOpen] = useState(false);
  const [reuseForm] = Form.useForm();
  // 跟踪用户手动编辑过的提示词 key，这些 key 的值不会被 original_prompt 覆盖
  const userEditedPromptKeys = useRef<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollPositionRef = useRef({ x: 0, y: 0 });
  // 隐藏的 file input ref，用于上传视频
  const uploadVideoInputRef = useRef<HTMLInputElement>(null);
  // 记录当前操作的子任务索引（用于上传时确定目标路径）
  const currentUploadSubtaskRef = useRef<{ phase: string; index: number } | null>(null);
  // 记录当前上传帧的分镜索引
  const currentUploadFrameIndexRef = useRef<number | null>(null);
  // 隐藏的 file input ref，用于替换原图/生成图
  const replaceFrameInputRef = useRef<HTMLInputElement>(null);
  // 记录当前替换图片的目标（原图/生成图）及子任务索引
  const currentReplaceFrameRef = useRef<{ type: 'original' | 'generated'; subtaskIndex: number } | null>(null);
  
  const subtaskPhases: TaskPhase[] = ['CONVERT_FRAMES', 'GENERATE_SHOTS'];
  const allPhases: TaskPhase[] = ['DETECT', 'ANALYZE', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'];

  useEffect(() => {
    if (id) {
      loadTask(true);
      loadLogs();
    }

    const interval = setInterval(() => {
      if (id) {
        saveScrollPosition();
        loadTask(false);
        loadLogs();
        restoreScrollPosition();
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [id]);

  const saveScrollPosition = () => {
    if (containerRef.current) {
      scrollPositionRef.current = {
        x: containerRef.current.scrollLeft,
        y: containerRef.current.scrollTop,
      };
    } else {
      scrollPositionRef.current = {
        x: window.scrollX,
        y: window.scrollY,
      };
    }
  };

  const restoreScrollPosition = () => {
    setTimeout(() => {
      if (containerRef.current) {
        containerRef.current.scrollLeft = scrollPositionRef.current.x;
        containerRef.current.scrollTop = scrollPositionRef.current.y;
      } else {
        window.scrollTo(scrollPositionRef.current.x, scrollPositionRef.current.y);
      }
    }, 50);
  };

  const loadTask = async (showLoading: boolean = false) => {
    try {
      const result = await taskApi.get(id!);
      const newData = result.data;
      
      setTask((prev: any) => {
        if (!prev) {
          return newData;
        }
        
        const changedFields: string[] = [];
        for (const key of Object.keys(newData)) {
          if (JSON.stringify(prev[key]) !== JSON.stringify(newData[key])) {
            changedFields.push(key);
          }
        }
        
        if (changedFields.length === 0) {
          return prev;
        }
        
        return newData;
      });
    } catch (error) {
      console.error('加载任务详情失败:', error);
    }
  };

  const loadLogs = async () => {
    try {
      const backendUrl = import.meta.env.VITE_BACKEND_URL || 'https://ai-video.ldragon.xyz';
      const response = await fetch(`${backendUrl}/api/v1/admin/tasks/${id}/logs`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
      });
      const result = await response.json();
      setLogs(result.data || []);
    } catch (error) {
      console.error('Failed to load logs:', error);
    }
  };

  const loadSubtasks = async (phase?: TaskPhase) => {
    setSubtaskLoading(true);
    try {
      const result = await taskApi.getSubtasks(id!, phase);
      const list = result.data || [];
      setSubtasks(list);
      if (phase) {
        setSelectedSubtaskPhase(phase);
      }
      // 以每个子任务的 original_prompt 作为自定义提示词框的默认值
      // 每次加载时用最新的 original_prompt 同步，但保留用户手动编辑过的值
      // 这样可以避免 analysis_result.json 更新后提示词与分镜数据错位
      setCustomPrompts((prev) => {
        const next = { ...prev };
        for (const item of list as any[]) {
          const key = `${item.phase}-${item.subtask_index}`;
          // 只更新用户未手动编辑过的 key
          if (!userEditedPromptKeys.current.has(key) && item.original_prompt) {
            next[key] = item.original_prompt;
          }
        }
        return next;
      });
    } catch (error: any) {
      const msg = error.response?.data?.msg || '加载子任务失败';
      message.error(msg);
    } finally {
      setSubtaskLoading(false);
    }
  };

  const handleRefreshSubtasks = async () => {
    setSubtaskLoading(true);
    console.log('handleRefreshSubtasks called, taskId:', id);
    try {
      const cleanupResult: any = await taskApi.cleanupStaleSubtasks(id!);
      console.log('cleanupStaleSubtasks result:', JSON.stringify(cleanupResult, null, 2));
      const cleanedCount = cleanupResult.data?.cleaned_count || 0;
      const cleanupMsg = cleanupResult.msg || '';
      console.log('cleanedCount:', cleanedCount, 'msg:', cleanupMsg);
      if (cleanedCount > 0) {
        message.success(cleanupMsg);
      }
      await loadSubtasks(selectedSubtaskPhase as TaskPhase);
    } catch (error: any) {
      console.error('cleanupStaleSubtasks error:', error);
      const msg = error.response?.data?.msg || '刷新失败';
      message.error(msg);
    } finally {
      setSubtaskLoading(false);
    }
  };

  const handleCopyPrompt = async (record: any) => {
    try {
      const key = `${record.phase}-${record.subtask_index}`;
      // 优先使用用户编辑过的自定义提示词，否则使用子任务的原始提示词
      const promptText = customPrompts[key]?.trim() || record.original_prompt || '';
      if (!promptText) {
        message.warning('当前子任务没有可复制的提示词');
        return;
      }
      await copyTextToClipboard(promptText);
      message.success('提示词已复制到剪贴板');
    } catch (error) {
      console.error('Copy prompt error:', error);
      message.error('复制提示词失败');
    }
  };

  const handleRunSubtask = async (phase: string, index: number) => {
    try {
      const key = `${phase}-${index}`;
      const customPrompt = customPrompts[key]?.trim();
      const body = customPrompt ? { custom_prompt: customPrompt } : undefined;
      await taskApi.runSubtask(id!, phase, index, body);
      message.success('子任务已启动');
      loadSubtasks(selectedSubtaskPhase as TaskPhase);
    } catch (error: any) {
      const msg = error.response?.data?.msg || '启动子任务失败';
      message.error(msg);
    }
  };

  // R2 公开 URL
  const r2PublicUrl = import.meta.env.VITE_R2_PUBLIC_URL || 'https://aivideobucket.ygtxl.dpdns.org';

  // 获取分镜的首帧和尾帧 URL
  const getFrameUrls = (subtaskIndex: number): { firstFrameUrl: string; lastFrameUrl: string } => {
    const firstFrameUrl = `${r2PublicUrl}/${id}/ai_shot_frames/shot_${subtaskIndex}_first.png`;
    const lastFrameUrl = `${r2PublicUrl}/${id}/ai_shot_frames/shot_${subtaskIndex}_last.png`;
    return { firstFrameUrl, lastFrameUrl };
  };

  // 复制帧地址
  const handleCopyFrameUrls = async (subtaskIndex: number) => {
    const { firstFrameUrl, lastFrameUrl } = getFrameUrls(subtaskIndex);
    const text = `${firstFrameUrl}\n${lastFrameUrl}`;
    try {
      await copyTextToClipboard(text);
      message.success('帧地址已复制到剪贴板');
    } catch (error) {
      console.error('Copy frame urls error:', error);
      message.error('复制帧地址失败');
    }
  };

  // 把分镜生成参数同步到云端（R2），运行中的 agnes-video-app 会自动轮询拉取并刷新
  const handleSyncParamsToCloud = async (record: any) => {
    const key = `${record.phase}-${record.subtask_index}`;
    const prompt = customPrompts[key]?.trim() || record.original_prompt || '';
    if (!prompt) {
      message.warning('当前子任务没有提示词，无法发送');
      return;
    }
    const { firstFrameUrl, lastFrameUrl } = getFrameUrls(record.subtask_index);
    const payload = {
      prompt,
      keyframes: [firstFrameUrl, lastFrameUrl],
      num_frames: Number(record.frames) || 0,
      frame_rate: Number(record.output_fps) || Number(task?.output_fps) || 24,
    };

    try {
      await api.put('/admin/shot-config', payload);
      message.success('参数已同步，应用将自动刷新');
    } catch (e) {
      message.error(`参数同步失败：${(e as any)?.response?.data?.msg || '请稍后重试'}`);
    }
  };

  // 图生图（首尾帧转化）默认提示词
  const I2I_DEFAULT_PROMPT = '修改为美式动画风格，保留原始图片的元素和内容, 只改变风格。';

  // 把图生图（首尾帧转化）参数同步到云端（R2），运行中的 agnes-video-app 图生图页自动轮询刷新
  const handleSyncI2IParamsToCloud = async (record: any) => {
    const key = `${record.phase}-${record.subtask_index}`;
    const prompt = customPrompts[key]?.trim() || record.original_prompt?.trim() || I2I_DEFAULT_PROMPT;
    const { originalUrl } = getConvertFramePaths(record.subtask_index);
    const payload = {
      prompt,
      keyframes: [originalUrl],
      width: 1152,
      height: 864,
    };

    try {
      await api.put('/admin/i2i-config', payload);
      message.success('参数已同步，应用将自动刷新');
    } catch (e) {
      message.error(`参数同步失败：${(e as any)?.response?.data?.msg || '请稍后重试'}`);
    }
  };

  // 下载首尾帧（通过后端代理，避免 R2 公开域名 CORS 跨域问题）
  const handleDownloadFrames = async (subtaskIndex: number) => {
    const prefix = `${id}/ai_shot_frames/`;
    const firstName = `shot_${subtaskIndex}_first.png`;
    const lastName = `shot_${subtaskIndex}_last.png`;

    const triggerDownload = (blob: Blob, filename: string) => {
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    };

    try {
      const firstBlob = await fileApi.downloadAsBlob(firstName, prefix);
      triggerDownload(firstBlob, firstName);
    } catch (error: any) {
      console.error('Download first frame error:', error);
      message.error(`首帧下载失败: ${error.response?.data?.msg || error.message || '未知错误'}`);
      return;
    }

    try {
      const lastBlob = await fileApi.downloadAsBlob(lastName, prefix);
      triggerDownload(lastBlob, lastName);
    } catch (error: any) {
      console.error('Download last frame error:', error);
      message.error(`尾帧下载失败: ${error.response?.data?.msg || error.message || '未知错误'}`);
      return;
    }

    message.success('首尾帧下载完成');
  };

  // 下载分镜视频（通过后端代理，避免 R2 公开域名 CORS 跨域问题）
  const handleDownloadShot = async (subtaskIndex: number) => {
    const prefix = `${id}/generated_shots/`;
    const filename = `shot_${subtaskIndex}.mp4`;

    const triggerDownload = (blob: Blob, fname: string) => {
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fname;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    };

    try {
      const blob = await fileApi.downloadAsBlob(filename, prefix);
      triggerDownload(blob, filename);
      message.success('分镜下载完成');
    } catch (error: any) {
      console.error('Download shot error:', error);
      message.error(`下载失败: ${error.response?.data?.msg || error.message || '未知错误'}`);
    }
  };

  // 获取 CONVERT_FRAMES 子任务的原图和生成图路径信息
  // subtask_index 规则: shotIndex * 2 + (首帧=0 / 尾帧=1)
  const getConvertFramePaths = (subtaskIndex: number) => {
    const shotIndex = Math.floor(subtaskIndex / 2);
    const frameType = subtaskIndex % 2 === 0 ? 'first' : 'last';
    const frameLabel = frameType === 'first' ? '首帧' : '尾帧';
    const originalFilename = `shot_${shotIndex}_${frameType}.jpg`;
    const generatedFilename = `shot_${shotIndex}_${frameType}.png`;
    const originalPrefix = `${id}/shot_frames/`;
    const generatedPrefix = `${id}/ai_shot_frames/`;
    const originalUrl = `${r2PublicUrl}/${id}/shot_frames/${originalFilename}`;
    const generatedUrl = `${r2PublicUrl}/${id}/ai_shot_frames/${generatedFilename}`;
    return {
      shotIndex,
      frameType,
      frameLabel,
      originalFilename,
      generatedFilename,
      originalPrefix,
      generatedPrefix,
      originalUrl,
      generatedUrl,
    };
  };

  // 通用下载 Blob 触发器
  const triggerBlobDownload = (blob: Blob, fname: string) => {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fname;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  // 复制原图地址
  const handleCopyOriginalUrl = async (subtaskIndex: number) => {
    const { originalUrl } = getConvertFramePaths(subtaskIndex);
    try {
      await copyTextToClipboard(originalUrl);
      message.success('原图地址已复制到剪贴板');
    } catch (error) {
      console.error('Copy original url error:', error);
      message.error('复制原图地址失败');
    }
  };

  // 获取分镜的 10%~90% 多帧地址（9 张，shot_${shotIndex}_1-1.jpg ~ shot_${shotIndex}_1-9.jpg）
  const getMultiFrameUrls = (subtaskIndex: number): string[] => {
    const shotIndex = Math.floor(subtaskIndex / 2);
    const urls: string[] = [];
    for (let n = 1; n <= 9; n++) {
      urls.push(`${r2PublicUrl}/${id}/shot_frames/shot_${shotIndex}_1-${n}.jpg`);
    }
    return urls;
  };

  // 复制多帧地址（每行一个 url）
  const handleCopyMultiFrameUrls = async (subtaskIndex: number) => {
    const urls = getMultiFrameUrls(subtaskIndex);
    const text = urls.join('\n');
    try {
      await copyTextToClipboard(text);
      message.success('多帧地址已复制到剪贴板');
    } catch (error) {
      console.error('Copy multi-frame urls error:', error);
      message.error('复制多帧地址失败');
    }
  };

  // 下载原图
  const handleDownloadOriginalFrame = async (subtaskIndex: number) => {
    const { originalFilename, originalPrefix } = getConvertFramePaths(subtaskIndex);
    try {
      const blob = await fileApi.downloadAsBlob(originalFilename, originalPrefix);
      triggerBlobDownload(blob, originalFilename);
      message.success('原图下载完成');
    } catch (error: any) {
      console.error('Download original frame error:', error);
      message.error(`原图下载失败: ${error.response?.data?.msg || error.message || '未知错误'}`);
    }
  };

  // 下载生成图
  const handleDownloadGeneratedFrame = async (subtaskIndex: number) => {
    const { generatedFilename, generatedPrefix } = getConvertFramePaths(subtaskIndex);
    try {
      const blob = await fileApi.downloadAsBlob(generatedFilename, generatedPrefix);
      triggerBlobDownload(blob, generatedFilename);
      message.success('生成图下载完成');
    } catch (error: any) {
      console.error('Download generated frame error:', error);
      message.error(`生成图下载失败: ${error.response?.data?.msg || error.message || '未知错误'}`);
    }
  };

  // 触发替换原图
  const handleReplaceOriginalClick = (subtaskIndex: number) => {
    currentReplaceFrameRef.current = { type: 'original', subtaskIndex };
    if (replaceFrameInputRef.current) {
      replaceFrameInputRef.current.click();
    }
  };

  // 触发替换生成图
  const handleReplaceGeneratedClick = (subtaskIndex: number) => {
    currentReplaceFrameRef.current = { type: 'generated', subtaskIndex };
    if (replaceFrameInputRef.current) {
      replaceFrameInputRef.current.click();
    }
  };

  // 处理替换图片文件选择（上传的图片重命名为与目标同名）
  const handleReplaceFrameChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0 || !currentReplaceFrameRef.current) return;

    const { type, subtaskIndex } = currentReplaceFrameRef.current;
    const {
      originalFilename,
      generatedFilename,
      frameLabel,
      originalPrefix,
      generatedPrefix,
    } = getConvertFramePaths(subtaskIndex);
    const prefix = type === 'original' ? originalPrefix : generatedPrefix;
    const file = files[0];
    const filename = type === 'original' ? originalFilename : generatedFilename;
    const mimeType = type === 'original' ? 'image/jpeg' : 'image/png';

    try {
      const normalizedFile = await normalizeImageFile(file, filename, mimeType);
      await fileApi.upload(normalizedFile, prefix);
      message.success(`已替换${type === 'original' ? '原图' : '生成图'}（${frameLabel} ${filename}）`);
      loadSubtasks(selectedSubtaskPhase as TaskPhase);
    } catch (error: any) {
      console.error('Replace frame error:', error);
      message.error(`替换失败: ${error.response?.data?.msg || error.message || '未知错误'}`);
    }

    // 清理
    event.target.value = '';
    currentReplaceFrameRef.current = null;
  };

  // 触发上传帧（打开 Modal）
  const handleUploadFramesClick = (phase: string, index: number) => {
    currentUploadFrameIndexRef.current = index;
    setFrameType('both');
    setSelectedFrameFiles([]);
    setUploadFrameModalVisible(true);
  };

  // Modal 中确认上传帧
  const handleConfirmUploadFrames = async () => {
    const index = currentUploadFrameIndexRef.current;
    if (index === null) return;

    const files = selectedFrameFiles;
    if (files.length === 0) {
      message.warning('请选择图片');
      return;
    }
    // 首尾帧模式必须选2张图片（按顺序为首帧、尾帧）；单帧模式只允许1张
    if (frameType === 'both' && files.length !== 2) {
      message.warning('首尾帧模式请选择2张图片（第1张为首帧，第2张为尾帧），或改为单帧模式');
      return;
    }
    if (frameType !== 'both' && files.length !== 1) {
      message.warning('单帧模式仅允许上传1张图片');
      return;
    }

    const prefix = `${id}/ai_shot_frames/`;
    setUploadingFrames(true);

    try {
      if (files.length === 1) {
        // 单张图片，按用户勾选的选项命名
        const suffix = frameType === 'first' ? 'first' : 'last';
        const rawFile = (files[0].originFileObj || files[0]) as File;
        const filename = `shot_${index}_${suffix}.png`;
        const normalizedFile = await normalizeImageFile(rawFile, filename, 'image/png');
        await fileApi.upload(normalizedFile, prefix);
      } else {
        // 两张图片，按顺序命名首帧和尾帧
        await Promise.all(files.map(async (uploadFile, i) => {
          const rawFile = (uploadFile.originFileObj || uploadFile) as File;
          const suffix = i === 0 ? 'first' : 'last';
          const filename = `shot_${index}_${suffix}.png`;
          const normalizedFile = await normalizeImageFile(rawFile, filename, 'image/png');
          await fileApi.upload(normalizedFile, prefix);
        }));
      }
      message.success('上传帧成功');
      setUploadFrameModalVisible(false);
      loadSubtasks(selectedSubtaskPhase as TaskPhase);
    } catch (error: any) {
      console.error('Upload frames error:', error);
      message.error('上传帧失败');
    } finally {
      setUploadingFrames(false);
    }
  };

  // 触发上传视频
  const handleUploadVideoClick = (phase: string, index: number) => {
    currentUploadSubtaskRef.current = { phase, index };
    if (uploadVideoInputRef.current) {
      uploadVideoInputRef.current.click();
    }
  };

  // 处理上传视频文件选择（仅允许选1个视频）
  const handleUploadVideoChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0 || !currentUploadSubtaskRef.current) return;

    const { index } = currentUploadSubtaskRef.current;
    const prefix = `${id}/generated_shots/`;
    const file = files[0];
    const ext = file.name.split('.').pop() || 'mp4';
    const filename = `shot_${index}.${ext}`;
    const renamedFile = new File([file], filename, { type: file.type });

    try {
      await fileApi.upload(renamedFile, prefix);
      message.success(`已上传视频 ${filename} 到 ${prefix}`);
      loadSubtasks(selectedSubtaskPhase as TaskPhase);
    } catch (error: any) {
      console.error('Upload video error:', error);
      message.error('上传视频失败');
    }

    // 清理
    event.target.value = '';
    currentUploadSubtaskRef.current = null;
  };

  const handleSubtaskSelect = (keys: React.Key[]) => {
    setSelectedSubtaskKeys(keys);
  };

  const handleBatchRunSubtasks = async () => {
    if (selectedSubtaskKeys.length === 0) {
      message.warning('请先选择要执行的子任务');
      return;
    }

    setBatchRunning(true);
    try {
      const subtaskIds = selectedSubtaskKeys.map((key) => {
        const [phase, index] = String(key).split('-');
        return { phase, subtask_index: parseInt(index) };
      });

      const customPromptsData: Record<string, string> = {};
      for (const [key, value] of Object.entries(customPrompts)) {
        if (value?.trim()) {
          customPromptsData[key] = value.trim();
        }
      }

      await taskApi.batchRunSubtasks(id!, subtaskIds, customPromptsData);
      message.success(`已启动 ${subtaskIds.length} 个子任务的批量执行`);
      setSelectedSubtaskKeys([]);
      loadSubtasks(selectedSubtaskPhase as TaskPhase);
    } catch (error: any) {
      const msg = error.response?.data?.msg || '批量执行失败';
      message.error(msg);
    } finally {
      setBatchRunning(false);
    }
  };

  const handleStart = async () => {
    try {
      await taskApi.start(id!);
      message.success('任务已启动');
      loadTask();
    } catch (error) {
      message.error('启动任务失败');
    }
  };

  const handleCancel = async () => {
    try {
      await taskApi.cancel(id!);
      message.success('任务已取消');
      loadTask();
    } catch (error) {
      message.error('取消任务失败');
    }
  };

  const handleRetry = async () => {
    try {
      await taskApi.retry(id!);
      message.success('任务已重新调度');
      loadTask();
    } catch (error) {
      message.error('重试任务失败');
    }
  };

  const handleRestartPhase = async () => {
    try {
      await taskApi.restartPhase(id!);
      message.success('当前阶段已重新触发');
      loadTask();
    } catch (error) {
      message.error('重新触发阶段失败');
    }
  };

  // 判断是否为视频文件
  const isVideoFile = (name: string) => {
    const ext = name.toLowerCase().split('.').pop();
    return ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv'].includes(ext || '');
  };

  // 打开复用模板 Modal，预填当前任务参数
  const handleReuseTemplateClick = () => {
    reuseForm.setFieldsValue({
      title: task.title,
      videoPath: task.video_path,
      prompt: task.prompt,
      analyzeDialogueLanguage: task.analyze_dialogue_language || undefined,
      analyzeDialogueStyle: task.analyze_dialogue_style || undefined,
      fps: task.fps,
      outputFps: task.output_fps,
      priority: task.priority,
    });
    setReuseModalVisible(true);
  };

  // 确认创建：用（可能修改后的）表单参数新建任务
  const handleReuseConfirm = async () => {
    try {
      const values = await reuseForm.validateFields();
      const isScheduled = values.runMode === 'scheduled';
      const result = await taskApi.create({
        title: values.title,
        video_path: values.videoPath,
        fps: values.fps,
        prompt: values.prompt,
        output_fps: values.outputFps,
        priority: values.priority,
        analyze_dialogue_language: values.analyzeDialogueLanguage || null,
        analyze_dialogue_style: values.analyzeDialogueStyle || null,
        scheduled_at: isScheduled ? dayjs(values.scheduledTime).utc().format('YYYY-MM-DD HH:mm:ss') : undefined,
      });
      message.success(isScheduled ? '任务创建成功，将到达设定时间后自动启动' : '任务创建成功');
      setReuseModalVisible(false);
      const newTaskId = result.data?.id;
      if (newTaskId) {
        window.location.href = `/tasks/${newTaskId}`;
      }
    } catch (error: any) {
      // 表单校验失败时 errorFields 存在，不弹通用错误提示
      if (error?.errorFields) {
        return;
      }
      const msg = error.response?.data?.msg || '创建任务失败';
      message.error(msg);
    }
  };

  const handleDelete = async () => {
    try {
      await taskApi.delete(id!);
      message.success('任务及相关文件已删除');
      window.location.href = '/tasks';
    } catch (error: any) {
      message.error(error.response?.data?.msg || '删除任务失败');
    }
  };

  const checkPhase = async (phase: TaskPhase) => {
    try {
      const result = await taskApi.checkPhase(id!, phase);
      setPhaseStatus(prev => ({ ...prev, [phase]: result.data }));
    } catch (error) {
      message.error('检查素材失败');
    }
  };

  const startPhase = async (phase: TaskPhase, useRange: boolean = false) => {
    try {
      const options = useRange ? { start_phase: startPhaseValue, end_phase: endPhaseValue } : undefined;
      await taskApi.startPhase(id!, phase, options);
      const msg = useRange 
        ? `${phaseConfig[startPhaseValue].label}到${phaseConfig[endPhaseValue].label}启动成功`
        : `${phaseConfig[phase].label}启动成功`;
      message.success(msg);
      loadTask();
    } catch (error: any) {
      const msg = error.response?.data?.msg || '启动阶段失败';
      message.error(msg);
    }
  };

  const getDerivedStatus = (task: any): string => {
    const terminalStatuses = ['COMPLETED', 'FAILED', 'CANCELLED', 'PENDING'];
    if (terminalStatuses.includes(task?.status)) {
      return task.status;
    }
    const phaseStatusMap: Record<string, string> = {
      DETECT: 'DETECTING',
      ANALYZE: 'ANALYZING',
      CROP_SHOTS: 'CROPPING_SHOTS',
      CONVERT_FRAMES: 'CONVERTING_FRAMES',
      GENERATE_SHOTS: 'GENERATING_SHOTS',
      COMPOSE: 'COMPOSING',
    };
    return phaseStatusMap[task?.current_phase] || task?.status || 'PENDING';
  };

  const getStatusTag = (status: string) => {
    const config = statusConfig[status] || { color: 'default', text: status };
    return <Tag color={config.color}>{config.text}</Tag>;
  };

  const getPhaseStatusColor = (phase: TaskPhase) => {
    const derivedStatus = getDerivedStatus(task);
    const currentPhase = task?.current_phase || '';
    
    if (derivedStatus === 'COMPLETED') return 'success';
    if (derivedStatus === 'FAILED') return 'error';
    
    const runningStatus = `${phase}ING`;
    const doneStatus = `${phase}ED`;
    
    if (derivedStatus === runningStatus) return 'processing';
    if (derivedStatus === doneStatus) return 'success';
    
    const phaseOrder: TaskPhase[] = ['DETECT', 'ANALYZE', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'];
    const currentIdx = phaseOrder.indexOf(currentPhase as TaskPhase);
    const phaseIdx = phaseOrder.indexOf(phase);
    
    if (currentIdx > phaseIdx) return 'success';
    if (currentIdx === phaseIdx) return 'processing';
    
    return 'default';
  };

  const isPhaseRunning = () => {
    const runningStatuses = ['DETECTING', 'ANALYZING', 'CROPPING_SHOTS', 'CONVERTING_FRAMES', 'GENERATING_SHOTS', 'COMPOSING'];
    return runningStatuses.includes(getDerivedStatus(task));
  };

  if (!task) {
    return <Card loading />;
  }

  return (
    <div ref={containerRef}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
        <h2>任务详情</h2>
        <div>
          {task.status === 'PENDING' && (
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleStart}>
              启动任务
            </Button>
          )}
          {getDerivedStatus(task) !== 'COMPLETED' && getDerivedStatus(task) !== 'CANCELLED' && (
            <Button icon={<StopOutlined />} onClick={handleCancel} style={{ marginLeft: 8 }}>
              取消任务
            </Button>
          )}
          {getDerivedStatus(task) === 'FAILED' && (
            <Button icon={<RotateLeftOutlined />} onClick={handleRetry} style={{ marginLeft: 8 }}>
              重试任务
            </Button>
          )}
          {isPhaseRunning() && (
            <Button type="primary" icon={<PauseCircleOutlined />} onClick={handleRestartPhase} style={{ marginLeft: 8 }}>
              继续任务
            </Button>
          )}
          <Button icon={<CopyOutlined />} onClick={handleReuseTemplateClick} style={{ marginLeft: 8 }}>
            复用模板
          </Button>
          <Popconfirm
            title="确定删除该任务及其全部 R2 文件吗？"
            onConfirm={handleDelete}
            okText="删除"
            cancelText="取消"
          >
            <Button danger icon={<DeleteOutlined />} style={{ marginLeft: 8 }}>
              删除任务
            </Button>
          </Popconfirm>
        </div>
      </div>

      <Card title="基本信息" style={{ marginBottom: 24 }}>
        {task.status_message && (
          <Alert
            message={task.status_message}
            type={getDerivedStatus(task) === 'FAILED' ? 'error' : 'info'}
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}
        {task.progress > 0 && getDerivedStatus(task) !== 'COMPLETED' && getDerivedStatus(task) !== 'FAILED' && (
          <Progress percent={task.progress} status="active" style={{ marginBottom: 16 }} />
        )}
        <Descriptions bordered column={2}>
          <Descriptions.Item label="任务ID">{task.id}</Descriptions.Item>
          <Descriptions.Item label="标题">{task.title}</Descriptions.Item>
          <Descriptions.Item label="状态">{getStatusTag(getDerivedStatus(task))}</Descriptions.Item>
          <Descriptions.Item label="当前阶段">
            {phaseConfig[task.current_phase as TaskPhase]?.label || task.current_phase || '-'}
          </Descriptions.Item>
          <Descriptions.Item label="视频路径">{task.video_path}</Descriptions.Item>
          <Descriptions.Item label="输出视频">
            {task.final_video_url ? (
              <a href={task.final_video_url} target="_blank" rel="noopener noreferrer">
                <VideoCameraOutlined /> 查看视频
              </a>
            ) : (
              '未生成'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="抽帧帧率">{task.fps} FPS</Descriptions.Item>
          <Descriptions.Item label="输出帧率">{task.output_fps} FPS</Descriptions.Item>
          <Descriptions.Item label="提示词">{task.prompt || '-'}</Descriptions.Item>
          <Descriptions.Item label="优先级">{task.priority}</Descriptions.Item>
          <Descriptions.Item label="总帧数">{task.total_frames}</Descriptions.Item>
          <Descriptions.Item label="已处理">{task.processed_frames}</Descriptions.Item>
          <Descriptions.Item label="失败帧数">{task.failed_frames}</Descriptions.Item>
          <Descriptions.Item label="重试次数">{task.retry_count}/{task.max_retries}</Descriptions.Item>
          <Descriptions.Item label="创建时间">{dayjsUtc(task.created_at).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
          <Descriptions.Item label="计划时间">
            {task.scheduled_at ? (
              <span>{dayjsUtc(task.scheduled_at).format('YYYY-MM-DD HH:mm:ss')}</span>
            ) : (
              '-'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="更新时间">{dayjsUtc(task.updated_at).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
          <Descriptions.Item label="开始时间">{task.started_at ? dayjsUtc(task.started_at).format('YYYY-MM-DD HH:mm:ss') : '-'}</Descriptions.Item>
          <Descriptions.Item label="完成时间">{task.completed_at ? dayjsUtc(task.completed_at).format('YYYY-MM-DD HH:mm:ss') : '-'}</Descriptions.Item>
          <Descriptions.Item label="错误信息" span={2}>{task.error_msg || '-'}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="阶段控制" style={{ marginBottom: 24 }}>
        <div style={{ marginBottom: 16, padding: '12px', background: '#f5f5f5', borderRadius: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontWeight: 'bold' }}>阶段范围执行：</span>
            <Select
              value={startPhaseValue}
              onChange={(value) => setStartPhaseValue(value as TaskPhase)}
              style={{ width: 160 }}
              disabled={isPhaseRunning()}
            >
              {allPhases.map((p) => (
                <Option key={p} value={p}>{phaseConfig[p].label}</Option>
              ))}
            </Select>
            <span>→</span>
            <Select
              value={endPhaseValue}
              onChange={(value) => setEndPhaseValue(value as TaskPhase)}
              style={{ width: 160 }}
              disabled={isPhaseRunning()}
            >
              {allPhases.map((p) => (
                <Option key={p} value={p}>{phaseConfig[p].label}</Option>
              ))}
            </Select>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={() => startPhase(startPhaseValue, true)}
              disabled={isPhaseRunning() || allPhases.indexOf(startPhaseValue) > allPhases.indexOf(endPhaseValue)}
            >
              执行范围
            </Button>
            {allPhases.indexOf(startPhaseValue) > allPhases.indexOf(endPhaseValue) && (
              <span style={{ color: '#ff4d4f', fontSize: '12px' }}>起始阶段不能晚于结束阶段</span>
            )}
          </div>
        </div>
        
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {(['DETECT', 'ANALYZE', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'] as TaskPhase[]).map((phase) => {
            const config = phaseConfig[phase];
            const statusColor = getPhaseStatusColor(phase);
            const phaseState = phaseStatus[phase];

            return (
              <div key={phase} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', border: '1px solid #f0f0f0', borderRadius: '8px' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {statusColor === 'success' && <CheckCircleOutlined style={{ color: '#52c41a' }} />}
                    {statusColor === 'processing' && <PlayCircleOutlined style={{ color: '#1890ff' }} />}
                    <Tag color={statusColor === 'success' ? 'success' : statusColor === 'processing' ? 'blue' : 'default'}>
                      {config.label}
                    </Tag>
                  </div>
                  <div style={{ color: '#999', fontSize: '12px', marginTop: '4px' }}>
                    {config.description}
                  </div>
                  {phaseState && (
                    <div style={{ marginTop: '8px' }}>
                      {phaseState.ready ? (
                        <span style={{ color: '#52c41a', fontSize: '12px' }}>
                          ✓ 素材齐全
                        </span>
                      ) : (
                        <span style={{ color: '#ff4d4f', fontSize: '12px' }}>
                          ✗ 缺少素材: {phaseState.missing.join(', ')}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Button size="small" onClick={() => checkPhase(phase)}>
                    检查素材
                  </Button>
                  <Button
                    type="primary"
                    size="small"
                    onClick={() => startPhase(phase)}
                    disabled={isPhaseRunning()}
                  >
                    单独启动
                  </Button>
                </div>
              </div>
            );
          })}
        </Space>
      </Card>

      <Card title="任务进度">
        <Timeline>
          {(['DETECT', 'ANALYZE', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'] as TaskPhase[]).map((phase) => {
            const config = phaseConfig[phase];
            const derivedStatus = getDerivedStatus(task);
            const currentPhase = task?.current_phase || '';
            
            const phaseOrder: TaskPhase[] = ['DETECT', 'ANALYZE', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'];
            const currentIdx = phaseOrder.indexOf(currentPhase as TaskPhase);
            const phaseIdx = phaseOrder.indexOf(phase);
            
            let isDone = false;
            let isRunning = false;
            
            if (derivedStatus === 'COMPLETED') {
              isDone = true;
            } else if (derivedStatus === `${phase}ED`) {
              isDone = true;
            } else if (derivedStatus === `${phase}ING`) {
              isRunning = true;
            } else if (currentIdx > phaseIdx) {
              isDone = true;
            } else if (currentIdx === phaseIdx) {
              isRunning = true;
            }
            
            const color = isRunning ? 'blue' : isDone ? 'green' : '';
            
            return (
              <Timeline.Item key={phase} color={color}>
                {config.label} {isDone ? '✓' : isRunning ? '处理中...' : ''}
              </Timeline.Item>
            );
          })}
        </Timeline>
      </Card>

      <Card title="操作日志" style={{ marginTop: 24 }}>
        {logs.length === 0 ? (
          <p>暂无日志</p>
        ) : (
          <Timeline>
            {logs.map((log: any) => (
              <Timeline.Item key={log.id} color={log.level === 'ERROR' ? 'red' : log.level === 'WARNING' ? 'orange' : 'blue'}>
                <div>
                  <strong>{log.phase}</strong> - {log.message}
                </div>
                <div style={{ color: '#999', fontSize: '12px' }}>
                  {dayjsUtc(log.created_at).format('YYYY-MM-DD HH:mm:ss')}
                </div>
              </Timeline.Item>
            ))}
          </Timeline>
        )}
      </Card>

      <Card title="子任务管理" style={{ marginTop: 24 }}>
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 'bold' }}>选择阶段查看子任务：</span>
          <Select
            value={selectedSubtaskPhase || undefined}
            onChange={(value) => {
              setSelectedSubtaskPhase(value as TaskPhase);
              setSelectedSubtaskKeys([]);
              if (value) {
                loadSubtasks(value as TaskPhase);
              } else {
                setSubtasks([]);
              }
            }}
            style={{ width: 160 }}
            placeholder="全部阶段"
          >
            {subtaskPhases.map((p) => (
              <Option key={p} value={p}>{phaseConfig[p].label}</Option>
            ))}
          </Select>
          <Button type="primary" onClick={handleRefreshSubtasks} disabled={!selectedSubtaskPhase} loading={subtaskLoading}>
            刷新
          </Button>
          <div style={{ flex: 1 }} />
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleBatchRunSubtasks}
            disabled={selectedSubtaskKeys.length === 0}
            loading={batchRunning}
          >
            批量执行 {selectedSubtaskKeys.length > 0 ? `(${selectedSubtaskKeys.length})` : ''}
          </Button>
        </div>

        {subtasks.length === 0 ? (
          <p>{selectedSubtaskPhase ? '该阶段暂无子任务' : '请选择阶段查看子任务'}</p>
        ) : (
          <Table
            dataSource={subtasks}
            rowKey={(record) => `${record.phase}-${record.subtask_index}`}
            loading={subtaskLoading}
            pagination={{ pageSize: 10 }}
            rowSelection={{
              type: 'checkbox',
              selectedRowKeys: selectedSubtaskKeys,
              onChange: handleSubtaskSelect,
              getCheckboxProps: (record) => ({
                disabled: record.status === 'PROCESSING',
              }),
            }}
          >
            <Table.Column
              title="名称"
              key="name"
              width={140}
              render={(_, record) => {
                const label = phaseConfig[record.phase as TaskPhase]?.label || record.phase;
                let displayIndex = record.subtask_index;
                const duration = record.duration || 0;
                const frames = record.frames || 0;
                const durationStr = duration.toFixed(3) + '秒';
                const framesStr = frames + '帧';
                if (record.phase === 'CONVERT_FRAMES') {
                  displayIndex = Math.floor(record.subtask_index / 2);
                  const frameType = record.subtask_index % 2 === 0 ? '首帧' : '尾帧';
                  return (
                    <div>
                      <Tag color="blue">{label}-{displayIndex}({frameType})</Tag>
                      <div style={{ fontSize: '12px', color: '#999', marginTop: 4 }}>{durationStr}</div>
                      <div style={{ fontSize: '12px', color: '#999' }}>{framesStr}</div>
                    </div>
                  );
                }
                return (
                  <div>
                    <Tag color="blue">{label}-{displayIndex}</Tag>
                    <div style={{ fontSize: '12px', color: '#999', marginTop: 4 }}>{durationStr}</div>
                    <div style={{ fontSize: '12px', color: '#999' }}>{framesStr}</div>
                  </div>
                );
              }}
            />
            <Table.Column
              title="状态"
              dataIndex="status"
              key="status"
              sorter={(a, b) => {
                const order = ['PROCESSING', 'PENDING', 'FAILED', 'COMPLETED'];
                const idxA = order.indexOf(a.status);
                const idxB = order.indexOf(b.status);
                return idxA - idxB;
              }}
              render={(status) => (
                <Tag color={
                  status === 'COMPLETED' ? 'green' :
                  status === 'PROCESSING' ? 'blue' :
                  status === 'FAILED' ? 'red' : 'default'
                }>
                  {status === 'COMPLETED' ? '已完成' :
                   status === 'PROCESSING' ? '处理中' :
                   status === 'FAILED' ? '失败' : '等待中'}
                </Tag>
              )}
            />
            <Table.Column
              title="重试次数"
              dataIndex="retry_count"
              key="retry_count"
              render={(retry, record) => `${retry}/${record.max_retries || 3}`}
            />
            <Table.Column
              title="错误信息"
              dataIndex="error_msg"
              key="error_msg"
              width={200}
              render={(text) => (
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {text || '-'}
                </span>
              )}
            />
            <Table.Column
              title="自定义提示词"
              dataIndex="custom_prompt"
              key="custom_prompt"
              width={650}
              render={(_, record) => {
                const key = `${record.phase}-${record.subtask_index}`;
                return (
                  <Input.TextArea
                    placeholder="输入自定义提示词，留空使用默认"
                    value={customPrompts[key] || ''}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                      userEditedPromptKeys.current.add(key);
                      setCustomPrompts(prev => ({ ...prev, [key]: e.target.value }));
                    }}
                    autoSize={{ minRows: 6, maxRows: 12 }}
                  />
                );
              }}
            />
            <Table.Column
              title="操作"
              key="actions"
              width={140}
              render={(_, record) => {
                const isGenerateShots = record.phase === 'GENERATE_SHOTS';
                const isConvertFrames = record.phase === 'CONVERT_FRAMES';
                return (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => handleCopyPrompt(record)}
                      block
                    >
                      复制提示词
                    </Button>
                    <Button
                      type="primary"
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={() => handleRunSubtask(record.phase, record.subtask_index)}
                      disabled={record.status === 'PROCESSING'}
                      block
                    >
                      {record.status === 'PROCESSING' ? '处理中' : '运行'}
                    </Button>
                    {isGenerateShots && (
                      <>
                        <Button
                          size="small"
                          icon={<SendOutlined />}
                          onClick={() => handleSyncParamsToCloud(record)}
                          block
                        >
                          发送参数
                        </Button>
                        <Button
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={() => handleCopyFrameUrls(record.subtask_index)}
                          block
                        >
                          复制帧地址
                        </Button>
                        <Button
                          size="small"
                          icon={<DownloadOutlined />}
                          onClick={() => handleDownloadFrames(record.subtask_index)}
                          block
                        >
                          下载首尾帧
                        </Button>
                        <Button
                          size="small"
                          icon={<UploadOutlined />}
                          onClick={() => handleUploadFramesClick(record.phase, record.subtask_index)}
                          block
                        >
                          上传帧
                        </Button>
                        <Button
                          size="small"
                          icon={<VideoCameraOutlined />}
                          onClick={() => handleUploadVideoClick(record.phase, record.subtask_index)}
                          block
                        >
                          上传视频
                        </Button>
                        <Button
                          size="small"
                          icon={<DownloadOutlined />}
                          onClick={() => handleDownloadShot(record.subtask_index)}
                          block
                        >
                          下载分镜
                        </Button>
                      </>
                    )}
                    {isConvertFrames && (
                      <>
                        <Button
                          size="small"
                          icon={<SendOutlined />}
                          onClick={() => handleSyncI2IParamsToCloud(record)}
                          block
                        >
                          发送参数
                        </Button>
                        <Button
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={() => handleCopyOriginalUrl(record.subtask_index)}
                          block
                        >
                          复制原图地址
                        </Button>
                        <Button
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={() => handleCopyMultiFrameUrls(record.subtask_index)}
                          block
                        >
                          复制多帧地址
                        </Button>
                        <Button
                          size="small"
                          icon={<DownloadOutlined />}
                          onClick={() => handleDownloadOriginalFrame(record.subtask_index)}
                          block
                        >
                          下载原图
                        </Button>
                        <Button
                          size="small"
                          icon={<DownloadOutlined />}
                          onClick={() => handleDownloadGeneratedFrame(record.subtask_index)}
                          block
                        >
                          下载生成图
                        </Button>
                        <Button
                          size="small"
                          icon={<UploadOutlined />}
                          onClick={() => handleReplaceOriginalClick(record.subtask_index)}
                          block
                        >
                          替换原图
                        </Button>
                        <Button
                          size="small"
                          icon={<UploadOutlined />}
                          onClick={() => handleReplaceGeneratedClick(record.subtask_index)}
                          block
                        >
                          替换生成图
                        </Button>
                      </>
                    )}
                  </Space>
                );
              }}
            />
          </Table>
        )}
      </Card>

      <Card title="文件管理" style={{ marginTop: 24 }}>
        <FileBrowser
          initialPrefix={`${task.id}/`}
          rootPrefix={`${task.id}/`}
          embedded={true}
        />
      </Card>

      {/* 隐藏的 file input，用于上传视频 */}
      <input
        type="file"
        ref={uploadVideoInputRef}
        style={{ display: 'none' }}
        accept="video/*"
        onChange={handleUploadVideoChange}
      />

      {/* 隐藏的 file input，用于替换原图/生成图 */}
      <input
        type="file"
        ref={replaceFrameInputRef}
        style={{ display: 'none' }}
        accept="image/*"
        onChange={handleReplaceFrameChange}
      />

      {/* 上传帧 Modal */}
      <Modal
        title="上传帧"
        open={uploadFrameModalVisible}
        onOk={handleConfirmUploadFrames}
        onCancel={() => setUploadFrameModalVisible(false)}
        confirmLoading={uploadingFrames}
        okText="上传"
        cancelText="取消"
        destroyOnClose
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 8 }}>选择上传类型：</div>
          <Radio.Group
            value={frameType}
            onChange={(e) => {
              setFrameType(e.target.value);
              setSelectedFrameFiles([]);
            }}
          >
            <Radio value="first">首帧</Radio>
            <Radio value="last">尾帧</Radio>
            <Radio value="both">首尾帧</Radio>
          </Radio.Group>
        </div>
        <Upload
          beforeUpload={() => false}
          fileList={selectedFrameFiles}
          onChange={({ fileList }) => {
            const maxCount = frameType === 'both' ? 2 : 1;
            setSelectedFrameFiles(fileList.slice(-maxCount));
          }}
          multiple={frameType === 'both'}
          maxCount={frameType === 'both' ? 2 : 1}
          accept="image/*"
          onRemove={(file) => {
            setSelectedFrameFiles(prev => prev.filter(f => f.uid !== file.uid));
          }}
        >
          <Button icon={<UploadOutlined />}>选择图片</Button>
        </Upload>
        {frameType === 'both' && selectedFrameFiles.length === 1 && (
          <div style={{ marginTop: 8, color: '#faad14', fontSize: 12 }}>
            提示：首尾帧模式需选择2张图片（第1张为首帧，第2张为尾帧）
          </div>
        )}
        {frameType !== 'both' && selectedFrameFiles.length > 0 && (
          <div style={{ marginTop: 8, color: '#1890ff', fontSize: 12 }}>
            将上传为 {frameType === 'first' ? '首帧' : '尾帧'}
          </div>
        )}
      </Modal>

      {/* 复用模板 Modal */}
      <Modal
        title="复用模板新建任务"
        open={reuseModalVisible}
        onOk={handleReuseConfirm}
        onCancel={() => setReuseModalVisible(false)}
        okText="创建"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={reuseForm} layout="vertical">
          <Form.Item name="title" label="任务标题" rules={[{ required: true }]}>
            <Input placeholder="请输入任务标题" />
          </Form.Item>
          <Form.Item name="videoPath" label="视频路径" rules={[{ required: true }]}>
            <Input
              placeholder="R2存储中的视频路径"
              addonAfter={
                <Button type="link" size="small" icon={<FolderOpenOutlined />} onClick={() => setReuseVideoPickerOpen(true)} style={{ padding: '0 4px' }}>
                  选择
                </Button>
              }
            />
          </Form.Item>
          <Form.Item name="prompt" label="提示词">
            <Input.TextArea placeholder="AI生成提示词" rows={3} />
          </Form.Item>
          <Form.Item name="analyzeDialogueLanguage" label="分析阶段-对话语言">
            <Select allowClear placeholder="不设置则由 AI 自行处理">
              <Option value="chinese">中文</Option>
              <Option value="english">英文</Option>
            </Select>
          </Form.Item>
          <Form.Item name="analyzeDialogueStyle" label="分析阶段-对话文风">
            <Select allowClear placeholder="不设置则由 AI 自行处理">
              <Option value="plain">平实朴素</Option>
              <Option value="ornate">华丽典雅</Option>
              <Option value="fresh">清新自然</Option>
              <Option value="solemn">厚重沉稳</Option>
              <Option value="humorous">幽默诙谐</Option>
              <Option value="sharp">犀利尖锐</Option>
              <Option value="gentle">温婉细腻</Option>
              <Option value="restrained">冷峻克制</Option>
            </Select>
          </Form.Item>
          <Form.Item name="runMode" label="运行方式" initialValue="immediate">
            <Radio.Group>
              <Radio value="immediate">立即运行</Radio>
              <Radio value="scheduled">定时运行</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.runMode !== cur.runMode}>
            {({ getFieldValue }) =>
              getFieldValue('runMode') === 'scheduled' ? (
                <Form.Item
                  name="scheduledTime"
                  label="计划启动时间（本地时间）"
                  rules={[
                    { required: true, message: '请选择计划启动时间' },
                    {
                      validator: (_, value) =>
                        !value || dayjs(value).isAfter(dayjs())
                          ? Promise.resolve()
                          : Promise.reject(new Error('计划启动时间必须晚于当前时间')),
                    },
                  ]}
                >
                  <DatePicker
                    showTime={{ format: 'HH:mm:ss' }}
                    format="YYYY-MM-DD HH:mm:ss"
                    placeholder="如 2026-08-26 17:30:00"
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item name="fps" label="抽帧帧率" rules={[{ required: true }]}>
            <InputNumber min={1} max={120} />
          </Form.Item>
          <Form.Item name="outputFps" label="输出帧率" rules={[{ required: true }]}>
            <InputNumber min={1} max={120} />
          </Form.Item>
          <Form.Item name="priority" label="优先级">
            <InputNumber min={0} max={100} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 复用模板-视频选择 Modal */}
      <Modal
        title="从 R2 选择视频文件"
        open={reuseVideoPickerOpen}
        onCancel={() => setReuseVideoPickerOpen(false)}
        footer={null}
        width={900}
        destroyOnClose
      >
        <FileBrowser
          embedded
          selectable
          fileFilter={(file) => isVideoFile(file.name)}
          onSelect={(file) => {
            reuseForm.setFieldValue('videoPath', file.key);
            setReuseVideoPickerOpen(false);
            message.success(`已选择: ${file.key}`);
          }}
        />
      </Modal>
    </div>
  );
}
