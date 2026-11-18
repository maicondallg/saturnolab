import { create } from 'zustand';
import { api, wsClient } from '../services/api';
import {
  deleteDraft,
  deleteDraftsMatching,
  flushDirtyDraftsSync,
  isDraftStorageReady,
  reconcileFileWithDraft,
  reconcileNotebookWithDraft,
  remapDraftPaths,
  warmupDraftStorage,
  writeTabDraft,
} from '../services/draftStorage';
import { flushAllPendingEditors, loadNotebookView, loadTextFileView } from '../services/editorViews';
import { normalizeThemeId } from '../themes';
import { bootstrapConfig, persistAppearance } from '../services/bootstrap';
import { hasUnsavedChanges, initialWorkspaceSession, reconcileRestoredSession, preloadWorkspaceEditors, restoreWorkspaceSession, saveWorkspaceSession } from '../services/workspaceSession';
import {
  CellType,
  EditorPane,
  FileEntry,
  InlineAIState,
  NotebookCellData,
  OpenNotebookTab,
  OpenTextFileTab,
  SaturnoConfig,
  SettingsSection,
  TableOutputSettings,
  WorkspaceTab,
} from '../types/notebook';
import {
  loadStoredTableOutputSettings,
  normalizeTableOutputSettings,
  saveStoredTableOutputSettings,
} from '../utils/tableConfig';
import { hiddenSectionCells } from '../utils/notebookOutline';

const MAX_STREAM_CHARS = 512_000;
const TRUNCATION_NOTICE = '\n… [saída truncada após 512 KB]';
const MAX_DELETED_CELL_STACK = 30;

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function isPathOrDescendant(path: string, target: string): boolean {
  return Boolean(target) && (path === target || path.startsWith(`${target}/`));
}

function remapPathPrefix(path: string, oldPrefix: string, newPrefix: string): string | null {
  if (path === oldPrefix) return newPrefix;
  if (path.startsWith(`${oldPrefix}/`)) return `${newPrefix}${path.slice(oldPrefix.length)}`;
  return null;
}

function remapFileEntries(
  entries: FileEntry[],
  remap: (path: string) => string | null
): FileEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    const mappedPath = remap(entry.path);
    const mappedChildren = entry.children ? remapFileEntries(entry.children, remap) : undefined;
    if (!mappedPath && mappedChildren === entry.children) return entry;
    changed = true;
    const nextPath = mappedPath ?? entry.path;
    const nextName = mappedPath ? nextPath.split('/').pop() || entry.name : entry.name;
    return {
      ...entry,
      path: nextPath,
      name: nextName,
      ...(mappedChildren !== undefined ? { children: mappedChildren } : {}),
    };
  });
  return changed ? next : entries;
}

function shouldAutoScrollCellOutput(tab: OpenNotebookTab, cellId: string): boolean {
  if (!tab.activeCellId || tab.activeCellId === cellId) return true;
  const hidden = hiddenSectionCells(tab.cells);
  const visible = hidden.size ? tab.cells.filter((c) => !hidden.has(c.id)) : tab.cells;
  const cellIdx = visible.findIndex((c) => c.id === cellId);
  if (cellIdx === -1) return false;
  return visible[cellIdx + 1]?.id === tab.activeCellId;
}

function makeTabInstanceId(kind: WorkspaceTab['kind']): string {
  if (kind === 'launcher') return '__launcher__';
  return `tab_${makeId()}`;
}

export function findNotebookTabForCell(
  tabs: WorkspaceTab[],
  activeTabId: string,
  cellId?: string
): OpenNotebookTab | undefined {
  const active = tabs.find((t): t is OpenNotebookTab => t.id === activeTabId && t.kind === 'notebook');
  if (cellId && active && active.cells.some((c) => c.id === cellId)) return active;
  if (cellId) {
    const candidate = tabs.find(
      (t): t is OpenNotebookTab => t.kind === 'notebook' && t.cells.some((c) => c.id === cellId)
    );
    if (candidate) return candidate;
  }
  return active;
}

export function isInlineAIPromptEdited(aiState?: InlineAIState): boolean {
  if (!aiState || aiState.status !== 'preview') return false;
  if (aiState.submittedPrompt === undefined) return false;
  return aiState.prompt.trim() !== aiState.submittedPrompt;
}

export function canAcceptInlineAIPreview(aiState?: InlineAIState): boolean {
  return Boolean(
    aiState?.isOpen &&
      aiState.status === 'preview' &&
      aiState.streamedCode.trim() &&
      !isInlineAIPromptEdited(aiState)
  );
}

export function mergeStreamText(existing: string, incoming: string): string {
  if (!incoming) return existing;
  if (existing.endsWith(TRUNCATION_NOTICE)) return existing;

  let merged: string;
  if (!incoming.includes('\r')) {
    merged = existing + incoming;
  } else {
    const normalized = incoming.replace(/\r\n/g, '\n');
    if (!normalized.includes('\r')) {
      merged = existing + normalized;
    } else {
      let buf = existing;
      const segments = normalized.split('\r');
      buf += segments[0];
      for (let i = 1; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.startsWith('\n')) {
          buf += seg;
        } else if (seg.length > 0) {
          const lastNl = buf.lastIndexOf('\n');
          const lineStart = lastNl + 1;
          const nlInSeg = seg.indexOf('\n');
          if (nlInSeg === -1) {
            const currentLineLen = buf.length - lineStart;
            const tail = seg.length < currentLineLen ? buf.slice(lineStart + seg.length) : '';
            buf = buf.slice(0, lineStart) + seg + tail;
          } else {
            buf = buf.slice(0, lineStart) + seg;
          }
        }
      }
      merged = buf;
    }
  }

  if (merged.length > MAX_STREAM_CHARS) {
    return merged.slice(0, MAX_STREAM_CHARS) + TRUNCATION_NOTICE;
  }
  return merged;
}

export type LeftSidebarTab = 'files' | 'variables' | 'outline' | null;

interface DeletedCellRecord {
  notebookPath: string;
  cell: NotebookCellData;
  index: number;
}

export interface ScrollSignal {
  notebookPath: string;
  cellId: string;
  kind: 'output' | 'cell';
  seq: number;
}

interface OpenOptions {
  sideBySide?: boolean;
  targetPaneId?: string;
}

interface SaturnoStore {
  initialized: boolean;
  config: SaturnoConfig | null;
  workspaceRoot: string;
  currentDir: string;
  files: FileEntry[];
  leftSidebar: LeftSidebarTab;

  // Layout & UI Preferences
  notebookLayout: 'centered' | 'expanded';
  sidebarPosition: 'left' | 'right';
  sidebarWidth: number;
  showLineNumbers: boolean;
  autoScrollOnRun: boolean;
  showModifiedTime: boolean;
  confirmKernelRestart: boolean;
  autoSave: boolean;
  autoSaveDelay: number;
  editorFontSize: number;
  showMinimap: boolean;
  minimapWidth: number;
  minimapShowOutputs: boolean;
  tableOutputSettings: TableOutputSettings;

  // Modals
  showFolderModal: boolean;
  showSettingsModal: boolean;
  settingsSection: SettingsSection;
  statusMessage: string;

  // Tree & Multi-select
  expandedFolders: Record<string, boolean>;
  folderChildren: Record<string, FileEntry[]>;
  selectedFilePaths: string[];
  lastClickedFilePath: string | null;
  activeFolderContext: string;

  // Tabs & Split Panes
  tabs: WorkspaceTab[];
  panes: EditorPane[];
  activePaneId: string;
  activeTabId: string;
  notebookMode: 'command' | 'edit';
  clipboardCell: NotebookCellData | null;
  deletedCellStack: DeletedCellRecord[];
  scrollSignal: ScrollSignal | null;

  inlineAI: Record<string, InlineAIState>;

  // Init & Config
  initialize: () => Promise<void>;
  updateConfig: (patch: Record<string, any>) => Promise<void>;
  setTheme: (themeId: string) => Promise<void>;
  toggleTheme: () => Promise<void>;
  setLeftSidebar: (tab: LeftSidebarTab) => void;
  setNotebookLayout: (layout: 'centered' | 'expanded') => void;
  toggleNotebookLayout: () => void;
  setSidebarPosition: (pos: 'left' | 'right') => void;
  toggleSidebarPosition: () => void;
  setSidebarWidth: (width: number, persist?: boolean) => void;
  setEditorFontSize: (size: number) => void;
  setAutoScrollOnRun: (v: boolean) => void;
  setShowModifiedTime: (v: boolean) => void;
  setConfirmKernelRestart: (v: boolean) => void;
  setAutoSave: (v: boolean) => void;
  setAutoSaveDelay: (ms: number) => void;
  setShowMinimap: (v: boolean) => void;
  toggleMinimap: () => void;
  setMinimapWidth: (width: number, persist?: boolean) => void;
  setMinimapShowOutputs: (v: boolean) => void;
  setTableOutputSettings: (patch: Partial<TableOutputSettings>) => void;
  setShowFolderModal: (v: boolean) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  toggleLineNumbers: () => void;
  setStatusMessage: (msg: string) => void;

  // Tree & Multi-selection
  toggleFolderExpanded: (path: string) => void;
  setFolderExpanded: (path: string, expanded: boolean) => void;
  collapseAllFolders: () => void;
  setActiveFolderContext: (folderPath: string) => void;
  toggleFileSelection: (path: string, exclusive?: boolean) => void;
  selectFileRange: (visiblePaths: string[], targetPath: string) => void;
  selectAllFiles: (visiblePaths: string[]) => void;
  clearFileSelection: () => void;

  // Workspace & FS
  refreshFiles: (dir?: string) => Promise<void>;
  switchWorkspace: (newPath: string) => Promise<void>;
  openEntry: (entry: FileEntry, options?: OpenOptions) => Promise<void>;
  openNotebookByPath: (relPath: string, options?: OpenOptions) => Promise<void>;
  createNewNotebook: (folder?: string, name?: string) => Promise<void>;
  createNewFile: (folder?: string, name?: string) => Promise<void>;
  createNewFolder: (name: string, parentFolder?: string) => Promise<void>;
  renameEntry: (oldPath: string, newName: string) => Promise<void>;
  deleteEntry: (relPath: string) => Promise<void>;
  deleteBatchEntries: (paths: string[]) => Promise<void>;
  moveEntries: (paths: string[], targetFolder: string) => Promise<void>;

  // Tabs & Split Panes
  setActivePane: (paneId: string) => void;
  setActiveTab: (id: string, paneId?: string) => void;
  closeTab: (id: string, paneId?: string) => void;
  splitTab: (
    tabId?: string,
    sourcePaneId?: string,
    direction?: 'right' | 'left',
    originPaneId?: string
  ) => void;
  moveTabToPane: (tabId: string, sourcePaneId: string, targetPaneId: string) => void;
  closePane: (paneId: string) => void;
  setPaneWidths: (ratios: Record<string, number>) => void;
  openLauncher: (paneId?: string) => void;
  saveActiveTab: () => Promise<void>;
  saveTabById: (tabId: string, options?: { silent?: boolean }) => Promise<void>;
  updateTextFileContent: (tabId: string, content: string) => void;

  // Notebook & Cells
  setNotebookMode: (mode: 'command' | 'edit') => void;
  selectCell: (cellId: string, mode?: 'command' | 'edit', scrollIntoView?: boolean) => void;
  updateCellSource: (cellId: string, source: string) => void;
  setMarkdownRendered: (cellId: string, rendered: boolean) => void;
  toggleSection: (cellId: string) => void;
  toggleCellOutputCollapse: (cellId?: string) => void;
  changeCellType: (cellId: string, cellType: CellType) => void;
  addCellAbove: (targetCellId?: string, cellType?: CellType) => string | null;
  addCellBelow: (targetCellId?: string, cellType?: CellType) => string | null;
  deleteCell: (cellId?: string) => void;
  undoDeleteCell: () => void;
  redoDeleteCell: () => void;
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
  restartKernel: (fromShortcut?: boolean) => Promise<void>;

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

let initializing = false;
let restoringSession = false;
let sessionPersistenceReady = false;

let pendingWSQueue: Record<string, any>[] = [];
let pendingWSFrame: number | null = null;

const INITIAL_PANE_ID = 'pane_main';
const initialSession = initialWorkspaceSession(bootstrapConfig?.workspace_dir || '');

function loadExpandedFolders(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem('saturno_expanded_folders');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveExpandedFolders(map: Record<string, boolean>) {
  try {
    window.localStorage.setItem('saturno_expanded_folders', JSON.stringify(map));
  } catch {
    // ignore
  }
}

function loadStoredAutoSave(): boolean {
  if (bootstrapConfig?.auto_save !== undefined) return Boolean(bootstrapConfig.auto_save);
  try {
    const raw = window.localStorage.getItem('saturno_auto_save');
    if (raw === 'false') return false;
    if (raw === 'true') return true;
  } catch {
    // ignore
  }
  return true;
}

function loadStoredAutoSaveDelay(): number {
  if (bootstrapConfig?.auto_save_delay) {
    return Math.max(500, Math.min(60000, Number(bootstrapConfig.auto_save_delay)));
  }
  try {
    const raw = Number(window.localStorage.getItem('saturno_auto_save_delay'));
    if (Number.isFinite(raw) && raw >= 500) return Math.min(60000, raw);
  } catch {
    // ignore
  }
  return 2000;
}

function loadStoredBool(
  bootstrapVal: boolean | undefined,
  storageKey: string,
  fallback: boolean
): boolean {
  if (bootstrapVal !== undefined) return Boolean(bootstrapVal);
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === 'false') return false;
    if (raw === 'true') return true;
  } catch {
    // ignore
  }
  return fallback;
}

