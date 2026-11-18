// Start editor code and file I/O together. Publishing the resolved component
// lets the first tab render use it directly, without another Suspense roundtrip.
export const editorViews: {
  notebook?: typeof import('../components/NotebookView')['NotebookView'];
  file?: typeof import('../components/TextFileEditor')['TextFileEditor'];
} = {};
let notebookLoad: Promise<typeof import('../components/NotebookView')> | undefined;
let fileLoad: Promise<typeof import('../components/TextFileEditor')> | undefined;

export function loadNotebookView() {
  return notebookLoad ??= import('../components/NotebookView').then(module => {
    editorViews.notebook = module.NotebookView;
    return module;
  }).catch(error => { notebookLoad = undefined; throw error; });
}

export function loadTextFileView() {
  return fileLoad ??= import('../components/TextFileEditor').then(module => {
    editorViews.file = module.TextFileEditor;
    return module;
  }).catch(error => { fileLoad = undefined; throw error; });
}

// Registry of active editor/table input flushers so micro-debounced keystrokes
// or active CSV table inputs commit synchronously before Run, Save, AI, or unload.
const pendingEditorFlushers = new Map<string, () => void>();

export function registerEditorFlusher(id: string, flush: () => void): () => void {
  pendingEditorFlushers.set(id, flush);
  return () => {
    if (pendingEditorFlushers.get(id) === flush) {
      pendingEditorFlushers.delete(id);
    }
  };
}

export function flushAllPendingEditors(): void {
  for (const flush of Array.from(pendingEditorFlushers.values())) {
    try {
      flush();
    } catch {
      // ignore individual flush errors
    }
  }
}
