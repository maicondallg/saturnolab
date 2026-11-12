import { create } from 'zustand';
import { api, wsClient } from '../services/api';
import { normalizeThemeId } from '../themes';
import {
  CellType,
  FileEntry,
  InlineAIState,
  NotebookCellData,
  OpenNotebookTab,
  SaturnoConfig,
  WorkspaceTab,
} from '../types/notebook';

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export type LeftSidebarTab = 'files' | 'variables' | null;

interface SaturnoStore {
  initialized: boolean;
  config: SaturnoConfig | null;
  workspaceRoot: string;
  currentDir: string;
  files: FileEntry[];
  leftSidebar: LeftSidebarTab;
  showFolderModal: boolean;
  showAIModal: boolean;
  showShortcutsModal: boolean;
  showLineNumbers: boolean;
  statusMessage: string;

  tabs: WorkspaceTab[];
  activeTabId: string;
  notebookMode: 'command' | 'edit';
  clipboardCell: NotebookCellData | null;

  inlineAI: Record<string, InlineAIState>;

  // Init & Config
  initialize: () => Promise<void>;
  updateConfig: (patch: Record<string, any>) => Promise<void>;
  setTheme: (themeId: string) => Promise<void>;
  toggleTheme: () => Promise<void>;
  setLeftSidebar: (tab: LeftSidebarTab) => void;
  setShowFolderModal: (v: boolean) => void;
  setShowAIModal: (v: boolean) => void;
  setShowShortcutsModal: (v: boolean) => void;
  toggleLineNumbers: () => void;
  setStatusMessage: (msg: string) => void;

  // Workspace & FS
  refreshFiles: (dir?: string) => Promise<void>;
  switchWorkspace: (newPath: string) => Promise<void>;
  openEntry: (entry: FileEntry) => Promise<void>;
  openNotebookByPath: (relPath: string) => Promise<void>;
  createNewNotebook: (folder?: string) => Promise<void>;
  createNewFolder: (name: string) => Promise<void>;
  renameEntry: (oldPath: string, newName: string) => Promise<void>;
  deleteEntry: (relPath: string) => Promise<void>;

  // Tabs
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  openLauncher: () => void;
  saveActiveTab: () => Promise<void>;
  updateTextFileContent: (tabId: string, content: string) => void;

  // Notebook & Cells
  setNotebookMode: (mode: 'command' | 'edit') => void;
  selectCell: (cellId: string, mode?: 'command' | 'edit') => void;
  updateCellSource: (cellId: string, source: string) => void;
  setMarkdownRendered: (cellId: string, rendered: boolean) => void;
  changeCellType: (cellId: string, cellType: CellType) => void;
  addCellAbove: (targetCellId?: string, cellType?: CellType) => string | null;
  addCellBelow: (targetCellId?: string, cellType?: CellType) => string | null;
  deleteCell: (cellId?: string) => void;
  moveCell: (cellId: string, direction: 'up' | 'down') => void;
  cutCell: (cellId?: string) => void;
  copyCell: (cellId?: string) => void;
  pasteCellBelow: (cellId?: string) => void;
  clearCellOutputs: (cellId: string) => void;
  clearAllOutputs: () => void;

  // Kernel Execution
  runCell: (cellId?: string, advance?: 'none' | 'next' | 'insert') => void;
  runAllCells: () => void;
  interruptKernel: () => Promise<void>;
  restartKernel: () => Promise<void>;

  // Inline AI (Ctrl+K)
  openInlineAI: (
    cellId: string,
    selection?: { from: number; to: number; text: string } | null,
    initialPrompt?: string,
    lastErrorContext?: string
  ) => void;
  closeInlineAI: (cellId: string) => void;
  setInlineAIPrompt: (cellId: string, prompt: string) => void;
  setInlineAIApplyMode: (
    cellId: string,
    mode: 'replace_selection' | 'replace_cell' | 'append_cell'
  ) => void;
  submitInlineAI: (cellId: string) => void;
  cancelInlineAI: (cellId: string) => void;
  acceptInlineAI: (cellId: string, andRun?: boolean) => void;

  // WS dispatcher
  handleWSMessage: (msg: Record<string, any>) => void;
}

