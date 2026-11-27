import {
  CellOutput,
  FileEntry,
  KernelCompleteResponse,
  KernelExpandOutputResponse,
  KernelInspectResponse,
  SaturnoConfig,
} from '../types/notebook';

export async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
    ...options,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      detail = data.detail || detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  getConfig: () => apiFetch<SaturnoConfig>('/api/config'),
  updateConfig: (patch: Record<string, any>) =>
    apiFetch<SaturnoConfig>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  browseSystemDirs: (path = '') =>
    apiFetch<{
      current: string;
      parent: string | null;
      home: string;
      directories: { name: string; path: string }[];
    }>(`/api/system/dirs?path=${encodeURIComponent(path)}`),
  switchWorkspace: (path: string) =>
    apiFetch<{
      workspace_root: string;
      listing: { workspace_root: string; current_path: string; items: FileEntry[] };
    }>('/api/workspace', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  listDir: (path = '', recursive = false) =>
    apiFetch<{ workspace_root: string; current_path: string; items: FileEntry[] }>(
      `/api/fs/list?path=${encodeURIComponent(path)}&recursive=${recursive ? 'true' : 'false'}`
    ),
  readNotebook: (path: string) =>
    apiFetch<{
      path: string;
      name: string;
      metadata: Record<string, any>;
      cells: any[];
      modified?: string;
      kernel_status: any;
      variables: any[];
      active_cell_id?: string | null;
      active_execution_count?: number | null;
      active_outputs?: CellOutput[];
      active_elapsed_ms?: number | null;
      active_started_at?: string | null;
    }>(`/api/fs/notebook?path=${encodeURIComponent(path)}`),
  saveNotebook: (path: string, cells: any[], metadata?: Record<string, any>) =>
    apiFetch<{ saved: boolean; path: string; modified: string }>('/api/fs/notebook/save', {
      method: 'POST',
      body: JSON.stringify({ path, cells, metadata }),
    }),
  createNotebook: (folder = '', name?: string) =>
    apiFetch<{
      path: string;
      name: string;
      metadata: Record<string, any>;
      cells: any[];
      modified?: string;
    }>('/api/fs/notebook/create', {
      method: 'POST',
      body: JSON.stringify({ folder, name }),
    }),
  createFolder: (folder: string, name: string) =>
    apiFetch<{ created: boolean; path: string }>('/api/fs/folder/create', {
      method: 'POST',
      body: JSON.stringify({ folder, name }),
    }),
  renameEntry: (old_path: string, new_name: string) =>
    apiFetch<{ old_path: string; new_path: string; name: string }>('/api/fs/rename', {
      method: 'POST',
      body: JSON.stringify({ old_path, new_name }),
    }),
  deleteEntry: (path: string) =>
    apiFetch<{ deleted: boolean; path: string }>(
      `/api/fs/entry?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' }
    ),
  readFile: (path: string) =>
    apiFetch<{ path: string; name: string; content: string; truncated: boolean; modified?: string }>(
      `/api/fs/file?path=${encodeURIComponent(path)}`
    ),
  saveFile: (path: string, content: string) =>
    apiFetch<{ saved: boolean; path: string; modified?: string }>('/api/fs/file/save', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),
  createFile: (folder = '', name = 'script.py') =>
    apiFetch<{ path: string; name: string; content: string; truncated: boolean; modified?: string }>(
      '/api/fs/file/create',
      {
        method: 'POST',
        body: JSON.stringify({ folder, name }),
      }
    ),
  copyEntries: (paths: string[], target_folder = '') =>
    apiFetch<{ copied: string[] }>('/api/fs/copy', {
      method: 'POST',
      body: JSON.stringify({ paths, target_folder }),
    }),
  moveEntries: (paths: string[], target_folder = '') =>
    apiFetch<{ moved: { old_path: string; new_path: string; name: string }[] }>(
      '/api/fs/move',
      {
        method: 'POST',
        body: JSON.stringify({ paths, target_folder }),
      }
    ),
  deleteBatch: (paths: string[]) =>
    apiFetch<{ deleted: string[] }>('/api/fs/delete-batch', {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  listKernels: () =>
    apiFetch<{
      kernels: {
        notebook_path: string;
        status: string;
        python_executable: string;
        variables_count: number;
      }[];
    }>('/api/kernels'),
  startKernel: (notebook_path: string) =>
    apiFetch<{ notebook_path: string; status: string; variables: any[] }>('/api/kernels/start', {
      method: 'POST',
      body: JSON.stringify({ notebook_path }),
    }),
  interruptKernel: (notebook_path: string) =>
    apiFetch('/api/kernels/interrupt', {
      method: 'POST',
      body: JSON.stringify({ notebook_path }),
    }),
  restartKernel: (notebook_path: string) =>
    apiFetch('/api/kernels/restart', {
      method: 'POST',
      body: JSON.stringify({ notebook_path }),
    }),
  shutdownKernel: (notebook_path: string) =>
    apiFetch('/api/kernels/shutdown', {
      method: 'POST',
      body: JSON.stringify({ notebook_path }),
    }),
  completeCode: (
    notebook_path: string,
    code: string,
    cursor_pos: number,
    context_code = '',
    signal?: AbortSignal
  ) =>
    apiFetch<KernelCompleteResponse>('/api/kernels/complete', {
      method: 'POST',
      body: JSON.stringify({ notebook_path, code, cursor_pos, context_code }),
      signal,
    }),
  inspectCode: (
    notebook_path: string,
    code: string,
    cursor_pos: number,
    detail_level = 0,
    context_code = '',
    signal?: AbortSignal
  ) =>
    apiFetch<KernelInspectResponse>('/api/kernels/inspect', {
      method: 'POST',
      body: JSON.stringify({
        notebook_path,
        code,
        cursor_pos,
        detail_level,
        context_code,
      }),
      signal,
    }),
  expandOutput: (
    notebook_path: string,
    execution_count: number | null,
    code = ''
  ) =>
    apiFetch<KernelExpandOutputResponse>('/api/kernels/expand-output', {
      method: 'POST',
      body: JSON.stringify({ notebook_path, execution_count, code }),
    }),
};

type WSListener = (msg: Record<string, any>) => void;

class SaturnoWSClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<WSListener>();
  private queue: string[] = [];
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private hasConnectedOnce = false;

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;
    const socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = () => {
      const isReconnect = this.hasConnectedOnce;
      this.hasConnectedOnce = true;
      this.reconnectAttempts = 0;
      if (isReconnect) {
        this.listeners.forEach((fn) => fn({ type: '__ws_reconnected__' }));
      }
      while (this.queue.length > 0 && socket.readyState === WebSocket.OPEN) {
        const item = this.queue.shift();
        if (item) socket.send(item);
      }
    };

    socket.onmessage = (evt) => {
      try {
        const parsed = JSON.parse(evt.data);
        this.listeners.forEach((fn) => fn(parsed));
      } catch {
        // ignore malformed
      }
    };

    socket.onclose = () => {
      if (this.ws === socket) {
        this.ws = null;
      }
      if (this.hasConnectedOnce) {
        this.listeners.forEach((fn) => fn({ type: '__ws_disconnected__' }));
      }
      if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
      const delay = Math.min(5000, 1000 * Math.pow(2, Math.min(3, this.reconnectAttempts++)));
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  send(payload: Record<string, any>) {
    const serialized = JSON.stringify(payload);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serialized);
    } else {
      this.queue.push(serialized);
      this.connect();
    }
  }

  subscribe(fn: WSListener) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export const wsClient = new SaturnoWSClient();
