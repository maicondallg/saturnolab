import { api } from './api';
import { loadNotebookView, loadTextFileView } from './editorViews';
import { EditorPane, WorkspaceTab } from '../types/notebook';

type TabReference = { id: string; kind: WorkspaceTab['kind']; activeCellId?: string };
interface Session {
  version: 1;
  tabs: TabReference[];
  panes: EditorPane[];
  activePaneId: string;
}
interface WorkspaceState {
  workspaceRoot: string;
  tabs: WorkspaceTab[];
  panes: EditorPane[];
  activePaneId: string;
}
const sessionKey = (root: string) => `saturno_session_v1:${root}`;
let lastWritten = '';
let lastRoot = '';

// Persist navigation only: notebook contents/outputs remain in their files.
export function saveWorkspaceSession(state: WorkspaceState) {
  if (!state.workspaceRoot) return;
  const session: Session = {
    version: 1,
    tabs: state.tabs.map(tab => ({ id: tab.id, kind: tab.kind,
      ...(tab.kind === 'notebook' ? { activeCellId: tab.activeCellId } : {}),
    })),
    panes: state.panes,
    activePaneId: state.activePaneId,
  };
  const serialized = JSON.stringify(session);
  if (lastRoot === state.workspaceRoot && lastWritten === serialized) return;
  try {
    localStorage.setItem(sessionKey(state.workspaceRoot), serialized);
    lastRoot = state.workspaceRoot;
    lastWritten = serialized;
  } catch { /* Full/disabled storage must not prevent editing. */ }
}

function readSession(root: string): Session | null {
  try {
    const value = JSON.parse(localStorage.getItem(sessionKey(root)) || 'null');
    if (value?.version !== 1 || !Array.isArray(value.tabs) || !Array.isArray(value.panes)) return null;
    const seen = new Set<string>();
    const tabs = value.tabs.filter((tab: TabReference) => {
      if (!tab || typeof tab.id !== 'string' || !tab.id || !['launcher', 'notebook', 'file'].includes(tab.kind)
        || (tab.kind === 'launcher' && tab.id !== '__launcher__') || seen.has(tab.id)) return false;
      seen.add(tab.id);
      return true;
    });
    const panes: EditorPane[] = value.panes.filter((pane: EditorPane) => pane && typeof pane.id === 'string'
      && Array.isArray(pane.tabIds) && typeof pane.activeTabId === 'string');
    return { version: 1, tabs, panes, activePaneId: value.activePaneId };
  } catch { return null; }
}

// Navigation is available synchronously; content arrives independently.
export function initialWorkspaceSession(root: string) {
  const session = readSession(root);
  if (!session) return null;
  const tabs = new Map<string, WorkspaceTab>();
  for (const ref of session.tabs) {
    const name = ref.id.split('/').pop() || ref.id;
    if (ref.kind === 'launcher') tabs.set(ref.id, { kind: 'launcher', id: '__launcher__', name: 'Launcher' });
    else if (ref.kind === 'file') tabs.set(ref.id, { kind: 'file', id: ref.id, path: ref.id, name, dirty: false, loading: true, content: '' });
    else tabs.set(ref.id, { kind: 'notebook', id: ref.id, path: ref.id, name, dirty: false, loading: true,
      cells: [], metadata: {}, kernelStatus: 'not_started', variables: [], activeCellId: ref.activeCellId || '' });
  }
  return sessionLayout(session, tabs);
}

// Respect tab selection/closure during I/O without discarding loaded files or
// replacing edits made to a different tab while restoration was running.
export function reconcileRestoredSession(current: WorkspaceState, restored: Pick<WorkspaceState, 'tabs'>) {
  const tabs = new Map(restored.tabs.map(tab => [tab.id, tab]));
  for (const tab of current.tabs) {
    if (tab.kind === 'launcher' || !tab.loading) tabs.set(tab.id, tab);
  }
  for (const id of tabs.keys()) {
    if (!current.panes.some(pane => pane.tabIds.includes(id))) tabs.delete(id);
  }
  return sessionLayout({ version: 1, tabs: [...tabs.values()], panes: current.panes, activePaneId: current.activePaneId }, tabs);
}

