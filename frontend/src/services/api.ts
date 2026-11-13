import { FileEntry, SaturnoConfig } from '../types/notebook';

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
  listDir: (path = '', recursive = true) =>
    apiFetch<{ workspace_root: string; current_path: string; items: FileEntry[] }>(
      `/api/fs/list?path=${encodeURIComponent(path)}&recursive=${recursive ? 'true' : 'false'}`
    ),
  readNotebook: (path: string) =>
    apiFetch<{
      path: string;
      name: string;
      metadata: Record<string, any>;
      cells: any[];
      kernel_status: any;
      variables: any[];
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
    apiFetch<{ path: string; name: string; content: string; truncated: boolean }>(
      `/api/fs/file?path=${encodeURIComponent(path)}`
    ),
  saveFile: (path: string, content: string) =>
    apiFetch<{ saved: boolean; path: string }>('/api/fs/file/save', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),
  createFile: (folder = '', name = 'script.py') =>
    apiFetch<{ path: string; name: string; content: string; truncated: boolean }>(
      '/api/fs/file/create',
      {
        method: 'POST',
        body: JSON.stringify({ folder, name }),
      }
    ),
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
};

type WSListener = (msg: Record<string, any>) => void;

class SaturnoWSClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<WSListener>();
  private queue: string[] = [];
  private reconnectTimer: number | null = null;

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      while (this.queue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
        const item = this.queue.shift();
        if (item) this.ws.send(item);
      }
    };

    this.ws.onmessage = (evt) => {
      try {
        const parsed = JSON.parse(evt.data);
        this.listeners.forEach((fn) => fn(parsed));
      } catch {
        // ignore malformed
      }
    };

    this.ws.onclose = () => {
      if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.connect(), 1500);
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
