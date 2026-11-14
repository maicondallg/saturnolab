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
