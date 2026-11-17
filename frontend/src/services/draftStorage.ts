import {
  CellOutput,
  CellType,
  NotebookCellData,
  WorkspaceTab,
} from '../types/notebook';

const DB_NAME = 'saturnolab_drafts_v1';
const STORE_NAME = 'drafts';
const WORKSPACE_INDEX = 'by_workspace';
const DB_VERSION = 1;
const STALE_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface DraftNotebookCell {
  id: string;
  cell_type: CellType;
  source: string;
  execution_count: number | null;
  outputs: CellOutput[];
  metadata?: Record<string, any>;
  outputCollapsed?: boolean;
  sectionCollapsed?: boolean;
}

export interface StoredDraft {
  key: string;
  workspaceRoot: string;
  path: string;
  kind: 'notebook' | 'file';
  baseModified?: string;
  updatedAt: number;
  cells?: DraftNotebookCell[];
  metadata?: Record<string, any>;
  activeCellId?: string;
  content?: string;
}

let cachedDb: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;
let idbUnavailable = false;
let prunedOnce = false;

export function makeDraftKey(workspaceRoot: string, path: string): string {
  return `${workspaceRoot}\0${path}`;
}

export function isDraftStorageReady(): boolean {
  return cachedDb !== null && !idbUnavailable;
}

function openDraftDB(): Promise<IDBDatabase | null> {
  if (idbUnavailable || typeof indexedDB === 'undefined') {
    idbUnavailable = true;
    return Promise.resolve(null);
  }
  if (cachedDb) return Promise.resolve(cachedDb);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex(WORKSPACE_INDEX, 'workspaceRoot', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        cachedDb = db;
        db.onversionchange = () => {
          db.close();
          if (cachedDb === db) {
            cachedDb = null;
            dbPromise = null;
          }
        };
        resolve(db);
      };
      req.onerror = () => {
        idbUnavailable = true;
        dbPromise = null;
        resolve(null);
      };
      req.onblocked = () => {
        dbPromise = null;
        resolve(null);
      };
    } catch {
      idbUnavailable = true;
      dbPromise = null;
      resolve(null);
    }
  });

  return dbPromise;
}

export function warmupDraftStorage(): void {
  void openDraftDB().then((db) => {
    if (!db || prunedOnce) return;
    prunedOnce = true;
    const schedule =
      typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
        ? (cb: () => void) => window.requestIdleCallback(cb, { timeout: 5000 })
        : (cb: () => void) => setTimeout(cb, 2500);
    schedule(() => {
      void pruneStaleDrafts();
    });
  });
}

export function buildDraftRecord(
  workspaceRoot: string,
  tab: WorkspaceTab
): StoredDraft | null {
  if (!workspaceRoot || tab.kind === 'launcher' || tab.loading) return null;
  if (tab.kind === 'file') {
    if (tab.truncated) return null;
    return {
      key: makeDraftKey(workspaceRoot, tab.path),
      workspaceRoot,
      path: tab.path,
      kind: 'file',
      baseModified: tab.diskModified,
      updatedAt: Date.now(),
      content: tab.content,
    };
  }
  return {
    key: makeDraftKey(workspaceRoot, tab.path),
    workspaceRoot,
    path: tab.path,
    kind: 'notebook',
    baseModified: tab.diskModified,
    updatedAt: Date.now(),
    activeCellId: tab.activeCellId,
    metadata: tab.metadata,
    cells: tab.cells.map((c) => ({
      id: c.id,
      cell_type: c.cell_type,
      source: c.source,
      execution_count: c.execution_count,
      outputs: c.outputs,
      metadata: c.metadata,
      outputCollapsed: c.outputCollapsed,
      sectionCollapsed: c.sectionCollapsed,
    })),
  };
}

export async function writeTabDraft(
  workspaceRoot: string,
  tab: WorkspaceTab
): Promise<boolean> {
  const record = buildDraftRecord(workspaceRoot, tab);
  if (!record) return false;
  const db = await openDraftDB();
  if (!db) return false;
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Starts an IndexedDB readwrite transaction synchronously when the DB connection
 * is already warm, guaranteeing browser persistence during pagehide/beforeunload.
 */
export function flushDirtyDraftsSync(
  workspaceRoot: string,
  tabs: WorkspaceTab[]
): boolean {
  if (!workspaceRoot) return false;
  const records: StoredDraft[] = [];
  for (const tab of tabs) {
    if (tab.kind === 'launcher' || tab.loading || !tab.dirty) continue;
    const rec = buildDraftRecord(workspaceRoot, tab);
    if (rec) records.push(rec);
  }
  if (!records.length) return true;

  if (cachedDb) {
    try {
      const tx = cachedDb.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const rec of records) {
        store.put(rec);
      }
      return true;
    } catch {
      // Fall through to async attempt if connection closed
    }
  }

  void openDraftDB().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const rec of records) {
        store.put(rec);
      }
    } catch {
      // ignore
    }
  });
  return false;
}

