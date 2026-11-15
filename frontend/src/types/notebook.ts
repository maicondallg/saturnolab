export type CellType = 'code' | 'markdown';

export interface CellOutput {
  output_type: 'stream' | 'display_data' | 'execute_result' | 'error';
  name?: 'stdout' | 'stderr' | string;
  text?: string;
  data?: Record<string, any>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface NotebookCellData {
  id: string;
  cell_type: CellType;
  source: string;
  execution_count: number | null;
  outputs: CellOutput[];
  metadata?: Record<string, any>;
  isRunning?: boolean;
  markdownRendered?: boolean;
  outputCollapsed?: boolean;
  sectionCollapsed?: boolean;
}

export interface KernelVariable {
  name: string;
  type: string;
  shape: string;
  preview: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'directory' | 'notebook' | 'file';
  extension: string;
  size: number;
  modified: string;
  children?: FileEntry[];
}

export interface ProviderConfig {
  api_key: string;
  model: string;
  base_url: string;
  reasoning_effort?: string;
  has_key?: boolean;
}

export interface TableOutputSettings {
  wrap: 'nowrap' | 'wrap';
  density: 'compact' | 'normal' | 'comfortable';
  font_size: number;
  max_col_width: number;
  align: 'auto' | 'left' | 'right';
  height: 'limited' | 'full';
  sticky_headers: boolean;
  highlight_types: boolean;
  show_grid: boolean;
}

export interface SaturnoConfig {
  workspace_dir: string;
  active_provider: 'gemini' | 'codex' | 'openai_compatible' | 'anthropic';
  theme: string;
  default_ai_apply_mode?: 'replace_cell' | 'append_cell';
  include_kernel_variables: boolean;
  output_display?: 'expanded' | 'limited' | 'collapsed';
  notebook_layout?: 'centered' | 'expanded';
  sidebar_position?: 'left' | 'right';
  sidebar_width?: number;
  show_line_numbers?: boolean;
  auto_scroll_on_run?: boolean;
  show_modified_time?: boolean;
  confirm_kernel_restart?: boolean;
  editor_font_size?: number;
  table_output?: Partial<TableOutputSettings>;
  providers: Record<string, ProviderConfig>;
  codex_status?: {
    cli_installed: boolean;
    auth_found: boolean;
    sdk_ready: boolean;
  };
}

export interface InlineAIState {
  isOpen: boolean;
  prompt: string;
  status: 'idle' | 'streaming' | 'preview' | 'error';
  streamedCode: string;
  errorMessage?: string;
  requestId?: string;
  selection?: {
    from: number;
    to: number;
    text: string;
  } | null;
  applyMode: 'replace_selection' | 'replace_cell' | 'append_cell';
  lastErrorContext?: string;
}

export interface OpenNotebookTab {
  kind: 'notebook';
  loading?: boolean;
  id: string; // path
  path: string;
  name: string;
  cells: NotebookCellData[];
  metadata: Record<string, any>;
  dirty: boolean;
  kernelStatus: 'not_started' | 'starting' | 'idle' | 'busy' | 'stopped';
  variables: KernelVariable[];
  activeCellId: string;
}

export interface OpenTextFileTab {
  kind: 'file';
  loading?: boolean;
  id: string;
  path: string;
  name: string;
  content: string;
  dirty: boolean;
}

export interface LauncherTab {
  kind: 'launcher';
  id: '__launcher__';
  name: 'Launcher';
}

export type WorkspaceTab = OpenNotebookTab | OpenTextFileTab | LauncherTab;

export interface EditorPane {
  id: string;
  tabIds: string[];
  activeTabId: string;
  widthRatio: number;
}

export type SettingsSection = 'appearance' | 'editor' | 'ai' | 'shortcuts';