function loadStoredMinimapWidth(): number {
  const fromBootstrap = bootstrapConfig?.minimap_width;
  if (typeof fromBootstrap === 'number' && Number.isFinite(fromBootstrap)) {
    return Math.max(72, Math.min(200, Math.round(fromBootstrap)));
  }
  try {
    const raw = Number(window.localStorage.getItem('saturno_minimap_width'));
    if (Number.isFinite(raw) && raw >= 72) return Math.min(200, Math.round(raw));
  } catch {
    // ignore
  }
  return 116;
}

function patchEntryModified(
  files: FileEntry[],
  folderChildren: Record<string, FileEntry[]>,
  relPath: string,
  modified?: string
): { files?: FileEntry[]; folderChildren?: Record<string, FileEntry[]> } {
  if (!modified) return {};
  const slashIdx = relPath.lastIndexOf('/');
  if (slashIdx === -1) {
    const idx = files.findIndex((f) => f.path === relPath);
    if (idx === -1 || files[idx].modified === modified) return {};
    const nextFiles = [...files];
    nextFiles[idx] = { ...nextFiles[idx], modified };
    return { files: nextFiles };
  }
  const parent = relPath.slice(0, slashIdx);
  const list = folderChildren[parent];
  if (!list) return {};
  const idx = list.findIndex((f) => f.path === relPath);
  if (idx === -1 || list[idx].modified === modified) return {};
  const nextList = [...list];
  nextList[idx] = { ...nextList[idx], modified };
  return { folderChildren: { ...folderChildren, [parent]: nextList } };
}

const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlightSaves = new Map<string, Promise<void>>();

function cancelDraftTimer(tabId: string) {
  const timer = draftTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    draftTimers.delete(tabId);
  }
}

function cancelAutoSaveTimer(tabId: string) {
  const timer = autoSaveTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    autoSaveTimers.delete(tabId);
  }
}

function clearAllPersistenceTimers() {
  for (const t of draftTimers.values()) clearTimeout(t);
  for (const t of autoSaveTimers.values()) clearTimeout(t);
  draftTimers.clear();
  autoSaveTimers.clear();
}

function scheduleIdleWork(fn: () => void) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => fn(), { timeout: 1000 });
  } else {
    fn();
  }
}

function scheduleDraftWrite(tabId: string, delayMs = 350) {
  cancelDraftTimer(tabId);
  draftTimers.set(
    tabId,
    setTimeout(() => {
      draftTimers.delete(tabId);
      scheduleIdleWork(() => {
        const state = useSaturnoStore.getState();
        if (!state.workspaceRoot) return;
        const tab = state.tabs.find((t) => t.id === tabId);
        if (!tab || tab.kind === 'launcher' || tab.loading || !tab.dirty) return;
        void writeTabDraft(state.workspaceRoot, tab);
      });
    }, delayMs)
  );
}

function scheduleAutoSave(tabId: string, delayMs: number) {
  cancelAutoSaveTimer(tabId);
  autoSaveTimers.set(
    tabId,
    setTimeout(() => {
      autoSaveTimers.delete(tabId);
      const state = useSaturnoStore.getState();
      if (!state.autoSave || !state.workspaceRoot) return;
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind === 'launcher' || tab.loading || !tab.dirty) return;
      if (tab.kind === 'file' && tab.truncated) return;
      if (tab.kind === 'notebook' && tab.cells.some((c) => c.isRunning)) return;
      void state.saveTabById(tabId, { silent: true });
    }, delayMs)
  );
}

function syncDirtyTabsTimers(state: SaturnoStore) {
  if (!state.initialized || !state.workspaceRoot) return;
  for (const tab of state.tabs) {
    if (tab.kind === 'launcher' || tab.loading || !tab.dirty) continue;
    if (tab.kind === 'file' && tab.truncated) continue;
    if (tab.kind === 'notebook' && tab.cells.some((c) => c.isRunning)) continue;
    if (state.autoSave && !autoSaveTimers.has(tab.id)) {
      scheduleAutoSave(tab.id, state.autoSaveDelay);
    }
  }
}

function deleteNotebookCell(state: SaturnoStore, tab: OpenNotebookTab, targetId: string, redoIds: string[]) {
  const index = tab.cells.findIndex(cell => cell.id === targetId);
  if (index < 0) return state;
  const cell = tab.cells[index];
  const soleCell = tab.cells.length === 1;
  const cells = soleCell
    ? [{ ...cell, source: '', outputs: [], execution_count: null, markdownRendered: false }]
    : tab.cells.filter(c => c.id !== targetId);
  return {
    deletedCellStack: [...state.deletedCellStack, { notebookPath: tab.path, cell, index }].slice(-MAX_DELETED_CELL_STACK),
    tabs: state.tabs.map(t => t === tab ? {
      ...tab, cells, dirty: true, activeCellId: cells[Math.min(index, cells.length - 1)].id,
      redoDeletedCellIds: redoIds,
    } : t),
    statusMessage: soleCell ? 'Célula limpa (Z para desfazer)' : 'Célula excluída (Z para desfazer)',
  };
}