export function preloadWorkspaceEditors(root: string) {
  const session = readSession(root);
  if (session?.tabs.some(tab => tab.kind === 'notebook')) void loadNotebookView().catch(() => {});
  if (session?.tabs.some(tab => tab.kind === 'file')) void loadTextFileView().catch(() => {});
}

export async function restoreWorkspaceSession(root: string, collapseOutputs: boolean) {
  const session = readSession(root);
  if (!session) return null;
  const loaded = new Map<string, WorkspaceTab>();
  const failed: string[] = [];
  let next = 0;
  // Bound simultaneous requests when restoring a workspace with many tabs.
  await Promise.all(Array.from({ length: Math.min(4, session.tabs.length) }, async () => {
    while (next < session.tabs.length) {
      const ref = session.tabs[next++];
      try {
        if (ref.kind === 'launcher') {
          loaded.set(ref.id, { kind: 'launcher', id: '__launcher__', name: 'Launcher' });
        } else if (ref.kind === 'file') {
          const [file] = await Promise.all([api.readFile(ref.id), loadTextFileView()]);
          loaded.set(ref.id, { kind: 'file', id: ref.id, path: file.path, name: file.name,
            content: file.content.replace(/\r\n/g, '\n'), dirty: false });
        } else {
          const [notebook] = await Promise.all([api.readNotebook(ref.id), loadNotebookView()]);
          const cells = notebook.cells.map(c => ({ ...c, source: (c.source || '').replace(/\r\n/g, '\n'),
            isRunning: false, outputCollapsed: collapseOutputs,
            markdownRendered: c.cell_type === 'markdown' && Boolean(c.source?.trim()),
          }));
          loaded.set(ref.id, { kind: 'notebook', id: ref.id, path: notebook.path, name: notebook.name,
            cells, metadata: notebook.metadata || {}, dirty: false,
            kernelStatus: notebook.kernel_status || 'not_started', variables: notebook.variables || [],
            activeCellId: cells.some(c => c.id === ref.activeCellId) ? ref.activeCellId! : cells[0]?.id || '',
          });
        }
      } catch { failed.push(ref.id); }
    }
  }));
  return { ...sessionLayout(session, loaded),
    statusMessage: failed.length ? `Não foi possível restaurar: ${failed.join(', ')}` : 'Pronto' };
}

function sessionLayout(session: Session, loaded: Map<string, WorkspaceTab>) {
  const panes: EditorPane[] = [];
  for (const pane of session.panes) {
    if (panes.some(p => p.id === pane.id)) continue;
    const tabIds = [...new Set(pane.tabIds.filter(id => loaded.has(id)))];
    if (!tabIds.length) continue;
    panes.push({ id: pane.id, tabIds,
      activeTabId: tabIds.includes(pane.activeTabId) ? pane.activeTabId : tabIds[0],
      widthRatio: Number.isFinite(pane.widthRatio) && pane.widthRatio > 0 ? pane.widthRatio : 1,
    });
  }
  if (!panes.length) {
    if (!loaded.size) loaded.set('__launcher__', { kind: 'launcher', id: '__launcher__', name: 'Launcher' });
    const tabIds = [...loaded.keys()];
    panes.push({ id: 'pane_main', tabIds, activeTabId: tabIds[0], widthRatio: 1 });
  }
  // Keep successfully loaded tabs reachable even if stored pane data is incomplete.
  for (const id of loaded.keys()) {
    if (!panes.some(pane => pane.tabIds.includes(id))) panes[0].tabIds.push(id);
  }
  const activePane = panes.find(pane => pane.id === session.activePaneId) || panes[0];
  const orderedTabs = session.tabs.map(ref => loaded.get(ref.id)).filter((tab): tab is WorkspaceTab => Boolean(tab));
  if (!orderedTabs.length) orderedTabs.push(...loaded.values());
  return { tabs: orderedTabs, panes, activePaneId: activePane.id, activeTabId: activePane.activeTabId,
  };
}

export function hasUnsavedChanges(tabs: WorkspaceTab[]) {
  return tabs.some(tab => tab.kind !== 'launcher' && tab.dirty);
}