export const useSaturnoStore = create<SaturnoStore>((set, get) => ({
  initialized: false,
  config: null,
  workspaceRoot: '',
  currentDir: '',
  files: [],
  leftSidebar: 'files',
  showFolderModal: false,
  showAIModal: false,
  showShortcutsModal: false,
  showLineNumbers: true,
  statusMessage: 'Pronto',

  tabs: [{ kind: 'launcher', id: '__launcher__', name: 'Launcher' }],
  activeTabId: '__launcher__',
  notebookMode: 'command',
  clipboardCell: null,
  inlineAI: {},

  initialize: async () => {
    if (get().initialized) return;
    wsClient.connect();
    wsClient.subscribe((msg) => get().handleWSMessage(msg));

    try {
      const cfg = await api.getConfig();
      const localTheme = window.localStorage.getItem('saturno_theme');
      const resolvedTheme = normalizeThemeId(localTheme || cfg.theme);
      document.documentElement.setAttribute('data-theme', resolvedTheme);
      const listing = await api.listDir('');
      set({
        initialized: true,
        config: { ...cfg, theme: resolvedTheme },
        workspaceRoot: listing.workspace_root,
        currentDir: listing.current_path,
        files: listing.items,
      });

      // Auto-open welcome notebook on initial load if present
      const welcome = listing.items.find(
        (i) => i.type === 'notebook' && i.name.toLowerCase().includes('bem_vindo')
      );
      if (welcome) {
        await get().openNotebookByPath(welcome.path);
      }
    } catch (err: any) {
      set({ initialized: true, statusMessage: `Erro ao inicializar: ${err.message}` });
    }
  },

  updateConfig: async (patch) => {
    // Apply theme attribute immediately on DOM even before backend reply
    if (patch.theme) {
      document.documentElement.setAttribute('data-theme', normalizeThemeId(patch.theme));
    }
    const updated = await api.updateConfig(patch);
    const resolvedTheme = normalizeThemeId(updated.theme || patch.theme);
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    set({ config: { ...updated, theme: resolvedTheme }, statusMessage: 'Configurações salvas' });
  },

  setTheme: async (themeId) => {
    const clean = normalizeThemeId(themeId);
    window.localStorage.setItem('saturno_theme', clean);
    document.documentElement.setAttribute('data-theme', clean);
    set((s) => ({
      config: s.config ? { ...s.config, theme: clean } : s.config,
    }));
    try {
      await api.updateConfig({ theme: clean });
    } catch {
      // Keep optimistic DOM theme even if backend wasn't restarted yet
    }
  },

  toggleTheme: async () => {
    const cur = normalizeThemeId(get().config?.theme);
    const next = cur === 'paper' || cur === 'solarized_light' ? 'graphite' : 'paper';
    await get().setTheme(next);
  },

  setLeftSidebar: (tab) => {
    set((s) => ({ leftSidebar: s.leftSidebar === tab ? null : tab }));
  },

  setShowFolderModal: (v) => set({ showFolderModal: v }),
  setShowAIModal: (v) => set({ showAIModal: v }),
  setShowShortcutsModal: (v) => set({ showShortcutsModal: v }),
  toggleLineNumbers: () => set((s) => ({ showLineNumbers: !s.showLineNumbers })),
  setStatusMessage: (msg) => set({ statusMessage: msg }),

  refreshFiles: async (dir) => {
    const targetDir = dir !== undefined ? dir : get().currentDir;
    const listing = await api.listDir(targetDir);
    set({
      workspaceRoot: listing.workspace_root,
      currentDir: listing.current_path,
      files: listing.items,
    });
  },

  switchWorkspace: async (newPath) => {
    const res = await api.switchWorkspace(newPath);
    set({
      workspaceRoot: res.workspace_root,
      currentDir: res.listing.current_path,
      files: res.listing.items,
      tabs: [{ kind: 'launcher', id: '__launcher__', name: 'Launcher' }],
      activeTabId: '__launcher__',
      showFolderModal: false,
      statusMessage: `Conectado em ${res.workspace_root}`,
    });
  },

  openEntry: async (entry) => {
    if (entry.type === 'directory') {
      await get().refreshFiles(entry.path);
      return;
    }
    if (entry.type === 'notebook') {
      await get().openNotebookByPath(entry.path);
      return;
    }
    // Open text file tab
    const existing = get().tabs.find((t) => t.id === entry.path);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const fileData = await api.readFile(entry.path);
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          kind: 'file',
          id: fileData.path,
          path: fileData.path,
          name: fileData.name,
          content: fileData.content,
          dirty: false,
        },
      ],
      activeTabId: fileData.path,
    }));
  },

  openNotebookByPath: async (relPath) => {
    const existing = get().tabs.find((t) => t.id === relPath);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const nb = await api.readNotebook(relPath);
    const cells: NotebookCellData[] = nb.cells.map((c: any) => ({
      ...c,
      isRunning: false,
      markdownRendered: c.cell_type === 'markdown' && Boolean((c.source || '').trim()),
    }));
    const newTab: OpenNotebookTab = {
      kind: 'notebook',
      id: nb.path,
      path: nb.path,
      name: nb.name,
      cells,
      metadata: nb.metadata || {},
      dirty: false,
      kernelStatus: nb.kernel_status || 'not_started',
      variables: nb.variables || [],
      activeCellId: cells[0]?.id || '',
    };
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: newTab.id,
      notebookMode: 'command',
    }));

    // Warm up kernel in background so execution is instant
    api
      .startKernel(nb.path)
      .then((kres) => {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.kind === 'notebook' && t.path === nb.path
              ? { ...t, kernelStatus: kres.status as any, variables: kres.variables || t.variables }
              : t
          ),
        }));
      })
      .catch(() => {});
  },

  createNewNotebook: async (folder) => {
    const targetFolder = folder !== undefined ? folder : get().currentDir;
    const nb = await api.createNotebook(targetFolder);
    await get().refreshFiles(targetFolder);
    await get().openNotebookByPath(nb.path);
    set({ statusMessage: `Notebook criado: ${nb.name}` });
  },

  createNewFolder: async (name) => {
    await api.createFolder(get().currentDir, name);
    await get().refreshFiles();
  },

  renameEntry: async (oldPath, newName) => {
    const res = await api.renameEntry(oldPath, newName);
    await get().refreshFiles();
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === oldPath
          ? ({ ...t, id: res.new_path, path: res.new_path, name: res.name } as WorkspaceTab)
          : t
      ),
      activeTabId: s.activeTabId === oldPath ? res.new_path : s.activeTabId,
      statusMessage: `Renomeado para ${res.name}`,
    }));
  },

  deleteEntry: async (relPath) => {
    await api.deleteEntry(relPath);
    get().closeTab(relPath);
    await get().refreshFiles();
    set({ statusMessage: `Removido: ${relPath}` });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  closeTab: (id) => {
    set((s) => {
      const remaining = s.tabs.filter((t) => t.id !== id);
      if (remaining.length === 0) {
        remaining.push({ kind: 'launcher', id: '__launcher__', name: 'Launcher' });
      }
      const nextActive =
        s.activeTabId === id ? remaining[remaining.length - 1].id : s.activeTabId;
      return { tabs: remaining, activeTabId: nextActive };
    });
  },

  openLauncher: () => {
    const existing = get().tabs.find((t) => t.kind === 'launcher');
    if (existing) {
      set({ activeTabId: existing.id });
    } else {
      set((s) => ({
        tabs: [...s.tabs, { kind: 'launcher', id: '__launcher__', name: 'Launcher' }],
        activeTabId: '__launcher__',
      }));
    }
  },

  saveActiveTab: async () => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab) return;
    if (tab.kind === 'notebook') {
      await api.saveNotebook(tab.path, tab.cells, tab.metadata);
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tab.id && t.kind === 'notebook' ? { ...t, dirty: false } : t
        ),
        statusMessage: `Salvo: ${tab.name}`,
      }));
      await get().refreshFiles();
    } else if (tab.kind === 'file') {
      await api.saveFile(tab.path, tab.content);
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tab.id && t.kind === 'file' ? { ...t, dirty: false } : t
        ),
        statusMessage: `Arquivo salvo: ${tab.name}`,
      }));
    }
  },

  updateTextFileContent: (tabId, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId && t.kind === 'file' ? { ...t, content, dirty: true } : t
      ),
    }));
  },

  setNotebookMode: (mode) => set({ notebookMode: mode }),

  selectCell: (cellId, mode) => {
    set((s) => ({
      notebookMode: mode || s.notebookMode,
      tabs: s.tabs.map((t) =>
        t.id === s.activeTabId && t.kind === 'notebook'
          ? { ...t, activeCellId: cellId }
          : t
      ),
    }));
  },

  updateCellSource: (cellId, source) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === s.activeTabId && t.kind === 'notebook'
          ? {
              ...t,
              dirty: true,
              cells: t.cells.map((c) => (c.id === cellId ? { ...c, source } : c)),
            }
          : t
      ),
    }));
  },

  setMarkdownRendered: (cellId, rendered) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === s.activeTabId && t.kind === 'notebook'
          ? {
              ...t,
              cells: t.cells.map((c) =>
                c.id === cellId ? { ...c, markdownRendered: rendered } : c
              ),
            }
          : t
      ),
    }));
  },

  changeCellType: (cellId, cellType) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === s.activeTabId && t.kind === 'notebook'
          ? {
              ...t,
              dirty: true,
              cells: t.cells.map((c) =>
                c.id === cellId
                  ? {
                      ...c,
                      cell_type: cellType,
                      outputs: cellType === 'markdown' ? [] : c.outputs,
                      execution_count: cellType === 'markdown' ? null : c.execution_count,
                      markdownRendered: false,
                    }
                  : c
              ),
            }
          : t
      ),
    }));
  },

  addCellAbove: (targetCellId, cellType = 'code') => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return null;
    const refId = targetCellId || tab.activeCellId;
    const newId = makeId();
    const newCell: NotebookCellData = {
      id: newId,
      cell_type: cellType,
      source: '',
      execution_count: null,
      outputs: [],
      metadata: {},
      markdownRendered: false,
    };
    const idx = Math.max(
      0,
      tab.cells.findIndex((c) => c.id === refId)
    );
    const nextCells = [...tab.cells];
    nextCells.splice(idx, 0, newCell);
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id && t.kind === 'notebook'
          ? { ...t, dirty: true, cells: nextCells, activeCellId: newId }
          : t
      ),
    }));
    return newId;
  },

  addCellBelow: (targetCellId, cellType = 'code') => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return null;
    const refId = targetCellId || tab.activeCellId;
    const newId = makeId();
    const newCell: NotebookCellData = {
      id: newId,
      cell_type: cellType,
      source: '',
      execution_count: null,
      outputs: [],
      metadata: {},
      markdownRendered: false,
    };
    const foundIdx = tab.cells.findIndex((c) => c.id === refId);
    const insertIdx = foundIdx === -1 ? tab.cells.length : foundIdx + 1;
    const nextCells = [...tab.cells];
    nextCells.splice(insertIdx, 0, newCell);
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id && t.kind === 'notebook'
          ? { ...t, dirty: true, cells: nextCells, activeCellId: newId }
          : t
      ),
    }));
    return newId;
  },

  deleteCell: (cellId) => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return;
    const targetId = cellId || tab.activeCellId;
    if (tab.cells.length <= 1) {
      // Reset single remaining cell
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tab.id && t.kind === 'notebook'
            ? {
                ...t,
                dirty: true,
                cells: [
                  {
                    ...t.cells[0],
                    source: '',
                    outputs: [],
                    execution_count: null,
                    markdownRendered: false,
                  },
                ],
              }
            : t
        ),
      }));
      return;
    }
    const idx = tab.cells.findIndex((c) => c.id === targetId);
    const nextCells = tab.cells.filter((c) => c.id !== targetId);
    const nextActive = nextCells[Math.min(idx, nextCells.length - 1)].id;
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id && t.kind === 'notebook'
          ? { ...t, dirty: true, cells: nextCells, activeCellId: nextActive }
          : t
      ),
    }));
  },

  moveCell: (cellId, direction) => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return;
    const idx = tab.cells.findIndex((c) => c.id === cellId);
    if (idx === -1) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= tab.cells.length) return;
    const nextCells = [...tab.cells];
    [nextCells[idx], nextCells[swapIdx]] = [nextCells[swapIdx], nextCells[idx]];
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id && t.kind === 'notebook'
          ? { ...t, dirty: true, cells: nextCells }
          : t
      ),
    }));
  },

  cutCell: (cellId) => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return;
    const targetId = cellId || tab.activeCellId;
    const found = tab.cells.find((c) => c.id === targetId);
    if (!found) return;
    set({ clipboardCell: { ...found } });
    get().deleteCell(targetId);
  },

  copyCell: (cellId) => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return;
    const targetId = cellId || tab.activeCellId;
    const found = tab.cells.find((c) => c.id === targetId);
    if (found) set({ clipboardCell: { ...found } });
  },

  pasteCellBelow: (cellId) => {
    const clip = get().clipboardCell;
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!clip || !tab || tab.kind !== 'notebook') return;
    const refId = cellId || tab.activeCellId;
    const newId = makeId();
    const cloned: NotebookCellData = {
      ...clip,
      id: newId,
      execution_count: null,
    };
    const idx = tab.cells.findIndex((c) => c.id === refId);
    const nextCells = [...tab.cells];
    nextCells.splice(idx + 1, 0, cloned);
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id && t.kind === 'notebook'
          ? { ...t, dirty: true, cells: nextCells, activeCellId: newId }
          : t
      ),
    }));
  },

  clearCellOutputs: (cellId) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === s.activeTabId && t.kind === 'notebook'
          ? {
              ...t,
              dirty: true,
              cells: t.cells.map((c) =>
                c.id === cellId ? { ...c, outputs: [], execution_count: null } : c
              ),
            }
          : t
      ),
    }));
  },

  clearAllOutputs: () => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === s.activeTabId && t.kind === 'notebook'
          ? {
              ...t,
              dirty: true,
              cells: t.cells.map((c) => ({ ...c, outputs: [], execution_count: null })),
            }
          : t
      ),
    }));
  },

  runCell: (cellId, advance = 'none') => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return;
    const targetId = cellId || tab.activeCellId;
    const idx = tab.cells.findIndex((c) => c.id === targetId);
    if (idx === -1) return;
    const cell = tab.cells[idx];

    if (cell.cell_type === 'markdown') {
      get().setMarkdownRendered(cell.id, true);
    } else {
      // Clear cell outputs & mark running
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tab.id && t.kind === 'notebook'
            ? {
                ...t,
                kernelStatus: 'busy',
                cells: t.cells.map((c) =>
                  c.id === cell.id ? { ...c, outputs: [], isRunning: true } : c
                ),
              }
            : t
        ),
      }));
      wsClient.send({
        action: 'execute_cell',
        notebook_path: tab.path,
        cell_id: cell.id,
        code: cell.source,
      });
    }

    if (advance === 'insert') {
      const inserted = get().addCellBelow(cell.id, 'code');
      if (inserted) get().selectCell(inserted, 'edit');
    } else if (advance === 'next') {
      if (idx + 1 < tab.cells.length) {
        get().selectCell(tab.cells[idx + 1].id, 'command');
      } else {
        const inserted = get().addCellBelow(cell.id, 'code');
        if (inserted) get().selectCell(inserted, 'edit');
      }
    }
  },

  runAllCells: () => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return;
    for (const c of tab.cells) {
      if (c.cell_type === 'markdown') {
        get().setMarkdownRendered(c.id, true);
      } else if (c.source.trim()) {
        get().runCell(c.id, 'none');
      }
    }
  },

  interruptKernel: async () => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return;
    wsClient.send({ action: 'interrupt_kernel', notebook_path: tab.path });
    await api.interruptKernel(tab.path);
    set({ statusMessage: 'Kernel interrompido' });
  },

  restartKernel: async () => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return;
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id && t.kind === 'notebook'
          ? {
              ...t,
              kernelStatus: 'starting',
              variables: [],
              cells: t.cells.map((c) => ({ ...c, isRunning: false })),
            }
          : t
      ),
    }));
    await api.restartKernel(tab.path);
    set((s) => ({
      statusMessage: 'Kernel reiniciado',
      tabs: s.tabs.map((t) =>
        t.id === tab.id && t.kind === 'notebook' ? { ...t, kernelStatus: 'idle' } : t
      ),
    }));
  },

  openInlineAI: (cellId, selection = null, initialPrompt = '', lastErrorContext = '') => {
    const cfgDefault = get().config?.default_ai_apply_mode || 'replace_cell';
    let defaultMode: 'replace_selection' | 'replace_cell' | 'append_cell' = cfgDefault;
    if (selection && selection.text.trim().length > 0) {
      defaultMode = 'replace_selection';
    } else if (lastErrorContext) {
      defaultMode = 'replace_cell';
    }

    set((s) => ({
      inlineAI: {
        ...s.inlineAI,
        [cellId]: {
          isOpen: true,
          prompt: initialPrompt,
          status: 'idle',
          streamedCode: '',
          errorMessage: undefined,
          selection,
          applyMode: defaultMode,
          lastErrorContext,
        },
      },
    }));
  },

  closeInlineAI: (cellId) => {
    const st = get().inlineAI[cellId];
    if (st?.status === 'streaming' && st.requestId) {
      wsClient.send({ action: 'ai_cancel', request_id: st.requestId });
    }
    set((s) => {
      const copy = { ...s.inlineAI };
      delete copy[cellId];
      return { inlineAI: copy };
    });
  },

  setInlineAIPrompt: (cellId, prompt) => {
    set((s) => {
      const cur = s.inlineAI[cellId];
      if (!cur) return s;
      return {
        inlineAI: {
          ...s.inlineAI,
          [cellId]: { ...cur, prompt },
        },
      };
    });
  },

  setInlineAIApplyMode: (cellId, mode) => {
    set((s) => {
      const cur = s.inlineAI[cellId];
      if (!cur) return s;
      return {
        inlineAI: {
          ...s.inlineAI,
          [cellId]: { ...cur, applyMode: mode },
        },
      };
    });
  },

  submitInlineAI: (cellId) => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    const aiState = get().inlineAI[cellId];
    if (!tab || tab.kind !== 'notebook' || !aiState || !aiState.prompt.trim()) return;

    const cellIdx = tab.cells.findIndex((c) => c.id === cellId);
    if (cellIdx === -1) return;
    const cell = tab.cells[cellIdx];

    const cellsAbove = tab.cells
      .slice(0, cellIdx)
      .map((c) => ({ cell_type: c.cell_type, source: c.source }));
    const cellsBelow = tab.cells
      .slice(cellIdx + 1)
      .map((c) => ({ cell_type: c.cell_type, source: c.source }));

    // Auto-extract last error from cell outputs if present
    let errorCtx = aiState.lastErrorContext || '';
    if (!errorCtx) {
      const errOut = cell.outputs.find((o) => o.output_type === 'error');
      if (errOut) {
        errorCtx = `${errOut.ename}: ${errOut.evalue}\n${(errOut.traceback || []).join('\n')}`;
      }
    }

    const reqId = `ai_${makeId()}`;
    set((s) => ({
      inlineAI: {
        ...s.inlineAI,
        [cellId]: {
          ...aiState,
          status: 'streaming',
          streamedCode: '',
          errorMessage: undefined,
          requestId: reqId,
        },
      },
    }));

    wsClient.send({
      action: 'ai_generate',
      request_id: reqId,
      notebook_path: tab.path,
      cell_id: cellId,
      cell_type: cell.cell_type,
      prompt: aiState.prompt,
      current_code: cell.source,
      selected_text: aiState.selection?.text || '',
      cells_above: cellsAbove,
      cells_below: cellsBelow,
      last_error: errorCtx,
    });
  },

  cancelInlineAI: (cellId) => {
    const st = get().inlineAI[cellId];
    if (st?.requestId) {
      wsClient.send({ action: 'ai_cancel', request_id: st.requestId });
    }
    set((s) => {
      const cur = s.inlineAI[cellId];
      if (!cur) return s;
      return {
        inlineAI: {
          ...s.inlineAI,
          [cellId]: {
            ...cur,
            status: cur.streamedCode.trim() ? 'preview' : 'idle',
          },
        },
      };
    });
  },

  acceptInlineAI: (cellId, andRun = false) => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    const st = get().inlineAI[cellId];
    if (!tab || tab.kind !== 'notebook' || !st || !st.streamedCode) return;

    const cell = tab.cells.find((c) => c.id === cellId);
    if (!cell) return;

    let newSource = st.streamedCode;
    if (st.applyMode === 'replace_selection' && st.selection) {
      const before = cell.source.slice(0, st.selection.from);
      const after = cell.source.slice(st.selection.to);
      newSource = `${before}${st.streamedCode}${after}`;
    } else if (st.applyMode === 'append_cell' && cell.source.trim()) {
      newSource = `${cell.source.trimEnd()}\n\n${st.streamedCode}`;
    }

    get().updateCellSource(cellId, newSource);
    get().closeInlineAI(cellId);
    if (andRun) {
      get().runCell(cellId, 'none');
    }
  },

  handleWSMessage: (msg) => {
    const type = msg.type;

    if (type === 'kernel_status') {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.kind === 'notebook' && t.path === msg.notebook_path
            ? { ...t, kernelStatus: msg.status }
            : t
        ),
      }));
    } else if (type === 'cell_execution_start') {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.kind === 'notebook' && t.path === msg.notebook_path
            ? {
                ...t,
                cells: t.cells.map((c) =>
                  c.id === msg.cell_id ? { ...c, isRunning: true, outputs: [] } : c
                ),
              }
            : t
        ),
      }));
    } else if (type === 'cell_execution_count') {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.kind === 'notebook' && t.path === msg.notebook_path
            ? {
                ...t,
                cells: t.cells.map((c) =>
                  c.id === msg.cell_id ? { ...c, execution_count: msg.execution_count } : c
                ),
              }
            : t
        ),
      }));
    } else if (type === 'cell_clear_output') {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.kind === 'notebook' && t.path === msg.notebook_path
            ? {
                ...t,
                cells: t.cells.map((c) => (c.id === msg.cell_id ? { ...c, outputs: [] } : c)),
              }
            : t
        ),
      }));
    } else if (type === 'cell_output') {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.kind !== 'notebook' || t.path !== msg.notebook_path) return t;
          return {
            ...t,
            dirty: true,
            cells: t.cells.map((c) => {
              if (c.id !== msg.cell_id) return c;
              const incoming = msg.output;
              const prevOutputs = [...c.outputs];
              // Merge consecutive stdout/stderr stream chunks neatly
              if (
                incoming.output_type === 'stream' &&
                prevOutputs.length > 0 &&
                prevOutputs[prevOutputs.length - 1].output_type === 'stream' &&
                prevOutputs[prevOutputs.length - 1].name === incoming.name
              ) {
                const last = prevOutputs[prevOutputs.length - 1];
                prevOutputs[prevOutputs.length - 1] = {
                  ...last,
                  text: (last.text || '') + (incoming.text || ''),
                };
              } else {
                prevOutputs.push(incoming);
              }
              return { ...c, outputs: prevOutputs };
            }),
          };
        }),
      }));
    } else if (type === 'cell_execution_done') {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.kind === 'notebook' && t.path === msg.notebook_path
            ? {
                ...t,
                variables: msg.variables || t.variables,
                cells: t.cells.map((c) =>
                  c.id === msg.cell_id
                    ? {
                        ...c,
                        isRunning: false,
                        execution_count:
                          msg.execution_count !== undefined && msg.execution_count !== null
                            ? msg.execution_count
                            : c.execution_count,
                      }
                    : c
                ),
              }
            : t
        ),
      }));
    } else if (type === 'ai_chunk') {
      set((s) => {
        const cur = s.inlineAI[msg.cell_id];
        if (!cur || cur.requestId !== msg.request_id) return s;
        return {
          inlineAI: {
            ...s.inlineAI,
            [msg.cell_id]: {
              ...cur,
              status: 'streaming',
              streamedCode: cur.streamedCode + (msg.delta || ''),
            },
          },
        };
      });
    } else if (type === 'ai_done') {
      set((s) => {
        const cur = s.inlineAI[msg.cell_id];
        if (!cur || cur.requestId !== msg.request_id) return s;
        return {
          inlineAI: {
            ...s.inlineAI,
            [msg.cell_id]: {
              ...cur,
              status: 'preview',
              streamedCode: msg.code ?? cur.streamedCode,
            },
          },
        };
      });
    } else if (type === 'ai_error') {
      set((s) => {
        const cur = s.inlineAI[msg.cell_id];
        if (!cur || cur.requestId !== msg.request_id) return s;
        return {
          inlineAI: {
            ...s.inlineAI,
            [msg.cell_id]: {
              ...cur,
              status: 'error',
              errorMessage: msg.message || 'Erro ao gerar código',
            },
          },
        };
      });
    }
  },
}));