export const useSaturnoStore = create<SaturnoStore>((set, get) => ({
  initialized: false,
  config: bootstrapConfig || null,
  workspaceRoot: bootstrapConfig?.workspace_dir || '',
  currentDir: '',
  files: [],
  leftSidebar: 'files',

  notebookLayout:
    bootstrapConfig?.notebook_layout || (window.localStorage.getItem('saturno_nb_layout') as 'centered' | 'expanded') ||
    'centered',
  sidebarPosition:
    bootstrapConfig?.sidebar_position || (window.localStorage.getItem('saturno_sidebar_pos') as 'left' | 'right') || 'left',
  sidebarWidth: bootstrapConfig?.sidebar_width || Number(window.localStorage.getItem('saturno_sidebar_width')) || 280,
  showLineNumbers: bootstrapConfig?.show_line_numbers ?? true,
  autoScrollOnRun: bootstrapConfig?.auto_scroll_on_run ?? true,
  showModifiedTime: bootstrapConfig?.show_modified_time ?? true,
  confirmKernelRestart: bootstrapConfig?.confirm_kernel_restart ?? false,
  autoSave: loadStoredAutoSave(),
  autoSaveDelay: loadStoredAutoSaveDelay(),
  editorFontSize: bootstrapConfig?.editor_font_size || Number(window.localStorage.getItem('saturno_font_size')) || 14,
  showMinimap: loadStoredBool(bootstrapConfig?.show_minimap, 'saturno_show_minimap', true),
  minimapWidth: loadStoredMinimapWidth(),
  minimapShowOutputs: loadStoredBool(
    bootstrapConfig?.minimap_show_outputs,
    'saturno_minimap_show_outputs',
    true
  ),
  tableOutputSettings: bootstrapConfig?.table_output
    ? normalizeTableOutputSettings(bootstrapConfig.table_output)
    : loadStoredTableOutputSettings(),

  showFolderModal: false,
  showSettingsModal: false,
  settingsSection: 'appearance',
  statusMessage: 'Pronto',

  expandedFolders: loadExpandedFolders(),
  folderChildren: {},
  selectedFilePaths: [],
  lastClickedFilePath: null,
  activeFolderContext: '',

  ...(initialSession || {
    tabs: bootstrapConfig ? [{ kind: 'launcher' as const, instanceId: '__launcher__', id: '__launcher__' as const, name: 'Launcher' as const }] : [],
    panes: [{ id: INITIAL_PANE_ID, tabIds: bootstrapConfig ? ['__launcher__'] : [], activeTabId: bootstrapConfig ? '__launcher__' : '', widthRatio: 1 }],
    activePaneId: INITIAL_PANE_ID,
    activeTabId: bootstrapConfig ? '__launcher__' : '',
  }),
  notebookMode: 'command',
  clipboardCell: null,
  deletedCellStack: [],
  scrollSignal: null,
  inlineAI: {},

  initialize: async () => {
    if (get().initialized || initializing) return;
    initializing = true;
    warmupDraftStorage();
    preloadWorkspaceEditors(get().workspaceRoot);
    wsClient.connect();
    wsClient.subscribe((msg) => get().handleWSMessage(msg));
    const startupPanes = get().panes;

    try {
      const [cfg, listing] = await Promise.all([api.getConfig(), api.listDir('', false)]);
      persistAppearance(cfg);
      const localTheme = window.localStorage.getItem('saturno_theme');
      const resolvedTheme = normalizeThemeId(localTheme || cfg.theme);
      document.documentElement.setAttribute('data-theme', resolvedTheme);
      window.localStorage.setItem('saturno_theme', resolvedTheme);

      const fontSize = cfg.editor_font_size || get().editorFontSize || 14;
      document.documentElement.style.setProperty('--sat-editor-font-size', `${fontSize}px`);

      const sessionShell = initialWorkspaceSession(listing.workspace_root);
      const navigatedDuringStartup = get().panes !== startupPanes;
      set({
        ...(navigatedDuringStartup ? {} : sessionShell || (get().tabs.length ? {} : {
          tabs: [{ kind: 'launcher' as const, instanceId: '__launcher__', id: '__launcher__' as const, name: 'Launcher' as const }],
          panes: [{ id: INITIAL_PANE_ID, tabIds: ['__launcher__'], activeTabId: '__launcher__', widthRatio: 1 }],
          activePaneId: INITIAL_PANE_ID, activeTabId: '__launcher__',
        })),
        initialized: true,
        config: { ...cfg, theme: resolvedTheme },
        notebookLayout: cfg.notebook_layout || get().notebookLayout,
        sidebarPosition: cfg.sidebar_position || get().sidebarPosition,
        sidebarWidth: cfg.sidebar_width || get().sidebarWidth,
        showLineNumbers: cfg.show_line_numbers ?? true,
        autoScrollOnRun: cfg.auto_scroll_on_run ?? true,
        showModifiedTime: cfg.show_modified_time ?? true,
        confirmKernelRestart: cfg.confirm_kernel_restart ?? false,
        autoSave: cfg.auto_save ?? true,
        autoSaveDelay: cfg.auto_save_delay || 2000,
        editorFontSize: fontSize,
        showMinimap: cfg.show_minimap ?? true,
        minimapWidth: cfg.minimap_width
          ? Math.max(72, Math.min(200, Math.round(cfg.minimap_width)))
          : get().minimapWidth,
        minimapShowOutputs: cfg.minimap_show_outputs ?? true,
        tableOutputSettings: cfg.table_output
          ? normalizeTableOutputSettings(cfg.table_output)
          : get().tableOutputSettings,
        workspaceRoot: listing.workspace_root,
        currentDir: listing.current_path,
        files: listing.items,
      });

      // Load any previously expanded folders in background without blocking
      const expandedKeys = Object.keys(get().expandedFolders).filter(
        (k) => get().expandedFolders[k]
      );
      if (expandedKeys.length > 0) {
        Promise.all(
          expandedKeys.map((p) =>
            api
              .listDir(p, false)
              .then((res) => [p, res.items] as const)
              .catch(() => null)
          )
        ).then((results) => {
          const patch: Record<string, FileEntry[]> = {};
          for (const r of results) {
            if (r) patch[r[0]] = r[1];
          }
          if (Object.keys(patch).length > 0) {
            set((s) => ({ folderChildren: { ...s.folderChildren, ...patch } }));
          }
        });
      }

      const initialPanes = get().panes;
      const restored = await restoreWorkspaceSession(listing.workspace_root, cfg.output_display === 'collapsed');
      sessionPersistenceReady = true;
      // A user may open a tab or switch workspaces while reads are pending.
      if (get().workspaceRoot !== listing.workspace_root) return;
      if (restored) {
        set(!navigatedDuringStartup && get().panes === initialPanes ? restored : { ...restored, ...reconcileRestoredSession(get(), restored) });
        const currentActive = get().tabs.find(t => t.id === get().activeTabId);
        if (currentActive?.kind === 'notebook' && currentActive.kernelStatus === 'not_started') {
          void api.startKernel(currentActive.path).then((kres) => {
            set((s) => ({
              tabs: s.tabs.map((t) => t.id === currentActive.id && t.kind === 'notebook'
                ? { ...t, kernelStatus: kres.status as any, variables: kres.variables || t.variables }
                : t),
            }));
          }).catch(() => {});
        }
        return;
      }

      // Auto-open welcome only when there is no previous session.
      const welcome = listing.items.find(
        (i) => i.type === 'notebook' && i.name.toLowerCase().includes('bem_vindo')
      );
      if (welcome) {
        await get().openNotebookByPath(welcome.path);
      }
    } catch (err: any) {
      set({ initialized: true, statusMessage: `Erro ao inicializar: ${err.message}` });
    } finally {
      initializing = false;
      if (sessionPersistenceReady) {
        saveWorkspaceSession(get());
        syncDirtyTabsTimers(get());
      }
    }
  },

  updateConfig: async (patch) => {
    if (patch.theme) {
      document.documentElement.setAttribute('data-theme', normalizeThemeId(patch.theme));
    }
    if (patch.editor_font_size) {
      document.documentElement.style.setProperty(
        '--sat-editor-font-size',
        `${patch.editor_font_size}px`
      );
    }
    const updated = await api.updateConfig(patch);
    persistAppearance(updated);
    const resolvedTheme = normalizeThemeId(updated.theme || patch.theme);
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    set((s) => ({
      config: { ...updated, theme: resolvedTheme },
      notebookLayout: updated.notebook_layout || s.notebookLayout,
      sidebarPosition: updated.sidebar_position || s.sidebarPosition,
      sidebarWidth: updated.sidebar_width || s.sidebarWidth,
      showLineNumbers: updated.show_line_numbers ?? s.showLineNumbers,
      autoScrollOnRun: updated.auto_scroll_on_run ?? s.autoScrollOnRun,
      showModifiedTime: updated.show_modified_time ?? s.showModifiedTime,
      confirmKernelRestart: updated.confirm_kernel_restart ?? s.confirmKernelRestart,
      autoSave: updated.auto_save ?? s.autoSave,
      autoSaveDelay: updated.auto_save_delay || s.autoSaveDelay,
      editorFontSize: updated.editor_font_size || s.editorFontSize,
      showMinimap: updated.show_minimap ?? s.showMinimap,
      minimapWidth: updated.minimap_width
        ? Math.max(72, Math.min(200, Math.round(updated.minimap_width)))
        : s.minimapWidth,
      minimapShowOutputs: updated.minimap_show_outputs ?? s.minimapShowOutputs,
      tableOutputSettings: updated.table_output
        ? normalizeTableOutputSettings(updated.table_output)
        : s.tableOutputSettings,
      statusMessage: 'Configurações salvas',
    }));
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
      // Keep optimistic DOM theme
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

  setNotebookLayout: (layout) => {
    window.localStorage.setItem('saturno_nb_layout', layout);
    set({ notebookLayout: layout });
    api.updateConfig({ notebook_layout: layout }).catch(() => {});
  },

  toggleNotebookLayout: () => {
    const next = get().notebookLayout === 'centered' ? 'expanded' : 'centered';
    get().setNotebookLayout(next);
  },

  setSidebarPosition: (pos) => {
    window.localStorage.setItem('saturno_sidebar_pos', pos);
    set({ sidebarPosition: pos });
    api.updateConfig({ sidebar_position: pos }).catch(() => {});
  },

  toggleSidebarPosition: () => {
    const next = get().sidebarPosition === 'left' ? 'right' : 'left';
    get().setSidebarPosition(next);
  },

  setSidebarWidth: (width, persist = false) => {
    const clamped = Math.max(180, Math.min(640, Math.round(width)));
    set({ sidebarWidth: clamped });
    if (persist) {
      window.localStorage.setItem('saturno_sidebar_width', String(clamped));
      api.updateConfig({ sidebar_width: clamped }).catch(() => {});
    }
  },

  setEditorFontSize: (size) => {
    const clamped = Math.max(11, Math.min(22, Math.round(size)));
    window.localStorage.setItem('saturno_font_size', String(clamped));
    document.documentElement.style.setProperty('--sat-editor-font-size', `${clamped}px`);
    set({ editorFontSize: clamped });
    api.updateConfig({ editor_font_size: clamped }).catch(() => {});
  },

  setAutoScrollOnRun: (v) => {
    set({ autoScrollOnRun: v });
    api.updateConfig({ auto_scroll_on_run: v }).catch(() => {});
  },

  setShowModifiedTime: (v) => {
    set({ showModifiedTime: v });
    api.updateConfig({ show_modified_time: v }).catch(() => {});
  },

  setConfirmKernelRestart: (v) => {
    set({ confirmKernelRestart: v });
    api.updateConfig({ confirm_kernel_restart: v }).catch(() => {});
  },

  setAutoSave: (v) => {
    try {
      window.localStorage.setItem('saturno_auto_save', String(v));
    } catch {
      // ignore
    }
    set({
      autoSave: v,
      statusMessage: v ? 'Salvamento automático ativado' : 'Salvamento automático desativado',
    });
    api.updateConfig({ auto_save: v }).catch(() => {});
  },

  setAutoSaveDelay: (ms) => {
    const clamped = Math.max(500, Math.min(60000, Math.round(ms)));
    try {
      window.localStorage.setItem('saturno_auto_save_delay', String(clamped));
    } catch {
      // ignore
    }
    set({ autoSaveDelay: clamped });
    api.updateConfig({ auto_save_delay: clamped }).catch(() => {});
  },

  setShowMinimap: (v) => {
    try {
      window.localStorage.setItem('saturno_show_minimap', String(v));
    } catch {
      // ignore
    }
    set({
      showMinimap: v,
      statusMessage: v ? 'Minimapa ativado' : 'Minimapa oculto',
    });
    api.updateConfig({ show_minimap: v }).catch(() => {});
  },

  toggleMinimap: () => {
    get().setShowMinimap(!get().showMinimap);
  },

  setMinimapWidth: (width, persist = false) => {
    const clamped = Math.max(72, Math.min(200, Math.round(width)));
    set({ minimapWidth: clamped });
    if (persist) {
      try {
        window.localStorage.setItem('saturno_minimap_width', String(clamped));
      } catch {
        // ignore
      }
      api.updateConfig({ minimap_width: clamped }).catch(() => {});
    }
  },

  setMinimapShowOutputs: (v) => {
    try {
      window.localStorage.setItem('saturno_minimap_show_outputs', String(v));
    } catch {
      // ignore
    }
    set({ minimapShowOutputs: v });
    api.updateConfig({ minimap_show_outputs: v }).catch(() => {});
  },

  setTableOutputSettings: (patch) => {
    const next = normalizeTableOutputSettings({ ...get().tableOutputSettings, ...patch });
    saveStoredTableOutputSettings(next);
    set({ tableOutputSettings: next });
    api.updateConfig({ table_output: next }).catch(() => {});
  },

  setShowFolderModal: (v) => set({ showFolderModal: v }),
  openSettings: (section = 'appearance') =>
    set({
      showSettingsModal: true,
      settingsSection: section,
    }),
  closeSettings: () =>
    set({
      showSettingsModal: false,
    }),

  toggleLineNumbers: () => {
    const next = !get().showLineNumbers;
    set({ showLineNumbers: next, statusMessage: next ? 'Números de linha ativados' : 'Números de linha ocultos' });
    api.updateConfig({ show_line_numbers: next }).catch(() => {});
  },

  setStatusMessage: (msg) => set({ statusMessage: msg }),

  toggleFolderExpanded: (path) => {
    const isNowExpanded = !get().expandedFolders[path];
    set((s) => {
      const next = { ...s.expandedFolders, [path]: isNowExpanded };
      saveExpandedFolders(next);
      return {
        expandedFolders: next,
        activeFolderContext: isNowExpanded ? path : s.activeFolderContext,
      };
    });
    if (isNowExpanded) {
      api
        .listDir(path, false)
        .then((res) => {
          set((s) => ({
            folderChildren: { ...s.folderChildren, [path]: res.items },
          }));
        })
        .catch(() => {});
    }
  },

  setFolderExpanded: (path, expanded) => {
    set((s) => {
      const next = { ...s.expandedFolders, [path]: expanded };
      saveExpandedFolders(next);
      return { expandedFolders: next };
    });
    if (expanded) {
      api
        .listDir(path, false)
        .then((res) => {
          set((s) => ({
            folderChildren: { ...s.folderChildren, [path]: res.items },
          }));
        })
        .catch(() => {});
    }
  },

  collapseAllFolders: () => {
    saveExpandedFolders({});
    set({ expandedFolders: {}, activeFolderContext: '' });
  },

  setActiveFolderContext: (folderPath) => set({ activeFolderContext: folderPath }),

  toggleFileSelection: (path, exclusive = false) => {
    set((s) => {
      if (exclusive) {
        return {
          selectedFilePaths: [path],
          lastClickedFilePath: path,
        };
      }
      const exists = s.selectedFilePaths.includes(path);
      const next = exists
        ? s.selectedFilePaths.filter((p) => p !== path)
        : [...s.selectedFilePaths, path];
      return {
        selectedFilePaths: next,
        lastClickedFilePath: path,
      };
    });
  },

  selectFileRange: (visiblePaths, targetPath) => {
    set((s) => {
      const anchor = s.lastClickedFilePath || targetPath;
      const startIdx = visiblePaths.indexOf(anchor);
      const endIdx = visiblePaths.indexOf(targetPath);
      if (startIdx === -1 || endIdx === -1) {
        return {
          selectedFilePaths: [targetPath],
          lastClickedFilePath: targetPath,
        };
      }
      const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      const rangePaths = visiblePaths.slice(from, to + 1);
      return {
        selectedFilePaths: rangePaths,
        lastClickedFilePath: anchor,
      };
    });
  },

  selectAllFiles: (visiblePaths) => {
    set({ selectedFilePaths: [...visiblePaths] });
  },

  clearFileSelection: () => {
    set({ selectedFilePaths: [], lastClickedFilePath: null });
  },

  refreshFiles: async () => {
    const listing = await api.listDir('', false);
    set({
      workspaceRoot: listing.workspace_root,
      currentDir: listing.current_path,
      files: listing.items,
    });
    const expandedKeys = Object.keys(get().expandedFolders).filter(
      (k) => get().expandedFolders[k]
    );
    if (expandedKeys.length > 0) {
      Promise.all(
        expandedKeys.map((p) =>
          api
            .listDir(p, false)
            .then((res) => [p, res.items] as const)
            .catch(() => null)
        )
      ).then((results) => {
        const patch: Record<string, FileEntry[]> = {};
        for (const r of results) {
          if (r) patch[r[0]] = r[1];
        }
        if (Object.keys(patch).length > 0) {
          set((s) => ({ folderChildren: { ...s.folderChildren, ...patch } }));
        }
      });
    }
  },

  switchWorkspace: async (newPath) => {
    if (restoringSession) return;
    if (get().autoSave && hasUnsavedChanges(get().tabs)) {
      const savableIds = get()
        .tabs.filter(
          (t) =>
            t.kind !== 'launcher' &&
            !t.loading &&
            t.dirty &&
            !(t.kind === 'file' && t.truncated)
        )
        .map((t) => t.id);
      if (savableIds.length > 0) {
        await Promise.allSettled(savableIds.map((id) => get().saveTabById(id, { silent: true })));
      }
    }
    if (hasUnsavedChanges(get().tabs) && !window.confirm('Há alterações não salvas. Trocar de pasta e descartá-las?')) return;
    const prevWorkspaceRoot = get().workspaceRoot;
    const discardedIds = get()
      .tabs.filter((t) => t.kind !== 'launcher' && t.dirty)
      .map((t) => t.id);
    clearAllPersistenceTimers();
    if (prevWorkspaceRoot && discardedIds.length > 0) {
      const discardedSet = new Set(discardedIds);
      void deleteDraftsMatching(prevWorkspaceRoot, (p) => discardedSet.has(p));
    }
    saveWorkspaceSession(get());
    restoringSession = true;
    try {
      const res = await api.switchWorkspace(newPath);
      saveExpandedFolders({});
      set({
        workspaceRoot: res.workspace_root,
        currentDir: '',
        files: res.listing.items,
        expandedFolders: {},
        folderChildren: {},
        tabs: [{ kind: 'launcher', instanceId: '__launcher__', id: '__launcher__', name: 'Launcher' }],
        panes: [
          {
            id: INITIAL_PANE_ID,
            tabIds: ['__launcher__'],
            activeTabId: '__launcher__',
            widthRatio: 1,
          },
        ],
        activePaneId: INITIAL_PANE_ID,
        activeTabId: '__launcher__',
        selectedFilePaths: [],
        activeFolderContext: '',
        showFolderModal: false,
        statusMessage: `Conectado em ${res.workspace_root}`,
        ...initialWorkspaceSession(res.workspace_root),
      });
      const initialPanes = get().panes;
      const restored = await restoreWorkspaceSession(res.workspace_root, get().config?.output_display === 'collapsed');
      sessionPersistenceReady = true;
      if (restored && get().workspaceRoot === res.workspace_root) {
        set(get().panes === initialPanes ? restored : { ...restored, ...reconcileRestoredSession(get(), restored) });
        wsClient.send({ action: 'sync_kernels' });
        const currentActive = get().tabs.find(t => t.id === get().activeTabId);
        if (currentActive?.kind === 'notebook' && currentActive.kernelStatus === 'not_started') {
          void api.startKernel(currentActive.path).then((kres) => {
            set((s) => ({
              tabs: s.tabs.map((t) => t.id === currentActive.id && t.kind === 'notebook'
                ? { ...t, kernelStatus: kres.status as any, variables: kres.variables || t.variables }
                : t),
            }));
          }).catch(() => {});
        }
      }
    } finally {
      restoringSession = false;
      saveWorkspaceSession(get());
      syncDirtyTabsTimers(get());
    }
  },

  openEntry: async (entry, options) => {
    if (entry.type === 'directory') {
      get().toggleFolderExpanded(entry.path);
      return;
    }
    if (entry.type === 'notebook') {
      await get().openNotebookByPath(entry.path, options);
      return;
    }

    const existing = get().tabs.find((t) => t.id === entry.path);
    if (existing) {
      if (options?.sideBySide) {
        get().splitTab(entry.path, options.targetPaneId, 'right');
      } else {
        get().setActiveTab(entry.path, options?.targetPaneId);
      }
      return;
    }

    const workspaceRoot = get().workspaceRoot;
    const [fileData] = await Promise.all([api.readFile(entry.path), loadTextFileView()]);
    const cleanContent = (fileData.content || '').replace(/\r\n/g, '\n');
    const reconciled = await reconcileFileWithDraft({
      workspaceRoot,
      path: fileData.path,
      diskContent: cleanContent,
      diskModified: fileData.modified,
      truncated: fileData.truncated,
    });
    const newTab: WorkspaceTab = {
      kind: 'file',
      instanceId: makeTabInstanceId('file'),
      id: fileData.path,
      path: fileData.path,
      name: fileData.name,
      content: reconciled.content,
      dirty: reconciled.dirty,
      diskModified: fileData.modified,
      truncated: fileData.truncated,
    };

    if (options?.sideBySide) {
      set((s) => ({
        tabs: s.tabs.some((t) => t.id === newTab.id) ? s.tabs : [...s.tabs, newTab],
        ...(reconciled.restored ? { statusMessage: `Rascunho recuperado: ${fileData.name}` } : {}),
      }));
      get().splitTab(newTab.id, options.targetPaneId, 'right');
      return;
    }

    // Single atomic state update for instant tab opening
    set((s) => {
      const targetPaneId = options?.targetPaneId || s.activePaneId || s.panes[0]?.id;
      const nextTabs = s.tabs.some((t) => t.id === newTab.id)
        ? s.tabs
        : [...s.tabs, newTab];
      const nextPanes = s.panes.map((p) => {
        if (p.id !== targetPaneId) return p;
        const nextTabIds = p.tabIds.includes(newTab.id)
          ? p.tabIds
          : [...p.tabIds, newTab.id];
        return { ...p, tabIds: nextTabIds, activeTabId: newTab.id };
      });
      return {
        tabs: nextTabs,
        panes: nextPanes,
        activePaneId: targetPaneId,
        activeTabId: newTab.id,
        ...(reconciled.restored ? { statusMessage: `Rascunho recuperado: ${fileData.name}` } : {}),
      };
    });
  },

  openNotebookByPath: async (relPath, options) => {
    const existing = get().tabs.find((t) => t.id === relPath);
    if (existing) {
      if (options?.sideBySide) {
        get().splitTab(relPath, options.targetPaneId, 'right');
      } else {
        get().setActiveTab(relPath, options?.targetPaneId);
      }
      return;
    }

    const workspaceRoot = get().workspaceRoot;
    const collapseOutputs = get().config?.output_display === 'collapsed';
    set({ statusMessage: `Abrindo ${relPath.split('/').pop()}…` });
    let nb;
    try { [nb] = await Promise.all([api.readNotebook(relPath), loadNotebookView()]); }
    catch (error) { set({ statusMessage: `Erro ao abrir notebook: ${String(error)}` }); throw error; }
    const diskCells: NotebookCellData[] = nb.cells.map((c: any) => {
      const cleanSrc = (c.source || '').replace(/\r\n/g, '\n');
      return {
        ...c,
        source: cleanSrc,
        outputCollapsed: collapseOutputs,
        isRunning: false,
        markdownRendered: c.cell_type === 'markdown' && Boolean(cleanSrc.trim()),
      };
    });
    const reconciled = await reconcileNotebookWithDraft({
      workspaceRoot,
      path: nb.path,
      diskCells,
      diskMetadata: nb.metadata || {},
      diskModified: nb.modified,
      collapseOutputs,
    });
    const inFlightId = nb.active_cell_id || null;
    const cells = inFlightId
      ? reconciled.cells.map((c) =>
          c.id === inFlightId
            ? {
                ...c,
                isRunning: true,
                execution_count:
                  nb.active_execution_count !== undefined && nb.active_execution_count !== null
                    ? nb.active_execution_count
                    : c.execution_count,
                outputs: nb.active_outputs || c.outputs,
              }
            : c
        )
      : reconciled.cells;
    const preferredCellId = reconciled.activeCellId;
    const newTab: OpenNotebookTab = {
      kind: 'notebook',
      instanceId: makeTabInstanceId('notebook'),
      id: nb.path,
      path: nb.path,
      name: nb.name,
      cells,
      metadata: reconciled.metadata,
      dirty: reconciled.dirty,
      diskModified: nb.modified,
      kernelStatus: nb.kernel_status || 'not_started',
      variables: nb.variables || [],
      activeCellId: cells.some((c) => c.id === preferredCellId) ? preferredCellId! : cells[0]?.id || '',
    };

    if (options?.sideBySide) {
      set((s) => ({
        tabs: s.tabs.some((t) => t.id === newTab.id) ? s.tabs : [...s.tabs, newTab],
        notebookMode: 'command',
      }));
      get().splitTab(newTab.id, options.targetPaneId, 'right');
    } else {
      // Single atomic state update for instant notebook opening
      set((s) => {
        const targetPaneId = options?.targetPaneId || s.activePaneId || s.panes[0]?.id;
        const nextTabs = s.tabs.some((t) => t.id === newTab.id)
          ? s.tabs
          : [...s.tabs, newTab];
        const nextPanes = s.panes.map((p) => {
          if (p.id !== targetPaneId) return p;
          const nextTabIds = p.tabIds.includes(newTab.id)
            ? p.tabIds
            : [...p.tabIds, newTab.id];
          return { ...p, tabIds: nextTabIds, activeTabId: newTab.id };
        });
        return {
          tabs: nextTabs,
          panes: nextPanes,
          activePaneId: targetPaneId,
          activeTabId: newTab.id,
          notebookMode: 'command',
        };
      });
    }

    set({
      statusMessage: reconciled.restored ? `Rascunho recuperado: ${nb.name}` : 'Pronto',
    });

    // Defer kernel warm-up slightly so UI rendering and file clicks have zero contention
    if (!nb.kernel_status || nb.kernel_status === 'not_started' || nb.kernel_status === 'stopped') {
      window.setTimeout(() => {
        api
          .startKernel(nb.path)
        .then((kres) => {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.kind === 'notebook' && t.path === nb.path
                ? {
                    ...t,
                    kernelStatus: kres.status as any,
                    variables: kres.variables || t.variables,
                  }
                : t
            ),
          }));
        })
          .catch(() => {});
      }, 120);
    }
  },

  createNewNotebook: async (folder, name) => {
    const targetFolder = folder !== undefined ? folder : get().activeFolderContext || '';
    const nb = await api.createNotebook(targetFolder, name);
    if (targetFolder) {
      get().setFolderExpanded(targetFolder, true);
    }
    get().refreshFiles();
    await get().openNotebookByPath(nb.path);
    set({ statusMessage: `Notebook criado: ${nb.name}` });
  },

  createNewFile: async (folder, name = 'script.py') => {
    const targetFolder = folder !== undefined ? folder : get().activeFolderContext || '';
    const fileData = await api.createFile(targetFolder, name);
    const normalizedContent = (fileData.content || '').replace(/\r\n/g, '\n');
    if (targetFolder) {
      get().setFolderExpanded(targetFolder, true);
    }
    get().refreshFiles();
    set((s) => {
      const targetPaneId = s.activePaneId || s.panes[0]?.id;
      const nextPanes = s.panes.map((p) =>
        p.id === targetPaneId
          ? {
              ...p,
              tabIds: p.tabIds.includes(fileData.path)
                ? p.tabIds
                : [...p.tabIds, fileData.path],
              activeTabId: fileData.path,
            }
          : p
      );
      return {
        tabs: [
          ...s.tabs,
          {
            kind: 'file',
            instanceId: makeTabInstanceId('file'),
            id: fileData.path,
            path: fileData.path,
            name: fileData.name,
            content: normalizedContent,
            dirty: false,
            diskModified: fileData.modified,
            truncated: fileData.truncated,
          },
        ],
        panes: nextPanes,
        activePaneId: targetPaneId,
        activeTabId: fileData.path,
        statusMessage: `Arquivo criado: ${fileData.name}`,
      };
    });
  },

  createNewFolder: async (name, parentFolder) => {
    const targetFolder =
      parentFolder !== undefined ? parentFolder : get().activeFolderContext || '';
    const res = await api.createFolder(targetFolder, name);
    if (targetFolder) {
      get().setFolderExpanded(targetFolder, true);
    }
    get().setFolderExpanded(res.path, true);
    await get().refreshFiles();
    set({ statusMessage: `Pasta criada: ${name}` });
  },

  renameEntry: async (oldPath, newName) => {
    const workspaceRoot = get().workspaceRoot;
    const res = await api.renameEntry(oldPath, newName);
    const remapOne = (p: string) => remapPathPrefix(p, oldPath, res.new_path);
    for (const t of get().tabs) {
      if (t.kind !== 'launcher' && remapOne(t.id)) {
        cancelDraftTimer(t.id);
        cancelAutoSaveTimer(t.id);
      }
    }
    void remapDraftPaths(workspaceRoot, remapOne);
    set((s) => {
      const nextExpanded: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(s.expandedFolders)) {
        const mapped = remapOne(k);
        nextExpanded[mapped ?? k] = v;
      }
      saveExpandedFolders(nextExpanded);

      const nextChildren: Record<string, FileEntry[]> = {};
      for (const [k, v] of Object.entries(s.folderChildren)) {
        const mapped = remapOne(k);
        nextChildren[mapped ?? k] = remapFileEntries(v, remapOne);
      }

      const tabIdMap = new Map<string, string>();
      const updatedTabs = s.tabs.map((t) => {
        if (t.kind === 'launcher') return t;
        const mappedPath = remapOne(t.id);
        if (!mappedPath) return t;
        tabIdMap.set(t.id, mappedPath);
        const nextTitle = t.id === oldPath ? res.name : t.name;
        if (t.kind === 'notebook') {
          return {
            ...t,
            id: mappedPath,
            path: mappedPath,
            name: nextTitle,
            kernelStatus: 'stopped',
            variables: [],
            cells: t.cells.map((c) => ({ ...c, isRunning: false })),
          } as WorkspaceTab;
        }
        return {
          ...t,
          id: mappedPath,
          path: mappedPath,
          name: nextTitle,
        } as WorkspaceTab;
      });

      const updatedPanes = s.panes.map((p) => ({
        ...p,
        tabIds: p.tabIds.map((id) => tabIdMap.get(id) ?? id),
        activeTabId: tabIdMap.get(p.activeTabId) ?? p.activeTabId,
      }));

      const nextFolderCtx = remapOne(s.activeFolderContext) ?? s.activeFolderContext;
      const nextDeletedStack = s.deletedCellStack.map((r) => {
        const mapped = remapOne(r.notebookPath);
        return mapped ? { ...r, notebookPath: mapped } : r;
      });

      return {
        tabs: updatedTabs,
        panes: updatedPanes,
        activeTabId: tabIdMap.get(s.activeTabId) ?? s.activeTabId,
        expandedFolders: nextExpanded,
        folderChildren: nextChildren,
        activeFolderContext: nextFolderCtx,
        deletedCellStack: nextDeletedStack,
        selectedFilePaths: s.selectedFilePaths.map((p) => remapOne(p) ?? p),
        lastClickedFilePath: s.lastClickedFilePath
          ? remapOne(s.lastClickedFilePath) ?? s.lastClickedFilePath
          : null,
        statusMessage: `Renomeado para ${res.name}`,
      };
    });
    await get().refreshFiles();
  },

  deleteEntry: async (relPath) => {
    const workspaceRoot = get().workspaceRoot;
    await api.deleteEntry(relPath);
    void deleteDraftsMatching(workspaceRoot, (p) => isPathOrDescendant(p, relPath));
    const affectedTabIds = get()
      .tabs.filter((t) => t.kind !== 'launcher' && isPathOrDescendant(t.id, relPath))
      .map((t) => t.id);
    for (const tid of affectedTabIds) {
      get().closeTab(tid);
    }
    set((s) => {
      const nextExpanded: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(s.expandedFolders)) {
        if (!isPathOrDescendant(k, relPath)) nextExpanded[k] = v;
      }
      saveExpandedFolders(nextExpanded);
      const nextChildren: Record<string, FileEntry[]> = {};
      for (const [k, v] of Object.entries(s.folderChildren)) {
        if (!isPathOrDescendant(k, relPath)) nextChildren[k] = v;
      }
      return {
        expandedFolders: nextExpanded,
        folderChildren: nextChildren,
        activeFolderContext: isPathOrDescendant(s.activeFolderContext, relPath)
          ? ''
          : s.activeFolderContext,
        selectedFilePaths: s.selectedFilePaths.filter((p) => !isPathOrDescendant(p, relPath)),
        statusMessage: `Removido: ${relPath}`,
      };
    });
    await get().refreshFiles();
  },

  deleteBatchEntries: async (paths) => {
    if (!paths.length) return;
    const workspaceRoot = get().workspaceRoot;
    const res = await api.deleteBatch(paths);
    void deleteDraftsMatching(workspaceRoot, (p) =>
      paths.some((deleted) => isPathOrDescendant(p, deleted))
    );
    const affectedTabIds = get()
      .tabs.filter(
        (t) =>
          t.kind !== 'launcher' && paths.some((deleted) => isPathOrDescendant(t.id, deleted))
      )
      .map((t) => t.id);
    for (const tid of affectedTabIds) {
      get().closeTab(tid);
    }
    set((s) => {
      const nextExpanded: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(s.expandedFolders)) {
        if (!paths.some((deleted) => isPathOrDescendant(k, deleted))) nextExpanded[k] = v;
      }
      saveExpandedFolders(nextExpanded);
      const nextChildren: Record<string, FileEntry[]> = {};
      for (const [k, v] of Object.entries(s.folderChildren)) {
        if (!paths.some((deleted) => isPathOrDescendant(k, deleted))) nextChildren[k] = v;
      }
      return {
        expandedFolders: nextExpanded,
        folderChildren: nextChildren,
        activeFolderContext: paths.some((deleted) =>
          isPathOrDescendant(s.activeFolderContext, deleted)
        )
          ? ''
          : s.activeFolderContext,
        selectedFilePaths: [],
        lastClickedFilePath: null,
        statusMessage: `${res.deleted.length} item(ns) removido(s)`,
      };
    });
    await get().refreshFiles();
  },

  moveEntries: async (paths, targetFolder) => {
    if (!paths.length) return;
    const workspaceRoot = get().workspaceRoot;
    const res = await api.moveEntries(paths, targetFolder);
    if (targetFolder) {
      get().setFolderExpanded(targetFolder, true);
    }

    const moveMap = new Map(res.moved.map((m) => [m.old_path, m]));
    // Moving a folder also changes the identity of every open descendant.
    for (const tab of get().tabs) {
      const parent = res.moved.find((m) => tab.id.startsWith(m.old_path + '/'));
      if (parent) {
        moveMap.set(tab.id, {
          old_path: tab.id,
          new_path: parent.new_path + tab.id.slice(parent.old_path.length),
          name: tab.name,
        });
      }
    }
    for (const oldId of moveMap.keys()) {
      cancelDraftTimer(oldId);
      cancelAutoSaveTimer(oldId);
    }
    const remapMoved = (p: string) => {
      const hit = res.moved.find((m) => isPathOrDescendant(p, m.old_path));
      return hit ? remapPathPrefix(p, hit.old_path, hit.new_path) : null;
    };
    void remapDraftPaths(workspaceRoot, remapMoved);
    set((s) => {
      const nextExpanded: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(s.expandedFolders)) {
        const mapped = remapMoved(k);
        nextExpanded[mapped ?? k] = v;
      }
      saveExpandedFolders(nextExpanded);

      const nextChildren: Record<string, FileEntry[]> = {};
      for (const [k, v] of Object.entries(s.folderChildren)) {
        const mapped = remapMoved(k);
        nextChildren[mapped ?? k] = remapFileEntries(v, remapMoved);
      }

      const nextFolderCtx = remapMoved(s.activeFolderContext) ?? s.activeFolderContext;
      const nextDeletedStack = s.deletedCellStack.map((r) => {
        const mapped = remapMoved(r.notebookPath);
        return mapped ? { ...r, notebookPath: mapped } : r;
      });

      const updatedTabs = s.tabs.map((t) => {
        const m = moveMap.get(t.id);
        return m
          ? ({
              ...t,
              id: m.new_path,
              path: m.new_path,
              name: m.name,
              ...(t.kind === 'notebook'
                ? {
                    kernelStatus: 'stopped',
                    variables: [],
                    cells: t.cells.map((c) => ({ ...c, isRunning: false })),
                  }
                : {}),
            } as WorkspaceTab)
          : t;
      });
      const updatedPanes = s.panes.map((p) => ({
        ...p,
        tabIds: p.tabIds.map((id) => moveMap.get(id)?.new_path || id),
        activeTabId: moveMap.get(p.activeTabId)?.new_path || p.activeTabId,
      }));
      return {
        tabs: updatedTabs,
        panes: updatedPanes,
        activeTabId: moveMap.get(s.activeTabId)?.new_path || s.activeTabId,
        expandedFolders: nextExpanded,
        folderChildren: nextChildren,
        activeFolderContext: nextFolderCtx,
        deletedCellStack: nextDeletedStack,
        selectedFilePaths: [],
        lastClickedFilePath: null,
        statusMessage: `${res.moved.length} item(ns) movido(s) para ${targetFolder || '/'}`,
      };
    });
    await get().refreshFiles();
  },

  setActivePane: (paneId) => {
    set((s) => {
      const pane = s.panes.find((p) => p.id === paneId);
      if (!pane) return s;
      return {
        activePaneId: pane.id,
        activeTabId: pane.activeTabId,
      };
    });
  },

  setActiveTab: (id, paneId) => {
    set((s) => {
      const targetPaneId = paneId || s.activePaneId || s.panes[0]?.id;
      const paneContainsTab = s.panes.find((p) => p.id === targetPaneId && p.tabIds.includes(id));

      // If no specific pane was forced and the tab is already open in another pane, focus that pane
      if (!paneId && !paneContainsTab) {
        const otherPane = s.panes.find((p) => p.tabIds.includes(id));
        if (otherPane) {
          return {
            activePaneId: otherPane.id,
            activeTabId: id,
            panes: s.panes.map((p) =>
              p.id === otherPane.id ? { ...p, activeTabId: id } : p
            ),
          };
        }
      }

      const nextPanes = s.panes.map((p) => {
        if (p.id !== targetPaneId) return p;
        const nextTabIds = p.tabIds.includes(id) ? p.tabIds : [...p.tabIds, id];
        return {
          ...p,
          tabIds: nextTabIds,
          activeTabId: id,
        };
      });

      return {
        panes: nextPanes,
        activePaneId: targetPaneId,
        activeTabId: id,
      };
    });
  },

  closeTab: (id, paneId) => {
    set((s) => {
      let nextPanes = s.panes.map((p) => {
        if (paneId && p.id !== paneId) return p;
        if (!p.tabIds.includes(id)) return p;
        const remainingIds = p.tabIds.filter((tid) => tid !== id);
        const nextActive =
          p.activeTabId === id
            ? remainingIds[remainingIds.length - 1] || ''
            : p.activeTabId;
        return {
          ...p,
          tabIds: remainingIds,
          activeTabId: nextActive,
        };
      });

      // Remove empty panes if more than 1 pane exists
      if (nextPanes.length > 1) {
        nextPanes = nextPanes.filter((p) => p.tabIds.length > 0);
      }

      const allEmpty = nextPanes.length === 0 || nextPanes.every((p) => p.tabIds.length === 0);
      const stillReferenced = !allEmpty && nextPanes.some((p) => p.tabIds.includes(id));

      let nextInlineAI = s.inlineAI;
      let nextDeletedStack = s.deletedCellStack;
      if (!stillReferenced) {
        cancelDraftTimer(id);
        cancelAutoSaveTimer(id);
        if (s.workspaceRoot) {
          void deleteDraft(s.workspaceRoot, id);
        }
        const closingTab = s.tabs.find((t) => t.id === id);
        if (closingTab?.kind === 'notebook') {
          let aiMutated = false;
          const aiCopy = { ...s.inlineAI };
          for (const cell of closingTab.cells) {
            const aiSt = aiCopy[cell.id];
            if (aiSt) {
              if (aiSt.status === 'streaming' && aiSt.requestId) {
                wsClient.send({ action: 'ai_cancel', request_id: aiSt.requestId });
              }
              delete aiCopy[cell.id];
              aiMutated = true;
            }
          }
          if (aiMutated) nextInlineAI = aiCopy;
          if (s.deletedCellStack.some((r) => r.notebookPath === closingTab.path)) {
            nextDeletedStack = s.deletedCellStack.filter(
              (r) => r.notebookPath !== closingTab.path
            );
          }
        }
      }

      // If all panes became empty, restore Launcher in a single pane
      if (allEmpty) {
        const launcherTab: WorkspaceTab = {
          kind: 'launcher',
          instanceId: '__launcher__',
          id: '__launcher__',
          name: 'Launcher',
        };
        const hasLauncher = s.tabs.some((t) => t.id === '__launcher__');
        const nextTabs = (hasLauncher ? s.tabs : [...s.tabs, launcherTab]).filter(
          (t) => t.id === '__launcher__' || t.id !== id
        );
        return {
          tabs: nextTabs,
          panes: [
            {
              id: INITIAL_PANE_ID,
              tabIds: ['__launcher__'],
              activeTabId: '__launcher__',
              widthRatio: 1,
            },
          ],
          activePaneId: INITIAL_PANE_ID,
          activeTabId: '__launcher__',
          inlineAI: nextInlineAI,
          deletedCellStack: nextDeletedStack,
        };
      }

      const nextTabs = stillReferenced ? s.tabs : s.tabs.filter((t) => t.id !== id);
      const currentActivePane =
        nextPanes.find((p) => p.id === s.activePaneId) || nextPanes[nextPanes.length - 1];

      return {
        tabs: nextTabs,
        panes: nextPanes,
        activePaneId: currentActivePane.id,
        activeTabId: currentActivePane.activeTabId,
        inlineAI: nextInlineAI,
        deletedCellStack: nextDeletedStack,
      };
    });
  },

  splitTab: (tabId, sourcePaneId, direction = 'right', originPaneId) => {
    set((s) => {
      const targetTabId = tabId || s.activeTabId;
      if (!targetTabId) return s;

      const srcPane =
        s.panes.find((p) => p.id === (sourcePaneId || s.activePaneId)) || s.panes[0];

      // Dragged from a different pane onto left/right edge of srcPane: create a split next to srcPane
      // and detach from originPaneId cleanly (dropping originPaneId if it becomes empty).
      if (originPaneId && originPaneId !== srcPane.id) {
        const newPaneId = `pane_${makeId()}`;
        const newPane: EditorPane = {
          id: newPaneId,
          tabIds: [targetTabId],
          activeTabId: targetTabId,
          widthRatio: 1,
        };
        const mapped = s.panes.map((p) => {
          if (p.id !== originPaneId) return p;
          const rem = p.tabIds.filter((id) => id !== targetTabId);
          return {
            ...p,
            tabIds: rem,
            activeTabId: p.activeTabId === targetTabId ? rem[rem.length - 1] || '' : p.activeTabId,
          };
        });
        const srcIdx = mapped.findIndex((p) => p.id === srcPane.id);
        if (direction === 'left') {
          mapped.splice(srcIdx, 0, newPane);
        } else {
          mapped.splice(srcIdx + 1, 0, newPane);
        }
        const cleaned = mapped.filter((p) => p.tabIds.length > 0);
        return {
          panes: cleaned,
          activePaneId: newPaneId,
          activeTabId: targetTabId,
          statusMessage: 'Visualização dividida lado a lado',
        };
      }

      // If we already have 2+ panes and direction points to an existing other pane when invoked without creating a 3rd pane:
      if (s.panes.length >= 2 && sourcePaneId) {
        const srcIdx = s.panes.findIndex((p) => p.id === srcPane.id);
        const destIdx = direction === 'right' ? srcIdx + 1 : srcIdx - 1;
        if (destIdx >= 0 && destIdx < s.panes.length) {
          const destPane = s.panes[destIdx];
          let nextPanes = s.panes.map((p) => {
            if (p.id === srcPane.id && p.tabIds.length > 1) {
              const rem = p.tabIds.filter((id) => id !== targetTabId);
              return {
                ...p,
                tabIds: rem,
                activeTabId: p.activeTabId === targetTabId ? rem[rem.length - 1] : p.activeTabId,
              };
            }
            if (p.id === destPane.id) {
              const nextIds = p.tabIds.includes(targetTabId)
                ? p.tabIds
                : [...p.tabIds, targetTabId];
              return { ...p, tabIds: nextIds, activeTabId: targetTabId };
            }
            return p;
          });
          return {
            panes: nextPanes,
            activePaneId: destPane.id,
            activeTabId: targetTabId,
          };
        }
      }

      // Create a new split pane
      const newPaneId = `pane_${makeId()}`;
      const newPane: EditorPane = {
        id: newPaneId,
        tabIds: [targetTabId],
        activeTabId: targetTabId,
        widthRatio: 1,
      };

      const updatedSrcPane: EditorPane =
        srcPane.tabIds.includes(targetTabId) && srcPane.tabIds.length > 1
          ? {
              ...srcPane,
              tabIds: srcPane.tabIds.filter((id) => id !== targetTabId),
              activeTabId:
                srcPane.activeTabId === targetTabId
                  ? srcPane.tabIds.filter((id) => id !== targetTabId).slice(-1)[0]
                  : srcPane.activeTabId,
            }
          : srcPane;

      const srcIdx = s.panes.findIndex((p) => p.id === srcPane.id);
      const nextPanes = [...s.panes];
      nextPanes[srcIdx] = updatedSrcPane;
      if (direction === 'left') {
        nextPanes.splice(srcIdx, 0, newPane);
      } else {
        nextPanes.splice(srcIdx + 1, 0, newPane);
      }

      return {
        panes: nextPanes,
        activePaneId: newPaneId,
        activeTabId: targetTabId,
        statusMessage: 'Visualização dividida lado a lado',
      };
    });
  },

  moveTabToPane: (tabId, sourcePaneId, targetPaneId) => {
    if (sourcePaneId === targetPaneId) {
      get().setActiveTab(tabId, targetPaneId);
      return;
    }
    set((s) => {
      let nextPanes = s.panes.map((p) => {
        if (p.id === sourcePaneId) {
          const rem = p.tabIds.filter((id) => id !== tabId);
          return {
            ...p,
            tabIds: rem,
            activeTabId: p.activeTabId === tabId ? rem[rem.length - 1] || '' : p.activeTabId,
          };
        }
        if (p.id === targetPaneId) {
          const nextIds = p.tabIds.includes(tabId) ? p.tabIds : [...p.tabIds, tabId];
          return {
            ...p,
            tabIds: nextIds,
            activeTabId: tabId,
          };
        }
        return p;
      });

      if (nextPanes.length > 1) {
        nextPanes = nextPanes.filter((p) => p.tabIds.length > 0);
      }

      return {
        panes: nextPanes,
        activePaneId: targetPaneId,
        activeTabId: tabId,
      };
    });
  },

  closePane: (paneId) => {
    set((s) => {
      if (s.panes.length <= 1) return s;
      const paneToClose = s.panes.find((p) => p.id === paneId);
      if (!paneToClose) return s;
      const remainingPanes = s.panes.filter((p) => p.id !== paneId);
      const fallbackPane = remainingPanes[remainingPanes.length - 1];

      // Merge any tabs that were only in paneToClose into fallbackPane so user doesn't lose open tabs
      const mergedTabIds = [...fallbackPane.tabIds];
      for (const tid of paneToClose.tabIds) {
        const inOther = remainingPanes.some((rp) => rp.tabIds.includes(tid));
        if (!inOther && !mergedTabIds.includes(tid)) {
          mergedTabIds.push(tid);
        }
      }

      const finalPanes = remainingPanes.map((p) =>
        p.id === fallbackPane.id ? { ...p, tabIds: mergedTabIds } : p
      );

      const nextActivePane =
        s.activePaneId === paneId
          ? finalPanes[finalPanes.length - 1]
          : finalPanes.find((p) => p.id === s.activePaneId) || finalPanes[0];

      return {
        panes: finalPanes,
        activePaneId: nextActivePane.id,
        activeTabId: nextActivePane.activeTabId,
      };
    });
  },

  setPaneWidths: (ratios) => {
    set((s) => ({
      panes: s.panes.map((p) =>
        ratios[p.id] !== undefined ? { ...p, widthRatio: Math.max(0.15, ratios[p.id]) } : p
      ),
    }));
  },

  openLauncher: (paneId) => {
    const existing = get().tabs.find((t) => t.kind === 'launcher');
    if (!existing) {
      set((s) => ({
        tabs: [...s.tabs, { kind: 'launcher', instanceId: '__launcher__', id: '__launcher__', name: 'Launcher' }],
      }));
    }
    get().setActiveTab('__launcher__', paneId || get().activePaneId);
  },

  saveActiveTab: async () => {
    flushAllPendingEditors();
    await get().saveTabById(get().activeTabId);
  },

  saveTabById: async (tabId, options) => {
    flushAllPendingEditors();
    const silent = Boolean(options?.silent);
    const workspaceRoot = get().workspaceRoot;
    if (!workspaceRoot) return;
    const inflightKey = `${workspaceRoot}\0${tabId}`;
    const existingFlight = inFlightSaves.get(inflightKey);
    if (existingFlight) {
      await existingFlight;
      if (get().workspaceRoot !== workspaceRoot) return;
      const after = get().tabs.find((t) => t.id === tabId);
      if (!after || after.kind === 'launcher' || after.loading) return;
      if (silent && !after.dirty) return;
    }

    const runSave = async () => {
      cancelAutoSaveTimer(tabId);
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind === 'launcher' || tab.loading) return;
      if (tab.kind === 'file' && tab.truncated) {
        if (!silent) {
          set({
            statusMessage: `Arquivo grande (> 512 KB) em modo somente leitura: ${tab.name}`,
          });
        }
        return;
      }
      if (silent && !tab.dirty) return;

      try {
        if (tab.kind === 'notebook') {
          const res = await api.saveNotebook(tab.path, tab.cells, tab.metadata);
          if (get().workspaceRoot !== workspaceRoot) return;
          let becameClean = false;
          set((s) => {
            const nextTabs = s.tabs.map((t) => {
              if (t.id !== tab.id || t.kind !== 'notebook') return t;
              const unchanged = t.cells === tab.cells && t.metadata === tab.metadata;
              if (unchanged) becameClean = true;
              return {
                ...t,
                diskModified: res.modified || t.diskModified,
                dirty: unchanged ? false : t.dirty,
              };
            });
            const treePatch = s.showModifiedTime
              ? patchEntryModified(s.files, s.folderChildren, tab.path, res.modified)
              : {};
            return {
              tabs: nextTabs,
              ...treePatch,
              ...(silent ? {} : { statusMessage: `Salvo: ${tab.name}` }),
            };
          });
          if (becameClean) {
            cancelDraftTimer(tab.id);
            void deleteDraft(workspaceRoot, tab.path);
          } else if (get().autoSave) {
            scheduleAutoSave(tab.id, get().autoSaveDelay);
          }
// patchEntryModified updates tree timestamps without triggering N listDir requests
        } else if (tab.kind === 'file') {
          const res = await api.saveFile(tab.path, tab.content);
          if (get().workspaceRoot !== workspaceRoot) return;
          let becameClean = false;
          set((s) => {
            const nextTabs = s.tabs.map((t) => {
              if (t.id !== tab.id || t.kind !== 'file') return t;
              const unchanged = t.content === tab.content;
              if (unchanged) becameClean = true;
              return {
                ...t,
                diskModified: res.modified || t.diskModified,
                dirty: unchanged ? false : t.dirty,
              };
            });
            const treePatch = s.showModifiedTime
              ? patchEntryModified(s.files, s.folderChildren, tab.path, res.modified)
              : {};
            return {
              tabs: nextTabs,
              ...treePatch,
              ...(silent ? {} : { statusMessage: `Arquivo salvo: ${tab.name}` }),
            };
          });
          if (becameClean) {
            cancelDraftTimer(tab.id);
            void deleteDraft(workspaceRoot, tab.path);
          } else if (get().autoSave) {
            scheduleAutoSave(tab.id, get().autoSaveDelay);
          }
// patchEntryModified updates tree timestamps without triggering N listDir requests
        }
      } catch (err: any) {
        const latest = get().tabs.find((t) => t.id === tabId);
        const savedLocally =
          latest && latest.kind !== 'launcher' && !latest.loading
            ? await writeTabDraft(workspaceRoot, latest)
            : false;
        set({
          statusMessage: savedLocally
            ? `Servidor indisponível — rascunho de "${tab.name}" protegido localmente`
            : `Erro ao salvar ${tab.name}: ${err?.message || String(err)}`,
        });
      }
    };

    const flight = runSave().finally(() => {
      if (inFlightSaves.get(inflightKey) === flight) {
        inFlightSaves.delete(inflightKey);
      }
    });
    inFlightSaves.set(inflightKey, flight);
    await flight;
  },

  updateTextFileContent: (tabId, content) => {
    set((s) => {
      const target = s.tabs.find((t) => t.id === tabId && t.kind === 'file') as
        | OpenTextFileTab
        | undefined;
      if (!target || target.truncated || target.content === content) return s;
      return {
        tabs: s.tabs.map((t) =>
          t.id === tabId && t.kind === 'file' ? { ...t, content, dirty: true } : t
        ),
      };
    });
  },

  setNotebookMode: (mode) => set({ notebookMode: mode }),

  selectCell: (cellId, mode, scrollIntoView = false) => {
    const nextMode = mode || get().notebookMode;
    if (
      nextMode === 'command' &&
      typeof document !== 'undefined' &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest('[data-cell-id] .cm-editor')
    ) {
      document.activeElement.blur();
    }
    set((s) => {
      const activeNb = findNotebookTabForCell(s.tabs, s.activeTabId, cellId);
      if (!activeNb) return { notebookMode: mode || s.notebookMode };
      return {
        notebookMode: mode || s.notebookMode,
        tabs: s.tabs.map((t) =>
          t.id === activeNb.id && t.kind === 'notebook'
            ? { ...t, activeCellId: cellId }
            : t
        ),
        scrollSignal:
          scrollIntoView
            ? {
                notebookPath: activeNb.path,
                cellId,
                kind: 'cell',
                seq: (s.scrollSignal?.seq || 0) + 1,
              }
            : s.scrollSignal,
      };
    });
  },

  updateCellSource: (cellId, source) => {
    set((s) => {
      const activeNb = findNotebookTabForCell(s.tabs, s.activeTabId, cellId);
      const targetCell = activeNb?.cells.find((c) => c.id === cellId);
      if (!targetCell || targetCell.source === source || !activeNb) return s;
      return {
        tabs: s.tabs.map((t) =>
          t.id === activeNb.id && t.kind === 'notebook'
            ? {
                ...t,
                dirty: true,
                cells: t.cells.map((c) => (c.id === cellId ? { ...c, source } : c)),
              }
            : t
        ),
      };
    });
  },

  setMarkdownRendered: (cellId, rendered) => {
    set((s) => {
      const activeNb = findNotebookTabForCell(s.tabs, s.activeTabId, cellId);
      if (!activeNb) return s;
      return {
        tabs: s.tabs.map((t) =>
          t.id === activeNb.id && t.kind === 'notebook'
            ? {
                ...t,
                cells: t.cells.map((c) =>
                  c.id === cellId ? { ...c, markdownRendered: rendered } : c
                ),
              }
            : t
        ),
      };
    });
  },

  toggleSection: (cellId) => set(s => {
    const activeNb = findNotebookTabForCell(s.tabs, s.activeTabId, cellId);
    if (!activeNb) return s;
    return {
      tabs: s.tabs.map(t => {
        if (t.id !== activeNb.id || t.kind !== 'notebook') return t;
        return { ...t, activeCellId: cellId, cells: t.cells.map(c => c.id === cellId ? { ...c, sectionCollapsed: !c.sectionCollapsed } : c) };
      }),
      notebookMode: 'command'
    };
  }),

  toggleCellOutputCollapse: (cellId) => {
    const tab = findNotebookTabForCell(get().tabs, get().activeTabId, cellId);
    if (!tab) return;
    const targetId = cellId || tab.activeCellId;
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id && t.kind === 'notebook'
          ? {
              ...t,
              cells: t.cells.map((c) =>
                c.id === targetId ? { ...c, outputCollapsed: !c.outputCollapsed } : c
              ),
            }
          : t
      ),
    }));
  },

  changeCellType: (cellId, cellType) => {
    set((s) => {
      const activeNb = findNotebookTabForCell(s.tabs, s.activeTabId, cellId);
      if (!activeNb) return s;
      return {
        tabs: s.tabs.map((t) =>
          t.id === activeNb.id && t.kind === 'notebook'
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
      };
    });
  },

  addCellAbove: (targetCellId, cellType = 'code') => {
    const tab = findNotebookTabForCell(get().tabs, get().activeTabId, targetCellId);
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
      scrollSignal: {
        notebookPath: tab.path,
        cellId: newId,
        kind: 'cell',
        seq: (s.scrollSignal?.seq || 0) + 1,
      },
    }));
    return newId;
  },

  addCellBelow: (targetCellId, cellType = 'code') => {
    const tab = findNotebookTabForCell(get().tabs, get().activeTabId, targetCellId);
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
      scrollSignal: {
        notebookPath: tab.path,
        cellId: newId,
        kind: 'cell',
        seq: (s.scrollSignal?.seq || 0) + 1,
      },
    }));
    return newId;
  },

  deleteCell: (cellId) => {
    flushAllPendingEditors();
    set(state => {
      const tab = findNotebookTabForCell(state.tabs, state.activeTabId, cellId);
      return tab ? deleteNotebookCell(state, tab, cellId ?? tab.activeCellId, []) : state;
    });
  },

  redoDeleteCell: () => {
    flushAllPendingEditors();
    set(state => {
      const tab = findNotebookTabForCell(state.tabs, state.activeTabId);
      const ids = tab?.redoDeletedCellIds;
      if (!tab || !ids?.length) return state;
      return deleteNotebookCell(state, tab, ids[ids.length - 1], ids.slice(0, -1));
    });
  },

  undoDeleteCell: () => {
    flushAllPendingEditors();
    const tab = findNotebookTabForCell(get().tabs, get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return;
    const stack = [...get().deletedCellStack];
    const lastIdx = stack
      .map((r) => r.notebookPath)
      .lastIndexOf(tab.path);
    if (lastIdx === -1) return;

    const [restored] = stack.splice(lastIdx, 1);
    const nextCells = [...tab.cells];
    const insertAt = Math.min(Math.max(0, restored.index), nextCells.length);
    const existing = nextCells.findIndex(c => c.id === restored.cell.id);
    const blank = nextCells[existing];
    const reuseBlank = blank && !blank.source && !blank.outputs.length && blank.execution_count == null;
    const restoredCell = existing < 0 || reuseBlank ? restored.cell : { ...restored.cell, id: makeId() };
    if (reuseBlank) nextCells[existing] = restoredCell;
    else nextCells.splice(insertAt, 0, restoredCell);

    set((s) => ({
      deletedCellStack: stack,
      tabs: s.tabs.map((t) =>
        t.id === tab.id && t.kind === 'notebook'
          ? {
              ...t,
              dirty: true,
              cells: nextCells,
              activeCellId: restoredCell.id,
              redoDeletedCellIds: [...(tab.redoDeletedCellIds ?? []), restoredCell.id].slice(-MAX_DELETED_CELL_STACK),
            }
          : t
      ),
      statusMessage: 'Exclusão de célula desfeita',
    }));
  },

  moveCell: (cellId, direction) => {
    const tab = findNotebookTabForCell(get().tabs, get().activeTabId, cellId);
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
      scrollSignal: {
        notebookPath: tab.path,
        cellId,
        kind: 'cell',
        seq: (s.scrollSignal?.seq || 0) + 1,
      },
    }));
  },

  cutCell: (cellId) => {
    const tab = findNotebookTabForCell(get().tabs, get().activeTabId, cellId);
    if (!tab || tab.kind !== 'notebook') return;
    const targetId = cellId || tab.activeCellId;
    const found = tab.cells.find((c) => c.id === targetId);
    if (!found) return;
    set({ clipboardCell: { ...found } });
    get().deleteCell(targetId);
  },

  copyCell: (cellId) => {
    const tab = findNotebookTabForCell(get().tabs, get().activeTabId, cellId);
    if (!tab || tab.kind !== 'notebook') return;
    const targetId = cellId || tab.activeCellId;
    const found = tab.cells.find((c) => c.id === targetId);
    if (found) set({ clipboardCell: { ...found }, statusMessage: 'Célula copiada' });
  },

  pasteCellBelow: (cellId) => {
    const clip = get().clipboardCell;
    const tab = findNotebookTabForCell(get().tabs, get().activeTabId, cellId);
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
      scrollSignal: {
        notebookPath: tab.path,
        cellId: newId,
        kind: 'cell',
        seq: (s.scrollSignal?.seq || 0) + 1,
      },
    }));
  },

  clearCellOutputs: (cellId) => {
    set((s) => {
      const activeNb = findNotebookTabForCell(s.tabs, s.activeTabId, cellId);
      if (!activeNb) return s;
      return {
        tabs: s.tabs.map((t) =>
          t.id === activeNb.id && t.kind === 'notebook'
            ? {
                ...t,
                dirty: true,
                cells: t.cells.map((c) =>
                  c.id === cellId ? { ...c, outputs: [], execution_count: null } : c
                ),
              }
            : t
        ),
      };
    });
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
      statusMessage: 'Saídas limpas',
    }));
  },

  runCell: (cellId, advance = 'none') => {
    flushAllPendingEditors();
    const tab = findNotebookTabForCell(get().tabs, get().activeTabId, cellId);
    if (!tab || tab.kind !== 'notebook') return;
    const targetId = cellId || tab.activeCellId;
    const idx = tab.cells.findIndex((c) => c.id === targetId);
    if (idx === -1) return;
    const cell = tab.cells[idx];

    if (cell.cell_type === 'markdown') {
      get().setMarkdownRendered(cell.id, true);
    } else {
      const clearingOutputs = cell.outputs.length > 0;
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tab.id && t.kind === 'notebook'
            ? {
                ...t,
                dirty: clearingOutputs ? true : t.dirty,
                kernelStatus: 'busy',
                cells: t.cells.map((c) =>
                  c.id === cell.id
                    ? { ...c, outputs: [], isRunning: true, outputCollapsed: get().config?.output_display === 'collapsed' }
                    : c
                ),
              }
            : t
        ),
        scrollSignal: s.autoScrollOnRun
          ? {
              notebookPath: tab.path,
              cellId: cell.id,
              kind: 'output',
              seq: (s.scrollSignal?.seq || 0) + 1,
            }
          : s.scrollSignal,
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
      const hidden = hiddenSectionCells(tab.cells);
      const nextCell = tab.cells.slice(idx + 1).find((c) => !hidden.has(c.id));
      if (nextCell) {
        get().selectCell(nextCell.id, 'command', get().autoScrollOnRun);
      } else {
        const lastCellId = tab.cells[tab.cells.length - 1]?.id || cell.id;
        const inserted = get().addCellBelow(lastCellId, 'code');
        if (inserted) get().selectCell(inserted, 'edit');
      }
    }
  },

  runAllCells: () => {
    flushAllPendingEditors();
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return;
    const collapseDefault = get().config?.output_display === 'collapsed';
    const codeCellsToRun = tab.cells.filter(
      (c) => c.cell_type === 'code' && Boolean(c.source.trim())
    );
    const runIds = new Set(codeCellsToRun.map((c) => c.id));
    const batchId = `batch_${makeId()}`;

    const clearingAnyOutputs = codeCellsToRun.some((c) => c.outputs.length > 0);
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id && t.kind === 'notebook'
          ? {
              ...t,
              dirty: clearingAnyOutputs ? true : t.dirty,
              kernelStatus: codeCellsToRun.length > 0 ? 'busy' : t.kernelStatus,
              cells: t.cells.map((c) => {
                if (c.cell_type === 'markdown') {
                  return c.markdownRendered ? c : { ...c, markdownRendered: true };
                }
                if (runIds.has(c.id)) {
                  return {
                    ...c,
                    outputs: [],
                    isRunning: true,
                    outputCollapsed: collapseDefault,
                  };
                }
                return c;
              }),
            }
          : t
      ),
    }));

    for (const c of codeCellsToRun) {
      wsClient.send({
        action: 'execute_cell',
        notebook_path: tab.path,
        cell_id: c.id,
        code: c.source,
        batch_id: batchId,
        stop_on_error: true,
      });
    }
  },

  interruptKernel: async () => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return;
    try {
      await api.interruptKernel(tab.path);
      set({ statusMessage: 'Kernel interrompido' });
    } catch (err: any) {
      set({ statusMessage: `Erro ao interromper kernel: ${err?.message || String(err)}` });
    }
  },

  restartKernel: async (fromShortcut = false) => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId);
    if (!tab || tab.kind !== 'notebook') return;
    if (
      get().confirmKernelRestart &&
      !window.confirm(`Reiniciar o kernel de "${tab.name}"? Variáveis em memória serão perdidas.`)
    ) {
      return;
    }
    set((s) => ({
      statusMessage: fromShortcut
        ? 'Reiniciando kernel (0, 0)...'
        : 'Reiniciando kernel...',
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
    try {
      await api.restartKernel(tab.path);
      set((s) => ({
        statusMessage: fromShortcut ? 'Kernel reiniciado (0, 0)' : 'Kernel reiniciado',
        tabs: s.tabs.map((t) =>
          t.id === tab.id && t.kind === 'notebook' ? { ...t, kernelStatus: 'idle' } : t
        ),
      }));
    } catch (err: any) {
      set((s) => ({
        statusMessage: `Erro ao reiniciar kernel: ${err?.message || String(err)}`,
        tabs: s.tabs.map((t) =>
          t.id === tab.id && t.kind === 'notebook' ? { ...t, kernelStatus: 'stopped' } : t
        ),
      }));
    }
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
    flushAllPendingEditors();
    const tab = findNotebookTabForCell(get().tabs, get().activeTabId, cellId);
    const aiState = get().inlineAI[cellId];
    if (!tab || tab.kind !== 'notebook' || !aiState || !aiState.prompt.trim()) return;

    const cellIdx = tab.cells.findIndex((c) => c.id === cellId);
    if (cellIdx === -1) return;
    const cell = tab.cells[cellIdx];

    // Backend only uses up to 6 non-empty cells above and 2 below; avoid sending huge notebooks over WS.
    const cellsAbove = tab.cells
      .slice(0, cellIdx)
      .filter((c) => Boolean(c.source.trim()))
      .slice(-6)
      .map((c) => ({ cell_type: c.cell_type, source: c.source.slice(0, 1400) }));
    const cellsBelow = tab.cells
      .slice(cellIdx + 1)
      .filter((c) => Boolean(c.source.trim()))
      .slice(0, 2)
      .map((c) => ({ cell_type: c.cell_type, source: c.source.slice(0, 800) }));

    let errorCtx = aiState.lastErrorContext || '';
    if (!errorCtx) {
      const errOut = cell.outputs.find((o) => o.output_type === 'error');
      if (errOut) {
        errorCtx = `${errOut.ename}: ${errOut.evalue}\n${(errOut.traceback || []).join('\n')}`;
      }
    }

    const reqId = `ai_${makeId()}`;
    const trimmedPrompt = aiState.prompt.trim();
    set((s) => ({
      inlineAI: {
        ...s.inlineAI,
        [cellId]: {
          ...aiState,
          submittedPrompt: trimmedPrompt,
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
    flushAllPendingEditors();
    const tab = findNotebookTabForCell(get().tabs, get().activeTabId, cellId);
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
    const flushPending = () => {
      if (pendingWSFrame !== null) {
        if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(pendingWSFrame);
        } else {
          clearTimeout(pendingWSFrame);
        }
        pendingWSFrame = null;
      }
      if (pendingWSQueue.length === 0) return;
      const batch = pendingWSQueue;
      pendingWSQueue = [];

      set((s) => {
        let nextTabs = s.tabs;
        let nextInlineAI = s.inlineAI;
        let lastOutputTarget: { notebookPath: string; cellId: string } | null = null;
        let tabsCloned = false;
        let aiCloned = false;

        // Track cloned arrays within this RAF batch so rapid stream chunks
        // clone tabs/cells/outputs at most once per cell per frame.
        const clonedTabIndices = new Set<number>();
        const clonedCellKeys = new Set<string>();

        // Pre-coalesce consecutive stream / ai_chunk deltas in O(N) before merging.
        const coalescedBatch: Record<string, any>[] = [];
        for (const item of batch) {
          if (item.type === 'cell_output' && item.output?.output_type === 'stream') {
            const prev = coalescedBatch[coalescedBatch.length - 1];
            if (
              prev &&
              prev.type === 'cell_output' &&
              prev.notebook_path === item.notebook_path &&
              prev.cell_id === item.cell_id &&
              prev.output?.output_type === 'stream' &&
              prev.output?.name === item.output?.name
            ) {
              if (!prev._streamParts) {
                prev._streamParts = [prev.output.text || ''];
              }
              prev._streamParts.push(item.output.text || '');
              continue;
            }
            coalescedBatch.push({ ...item, output: { ...item.output } });
          } else if (item.type === 'ai_chunk') {
            const prev = coalescedBatch[coalescedBatch.length - 1];
            if (
              prev &&
              prev.type === 'ai_chunk' &&
              prev.cell_id === item.cell_id &&
              prev.request_id === item.request_id
            ) {
              if (!prev._deltaParts) {
                prev._deltaParts = [prev.delta || ''];
              }
              prev._deltaParts.push(item.delta || '');
              continue;
            }
            coalescedBatch.push({ ...item });
          } else {
            coalescedBatch.push(item);
          }
        }

        for (const item of coalescedBatch) {
          if (item.type === 'cell_output') {
            const tabIdx = nextTabs.findIndex(
              (t) => t.kind === 'notebook' && t.path === item.notebook_path && !t.loading
            );
            if (tabIdx === -1) continue;
            let nbTab = nextTabs[tabIdx] as OpenNotebookTab;
            const cellIdx = nbTab.cells.findIndex((c) => c.id === item.cell_id);
            if (cellIdx === -1) continue;

            if (!tabsCloned) {
              nextTabs = [...nextTabs];
              tabsCloned = true;
            }
            if (!clonedTabIndices.has(tabIdx)) {
              nbTab = { ...nbTab, dirty: true, cells: [...nbTab.cells] };
              nextTabs[tabIdx] = nbTab;
              clonedTabIndices.add(tabIdx);
            }

            const cellKey = `${tabIdx}\0${cellIdx}`;
            let cell = nbTab.cells[cellIdx];
            if (!clonedCellKeys.has(cellKey)) {
              cell = { ...cell, outputs: [...cell.outputs] };
              nbTab.cells[cellIdx] = cell;
              clonedCellKeys.add(cellKey);
            }

            const incoming = item._streamParts
              ? { ...item.output, text: (item._streamParts as string[]).join('') }
              : item.output;
            const prevOutputs = cell.outputs;
            if (
              incoming.output_type === 'stream' &&
              prevOutputs.length > 0 &&
              prevOutputs[prevOutputs.length - 1].output_type === 'stream' &&
              prevOutputs[prevOutputs.length - 1].name === incoming.name
            ) {
              const last = prevOutputs[prevOutputs.length - 1];
              prevOutputs[prevOutputs.length - 1] = {
                ...last,
                text: mergeStreamText(last.text || '', incoming.text || ''),
              };
            } else if (incoming.output_type === 'stream') {
              prevOutputs.push({
                ...incoming,
                text: mergeStreamText('', incoming.text || ''),
              });
            } else {
              prevOutputs.push(incoming);
            }

            if (shouldAutoScrollCellOutput(nbTab, item.cell_id)) {
              lastOutputTarget = { notebookPath: item.notebook_path, cellId: item.cell_id };
            }
          } else if (item.type === 'ai_chunk') {
            const cur = nextInlineAI[item.cell_id];
            if (!cur || cur.requestId !== item.request_id) continue;
            if (!aiCloned) {
              nextInlineAI = { ...nextInlineAI };
              aiCloned = true;
            }
            const deltaText = item._deltaParts
              ? (item._deltaParts as string[]).join('')
              : item.delta || '';
            nextInlineAI[item.cell_id] = {
              ...cur,
              status: 'streaming',
              streamedCode: cur.streamedCode + deltaText,
            };
          }
        }

        if (!tabsCloned && !aiCloned) return s;

        return {
          ...(tabsCloned ? { tabs: nextTabs } : {}),
          ...(aiCloned ? { inlineAI: nextInlineAI } : {}),
          ...(lastOutputTarget && s.autoScrollOnRun
            ? {
                scrollSignal: {
                  notebookPath: lastOutputTarget.notebookPath,
                  cellId: lastOutputTarget.cellId,
                  kind: 'output' as const,
                  seq: (s.scrollSignal?.seq || 0) + 1,
                },
              }
            : {}),
        };
      });
    };

    const type = msg.type;

    if (type === 'cell_output' || type === 'ai_chunk') {
      if (
        type === 'cell_output' &&
        get().tabs.some(
          (tab) => tab.kind === 'notebook' && tab.path === msg.notebook_path && tab.loading
        )
      ) {
        return;
      }
      pendingWSQueue.push(msg);
      if (pendingWSFrame === null) {
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          pendingWSFrame = window.requestAnimationFrame(flushPending);
        } else {
          pendingWSFrame = setTimeout(flushPending, 16) as unknown as number;
        }
      }
      return;
    }

    flushPending();

    if (type === '__ws_disconnected__') {
      set((s) => {
        let aiChanged = false;
        const nextAI = { ...s.inlineAI };
        for (const [cid, st] of Object.entries(nextAI)) {
          if (st.status === 'streaming') {
            nextAI[cid] = {
              ...st,
              status: st.streamedCode.trim() ? 'preview' : 'error',
              errorMessage: st.streamedCode.trim()
                ? undefined
                : 'Conexão perdida durante a geração. Tente novamente.',
            };
            aiChanged = true;
          }
        }
        return aiChanged ? { inlineAI: nextAI } : s;
      });
      return;
    }

    if (type === '__ws_reconnected__') {
      wsClient.send({ action: 'sync_kernels' });
      return;
    }

    if (type === 'kernel_session_sync') {
      const sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      const sessionMap = new Map<string, any>(sessions.map((s: any) => [s.notebook_path, s]));
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.kind !== 'notebook' || t.loading) return t;
          const kInfo = sessionMap.get(t.path);
          if (!kInfo) {
            if (t.kernelStatus === 'not_started') return t;
            return {
              ...t,
              kernelStatus: 'stopped',
              variables: [],
              cells: t.cells.map((c) => (c.isRunning ? { ...c, isRunning: false } : c)),
            };
          }
          const activeCellId = kInfo.active_cell_id || null;
          return {
            ...t,
            kernelStatus: kInfo.status as OpenNotebookTab['kernelStatus'],
            variables: kInfo.variables || t.variables,
            cells: t.cells.map((c) => {
              if (activeCellId && c.id === activeCellId) {
                return {
                  ...c,
                  isRunning: true,
                  execution_count:
                    kInfo.active_execution_count !== undefined && kInfo.active_execution_count !== null
                      ? kInfo.active_execution_count
                      : c.execution_count,
                  outputs: kInfo.active_outputs || c.outputs,
                };
              }
              if (kInfo.status !== 'busy' && c.isRunning) {
                return { ...c, isRunning: false };
              }
              return c;
            }),
          };
        }),
      }));
      return;
    }

    if (get().tabs.some((tab) => tab.kind === 'notebook' && tab.path === msg.notebook_path && tab.loading)) return;

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
        tabs: s.tabs.map((t) => {
          if (t.kind !== 'notebook' || t.path !== msg.notebook_path) return t;
          const hadOutputs = t.cells.some((c) => c.id === msg.cell_id && c.outputs.length > 0);
          return {
            ...t,
            dirty: hadOutputs ? true : t.dirty,
            cells: t.cells.map((c) =>
              c.id === msg.cell_id ? { ...c, isRunning: true, outputs: [] } : c
            ),
          };
        }),
      }));
    } else if (type === 'cell_execution_count') {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.kind !== 'notebook' || t.path !== msg.notebook_path) return t;
          const target = t.cells.find((c) => c.id === msg.cell_id);
          if (!target) return t;
          const countChanged =
            msg.execution_count !== undefined &&
            msg.execution_count !== null &&
            target.execution_count !== msg.execution_count;
          return {
            ...t,
            dirty: countChanged ? true : t.dirty,
            cells: t.cells.map((c) =>
              c.id === msg.cell_id ? { ...c, execution_count: msg.execution_count } : c
            ),
          };
        }),
      }));
    } else if (type === 'cell_clear_output') {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.kind !== 'notebook' || t.path !== msg.notebook_path) return t;
          const hadOutputs = t.cells.some((c) => c.id === msg.cell_id && c.outputs.length > 0);
          return {
            ...t,
            dirty: hadOutputs ? true : t.dirty,
            cells: t.cells.map((c) => (c.id === msg.cell_id ? { ...c, outputs: [] } : c)),
          };
        }),
      }));
    } else if (type === 'cell_execution_done') {
      set((s) => {
        let allowAutoScroll = false;
        const nextTabs = s.tabs.map((t) => {
          if (t.kind !== 'notebook' || t.path !== msg.notebook_path) return t;
          if (shouldAutoScrollCellOutput(t, msg.cell_id)) {
            allowAutoScroll = true;
          }
          const target = t.cells.find((c) => c.id === msg.cell_id);
          const countChanged =
            Boolean(target) &&
            msg.execution_count !== undefined &&
            msg.execution_count !== null &&
            target!.execution_count !== msg.execution_count;
          return {
            ...t,
            dirty: countChanged ? true : t.dirty,
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
          };
        });
        return {
          tabs: nextTabs,
          scrollSignal:
            s.autoScrollOnRun && allowAutoScroll
              ? {
                  notebookPath: msg.notebook_path,
                  cellId: msg.cell_id,
                  kind: 'output' as const,
                  seq: (s.scrollSignal?.seq || 0) + 1,
                }
              : s.scrollSignal,
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
    } else if (type === 'ai_cancelled') {
      set((s) => {
        const cur = s.inlineAI[msg.cell_id];
        if (!cur || cur.requestId !== msg.request_id) return s;
        return {
          inlineAI: {
            ...s.inlineAI,
            [msg.cell_id]: {
              ...cur,
              status: cur.streamedCode.trim() ? 'preview' : 'idle',
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

function utf8ByteLength(str: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).byteLength;
  }
  return str.length * 2;
}

function flushOnPageLifecycle(includeKeepaliveSave: boolean) {
  flushAllPendingEditors();
  const state = useSaturnoStore.getState();
  if (!state.initialized || !state.workspaceRoot) return;
  flushDirtyDraftsSync(state.workspaceRoot, state.tabs);

  if (!includeKeepaliveSave || !state.autoSave || typeof fetch !== 'function') return;
  for (const tab of state.tabs) {
    if (tab.kind === 'launcher' || tab.loading || !tab.dirty) continue;
    try {
      if (tab.kind === 'file') {
        if (tab.truncated) continue;
        const body = JSON.stringify({ path: tab.path, content: tab.content });
        if (utf8ByteLength(body) < 60_000) {
          void fetch('/api/fs/file/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
          }).catch(() => {});
        }
      } else if (tab.kind === 'notebook' && !tab.cells.some((c) => c.isRunning)) {
        const body = JSON.stringify({
          path: tab.path,
          cells: tab.cells,
          metadata: tab.metadata,
        });
        if (utf8ByteLength(body) < 60_000) {
          void fetch('/api/fs/notebook/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
          }).catch(() => {});
        }
      }
    } catch {
      // ignore unload serialization errors
    }
  }
}

// Register independently of React mounts; flush drafts on tab hide/close, and
// fall back to native confirmation only when IndexedDB hot-exit is unavailable.
const warnBeforeUnload = (event: BeforeUnloadEvent) => {
  flushAllPendingEditors();
  const state = useSaturnoStore.getState();
  if (!hasUnsavedChanges(state.tabs)) return;
  flushOnPageLifecycle(true);
  if (isDraftStorageReady()) return;
  event.preventDefault();
  event.returnValue = '';
};

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flushOnPageLifecycle(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    flushAllPendingEditors();
    const state = useSaturnoStore.getState();
    if (!state.initialized || !state.workspaceRoot) return;
    flushDirtyDraftsSync(state.workspaceRoot, state.tabs);
    if (!state.autoSave) return;
    for (const tab of state.tabs) {
      if (tab.kind === 'launcher' || tab.loading || !tab.dirty) continue;
      if (tab.kind === 'file' && tab.truncated) continue;
      if (tab.kind === 'notebook' && tab.cells.some((c) => c.isRunning)) continue;
      void state.saveTabById(tab.id, { silent: true });
    }
  });
}

let unloadWarningEnabled = false;
useSaturnoStore.subscribe((state, previous) => {
  const dirty = hasUnsavedChanges(state.tabs);
  if (dirty !== unloadWarningEnabled) {
    unloadWarningEnabled = dirty;
    if (dirty) window.addEventListener('beforeunload', warnBeforeUnload);
    else window.removeEventListener('beforeunload', warnBeforeUnload);
  }

  if (!initializing && !restoringSession && state.initialized) {
    if (sessionPersistenceReady &&
        (state.tabs !== previous.tabs || state.panes !== previous.panes || state.activePaneId !== previous.activePaneId)) {
      saveWorkspaceSession(state);
    }

    if (!state.autoSave && previous.autoSave) {
      for (const timer of autoSaveTimers.values()) clearTimeout(timer);
      autoSaveTimers.clear();
    } else if (state.autoSave && (!previous.autoSave || state.autoSaveDelay !== previous.autoSaveDelay)) {
      for (const timer of autoSaveTimers.values()) clearTimeout(timer);
      autoSaveTimers.clear();
      syncDirtyTabsTimers(state);
    }

    if (state.tabs !== previous.tabs && state.workspaceRoot) {
      const currentIds = new Set(state.tabs.map((t) => t.id));
      for (const tid of draftTimers.keys()) {
        if (!currentIds.has(tid)) cancelDraftTimer(tid);
      }
      for (const tid of autoSaveTimers.keys()) {
        if (!currentIds.has(tid)) cancelAutoSaveTimer(tid);
      }

      for (const tab of state.tabs) {
        if (tab.kind === 'launcher' || tab.loading) continue;
        if (!tab.dirty) {
          cancelDraftTimer(tab.id);
          cancelAutoSaveTimer(tab.id);
          continue;
        }
        const prevTab = previous.tabs.find((t) => t.id === tab.id);
        if (tab === prevTab) continue;

        if (tab.kind === 'file') {
          if (tab.truncated) continue;
          const changed =
            !prevTab ||
            prevTab.kind !== 'file' ||
            tab.content !== prevTab.content ||
            !prevTab.dirty;
          if (changed) {
            scheduleDraftWrite(tab.id, 350);
            if (state.autoSave) {
              scheduleAutoSave(tab.id, state.autoSaveDelay);
            }
          }
        } else if (tab.kind === 'notebook') {
          const isExecuting = tab.cells.some((c) => c.isRunning);
          const wasExecuting =
            prevTab?.kind === 'notebook' && prevTab.cells.some((c) => c.isRunning);

          if (isExecuting) {
            cancelAutoSaveTimer(tab.id);
            const codeEditedWhileRunning =
              !prevTab ||
              prevTab.kind !== 'notebook' ||
              tab.cells.length !== prevTab.cells.length ||
              tab.cells.some(
                (c, idx) =>
                  c.source !== prevTab.cells[idx]?.source ||
                  c.cell_type !== prevTab.cells[idx]?.cell_type
              );
            if (codeEditedWhileRunning) {
              scheduleDraftWrite(tab.id, 1500);
            }
          } else if (wasExecuting) {
            scheduleDraftWrite(tab.id, 150);
            if (state.autoSave) {
              scheduleAutoSave(tab.id, Math.min(800, state.autoSaveDelay));
            }
          } else {
            const contentChanged =
              !prevTab ||
              prevTab.kind !== 'notebook' ||
              tab.cells !== prevTab.cells ||
              tab.metadata !== prevTab.metadata ||
              !prevTab.dirty;
            if (contentChanged) {
              scheduleDraftWrite(tab.id, 350);
              if (state.autoSave) {
                scheduleAutoSave(tab.id, state.autoSaveDelay);
              }
            }
          }
        }
      }
    }
  }
});