export async function readDraft(
  workspaceRoot: string,
  path: string
): Promise<StoredDraft | null> {
  if (!workspaceRoot || !path) return null;
  const db = await openDraftDB();
  if (!db) return null;
  return new Promise<StoredDraft | null>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(makeDraftKey(workspaceRoot, path));
      req.onsuccess = () => resolve((req.result as StoredDraft | undefined) || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function deleteDraft(workspaceRoot: string, path: string): Promise<void> {
  if (!workspaceRoot || !path) return;
  const db = await openDraftDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(makeDraftKey(workspaceRoot, path));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function deleteDraftsMatching(
  workspaceRoot: string,
  predicate: (path: string) => boolean
): Promise<void> {
  if (!workspaceRoot) return;
  const db = await openDraftDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const idx = store.index(WORKSPACE_INDEX);
      const req = idx.openCursor(IDBKeyRange.only(workspaceRoot));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const val = cursor.value as StoredDraft;
        if (val && predicate(val.path)) {
          cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function remapDraftPaths(
  workspaceRoot: string,
  remap: (oldPath: string) => string | null
): Promise<void> {
  if (!workspaceRoot) return;
  const db = await openDraftDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const idx = store.index(WORKSPACE_INDEX);
      const req = idx.getAll(IDBKeyRange.only(workspaceRoot));
      req.onsuccess = () => {
        const items = (req.result as StoredDraft[]) || [];
        for (const item of items) {
          const nextPath = remap(item.path);
          if (nextPath && nextPath !== item.path) {
            store.delete(item.key);
            store.put({
              ...item,
              key: makeDraftKey(workspaceRoot, nextPath),
              path: nextPath,
            });
          }
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function pruneStaleDrafts(): Promise<void> {
  const db = await openDraftDB();
  if (!db) return;
  const cutoff = Date.now() - STALE_DRAFT_MAX_AGE_MS;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const val = cursor.value as StoredDraft;
        if (!val || typeof val.updatedAt !== 'number' || val.updatedAt < cutoff) {
          cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

function isDiskNewerThanDraft(draft: StoredDraft, diskModified?: string): boolean {
  if (draft.baseModified && diskModified && draft.baseModified === diskModified) {
    return false;
  }
  if (diskModified) {
    const diskMs = Date.parse(diskModified);
    if (!Number.isNaN(diskMs) && diskMs > draft.updatedAt + 1500) {
      return true;
    }
  }
  return false;
}

function cellsMatchDisk(a: NotebookCellData[], b: NotebookCellData[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ca = a[i];
    const cb = b[i];
    if (
      ca.id !== cb.id ||
      ca.cell_type !== cb.cell_type ||
      ca.source !== cb.source ||
      (ca.execution_count ?? null) !== (cb.execution_count ?? null) ||
      ca.outputs.length !== cb.outputs.length
    ) {
      return false;
    }
    if (ca.outputs.length > 0 && JSON.stringify(ca.outputs) !== JSON.stringify(cb.outputs)) {
      return false;
    }
  }
  return true;
}

export async function reconcileNotebookWithDraft(params: {
  workspaceRoot: string;
  path: string;
  diskCells: NotebookCellData[];
  diskMetadata: Record<string, any>;
  diskModified?: string;
  collapseOutputs: boolean;
}): Promise<{
  cells: NotebookCellData[];
  metadata: Record<string, any>;
  activeCellId?: string;
  dirty: boolean;
  restored: boolean;
}> {
  const { workspaceRoot, path, diskCells, diskMetadata, diskModified, collapseOutputs } = params;
  const draft = await readDraft(workspaceRoot, path);
  if (!draft || draft.kind !== 'notebook' || !Array.isArray(draft.cells) || !draft.cells.length) {
    return { cells: diskCells, metadata: diskMetadata, dirty: false, restored: false };
  }

  if (isDiskNewerThanDraft(draft, diskModified)) {
    void deleteDraft(workspaceRoot, path);
    return { cells: diskCells, metadata: diskMetadata, dirty: false, restored: false };
  }

  const restoredCells: NotebookCellData[] = draft.cells.map((c) => {
    const cleanSrc = (c.source || '').replace(/\r\n/g, '\n');
    return {
      id: c.id,
      cell_type: c.cell_type === 'markdown' ? 'markdown' : 'code',
      source: cleanSrc,
      execution_count: c.execution_count ?? null,
      outputs: Array.isArray(c.outputs) ? c.outputs : [],
      metadata: c.metadata || {},
      isRunning: false,
      outputCollapsed: c.outputCollapsed ?? collapseOutputs,
      sectionCollapsed: c.sectionCollapsed,
      markdownRendered: c.cell_type === 'markdown' && Boolean(cleanSrc.trim()),
    };
  });

  if (cellsMatchDisk(restoredCells, diskCells)) {
    void deleteDraft(workspaceRoot, path);
    return { cells: diskCells, metadata: diskMetadata, dirty: false, restored: false };
  }

  return {
    cells: restoredCells,
    metadata: draft.metadata || diskMetadata,
    activeCellId: draft.activeCellId,
    dirty: true,
    restored: true,
  };
}

export async function reconcileFileWithDraft(params: {
  workspaceRoot: string;
  path: string;
  diskContent: string;
  diskModified?: string;
  truncated?: boolean;
}): Promise<{
  content: string;
  dirty: boolean;
  restored: boolean;
}> {
  const { workspaceRoot, path, diskContent, diskModified, truncated } = params;
  if (truncated) {
    return { content: diskContent, dirty: false, restored: false };
  }
  const draft = await readDraft(workspaceRoot, path);
  if (!draft || draft.kind !== 'file' || typeof draft.content !== 'string') {
    return { content: diskContent, dirty: false, restored: false };
  }

  if (isDiskNewerThanDraft(draft, diskModified) || draft.content === diskContent) {
    void deleteDraft(workspaceRoot, path);
    return { content: diskContent, dirty: false, restored: false };
  }

  return {
    content: draft.content,
    dirty: true,
    restored: true,
  };
}
