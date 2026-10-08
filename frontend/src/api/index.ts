import axios from 'axios';

const backendUrl = import.meta.env.VITE_BACKEND_URL || 'https://api.vdpr2.ygtxl.dpdns.org';

const api = axios.create({
  baseURL: `${backendUrl}/api/v1`,
  timeout: 600000,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => {
    if (response.config.responseType === 'blob') {
      return response;
    }
    return response.data;
  },
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('userId');
      localStorage.removeItem('role');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const taskApi = {
  list: (params?: { status?: string; page?: number; limit?: number }) =>
    api.get('/tasks', { params }),
  get: (id: string) => api.get(`/tasks/${id}`),
  create: (data: any) => api.post('/tasks', data),
  update: (id: string, data: any) => api.put(`/tasks/${id}`, data),
  delete: (id: string) => api.delete(`/tasks/${id}`),
  start: (id: string) => api.post(`/tasks/${id}/start`),
  cancel: (id: string) => api.post(`/tasks/${id}/cancel`),
  retry: (id: string) => api.post(`/tasks/${id}/retry`),
  advance: (id: string) => api.post(`/tasks/${id}/advance`),
  restartPhase: (id: string) => api.post(`/tasks/${id}/restart-phase`),
  checkPhase: (id: string, phase: string) => api.get(`/admin/tasks/${id}/check-phase/${phase}`),
  startPhase: (id: string, phase: string, options?: { start_phase?: string; end_phase?: string }) => api.post(`/admin/tasks/${id}/start-phase/${phase}`, options),
  getPhaseOrder: () => api.get('/admin/tasks/phase-order'),
  getSubtasks: (id: string, phase?: string) => api.get(`/admin/tasks/${id}/subtasks`, { params: phase ? { phase } : {} }),
  runSubtask: (id: string, phase: string, index: number, data?: { custom_prompt?: string }) => api.post(`/admin/tasks/${id}/subtasks/${phase}/${index}/run`, data),
  batchRunSubtasks: (id: string, subtasks: { phase: string; subtask_index: number }[], customPrompts: Record<string, string>) =>
    api.post(`/admin/tasks/${id}/subtasks/batch-run`, { subtasks, custom_prompts: customPrompts }),
  createSubtask: (id: string, data: { phase: string; subtask_index: number; subtask_type: string; input_path?: string; metadata?: string }) => api.post(`/admin/tasks/${id}/subtasks`, data),
  cleanupStaleSubtasks: (id: string) => api.post(`/admin/tasks/${id}/subtasks/cleanup-stale`),
};

export const accountApi = {
  listGitHub: () => api.get('/admin/accounts/github'),
  createGitHub: (data: any) => api.post('/admin/accounts/github', data),
  updateGitHub: (id: number, data: any) => api.put(`/admin/accounts/github/${id}`, data),
  deleteGitHub: (id: number) => api.delete(`/admin/accounts/github/${id}`),
  listAI: () => api.get('/admin/accounts/ai'),
  createAI: (data: any) => api.post('/admin/accounts/ai', data),
  updateAI: (id: number, data: any) => api.put(`/admin/accounts/ai/${id}`, data),
  deleteAI: (id: number) => api.delete(`/admin/accounts/ai/${id}`),
  checkAIHealth: (id: number) => api.post(`/admin/accounts/ai/${id}/health`),
  getBindings: (githubId: number) => api.get(`/admin/accounts/github/${githubId}/bindings`),
  createBinding: (githubId: number, data: any) => api.post(`/admin/accounts/github/${githubId}/bindings`, data),
  replaceBinding: (bindingId: number, data: any) => api.put(`/admin/accounts/bindings/${bindingId}/replace`, data),
  updateBinding: (bindingId: number, data: any) => api.put(`/admin/accounts/bindings/${bindingId}`, data),
  deleteBinding: (bindingId: number) => api.delete(`/admin/accounts/bindings/${bindingId}`),
  getUnboundAI: () => api.get('/admin/accounts/ai/unbound'),
};

export const configApi = {
  getAll: () => api.get('/admin/config'),
  get: (key: string) => api.get(`/admin/config/${key}`),
  update: (key: string, value: string) => api.put(`/admin/config/${key}`, { value }),
  create: (data: { key: string; value: string; description?: string }) =>
    api.post('/admin/config', data),
  delete: (key: string) => api.delete(`/admin/config/${key}`),
};

export const metricsApi = {
  getAll: () => api.get('/admin/metrics'),
};

export const fileApi = {
  list: (params?: { prefix?: string; delimiter?: string; cursor?: string }) =>
    api.get('/admin/files', { params }),
  download: async (filename: string, prefix?: string, onProgress?: (progress: number) => void) => {
    const response = await api.get(`/admin/files/download/${filename}`, {
      params: { prefix },
      responseType: 'blob',
      onDownloadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const percent = Math.round((progressEvent.loaded / progressEvent.total) * 100);
          onProgress(percent);
        }
      },
    });
    
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  },
  downloadAsBlob: async (filename: string, prefix?: string) => {
    const response = await api.get(`/admin/files/download/${filename}`, {
      params: { prefix },
      responseType: 'blob',
    });
    return response.data;
  },
  previewUrl: (filename: string, prefix?: string) => {
    const r2PublicUrl = import.meta.env.VITE_R2_PUBLIC_URL || 'https://api.vdpr2.ygtxl.dpdns.org/api/v1/files';
    const key = prefix ? `${prefix.replace(/\/$/, '')}/${filename}` : filename;
    return `${r2PublicUrl}/${encodeURIComponent(key)}`;
  },
  
  checkVersion: async (filename: string, prefix?: string) => {
    const params = new URLSearchParams();
    if (prefix) {
      params.set('prefix', prefix.replace(/\/$/, '') + '/');
    }
    const backendUrl = import.meta.env.VITE_BACKEND_URL || 'https://api.vdpr2.ygtxl.dpdns.org';
    const response = await fetch(`${backendUrl}/api/v1/files/version/${encodeURIComponent(filename)}?${params.toString()}`);
    return response.json();
  },
  listAllFiles: async (prefix: string): Promise<{ key: string; name: string }[]> => {
    const result = await api.get('/admin/files', { params: { prefix, delimiter: '' } });
    const files: { key: string; name: string }[] = [];
    const items = result.data?.files || [];
    for (const item of items) {
      if (item.type === 'file') {
        files.push({ key: item.key, name: item.key.replace(prefix, '') });
      }
    }
    return files;
  },
  delete: (filename: string, prefix?: string, isDirectory?: boolean) => {
    const url = `/admin/files/${filename}`;
    return api.delete(url, { params: { prefix, is_directory: isDirectory } });
  },
  batchDelete: (keys: string[]) =>
    api.post('/admin/files/batch-delete', { keys }),
  upload: (file: File, prefix?: string, onProgress?: (progress: number) => void) => {
    const formData = new FormData();
    formData.append('file', file);
    if (prefix) {
      formData.append('prefix', prefix);
    }
    return api.post('/admin/files/upload', formData, {
      headers: { 'Content-Type': undefined },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const percent = Math.round((progressEvent.loaded / progressEvent.total) * 100);
          onProgress(percent);
        }
      },
    });
  },
  batchUpload: (files: File[], prefix?: string) => {
    const formData = new FormData();
    files.forEach(file => formData.append('files', file));
    if (prefix) {
      formData.append('prefix', prefix);
    }
    return api.post('/admin/files/batch-upload', formData, {
      headers: { 'Content-Type': undefined },
    });
  },
  createFolder: (name: string, prefix?: string) =>
    api.post('/admin/files/create-folder', { name, prefix }),
  multipartInit: (filename: string, prefix?: string) =>
    api.post('/admin/files/multipart/init', { filename, prefix }),
  multipartUpload: (uploadId: string, partNumber: number, key: string, file: Blob) => {
    const formData = new FormData();
    formData.append('uploadId', uploadId);
    formData.append('partNumber', partNumber.toString());
    formData.append('key', key);
    formData.append('file', file);
    return api.post('/admin/files/multipart/upload', formData, {
      headers: { 'Content-Type': undefined },
    });
  },
  multipartComplete: (uploadId: string, key: string) =>
    api.post('/admin/files/multipart/complete', { uploadId, key }),
  multipartAbort: (uploadId: string, key: string) =>
    api.post('/admin/files/multipart/abort', { uploadId, key }),
};

export default api;