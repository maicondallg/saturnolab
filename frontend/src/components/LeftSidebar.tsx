import React, { useState } from 'react';
import {
  Database,
  FileCode,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Home,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { OpenNotebookTab } from '../types/notebook';

export const LeftSidebar: React.FC = () => {
  const {
    leftSidebar,
    setLeftSidebar,
    files,
    currentDir,
    workspaceRoot,
    refreshFiles,
    openEntry,
    createNewNotebook,
    createNewFolder,
    renameEntry,
    deleteEntry,
    tabs,
    activeTabId,
  } = useSaturnoStore();

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');

  if (!leftSidebar) return null;

  const activeNotebook = tabs.find(
    (t): t is OpenNotebookTab => t.id === activeTabId && t.kind === 'notebook'
  );

  const breadcrumbs = currentDir ? currentDir.split('/').filter(Boolean) : [];

  return (
    <aside
      className="w-68 flex flex-col border-r h-full shrink-0 select-none overflow-hidden"
      style={{
        backgroundColor: 'var(--sat-bg-surface)',
        borderColor: 'var(--sat-border)',
      }}
    >
      {/* Flush Header Tabs: Arquivos | Variáveis */}
      <div
        className="h-9 flex items-stretch border-b shrink-0"
        style={{ borderColor: 'var(--sat-border)' }}
      >
        <button
          onClick={() => setLeftSidebar('files')}
          className="flex-1 px-3 text-xs font-medium uppercase tracking-wider flex items-center justify-center gap-1.5 border-r cursor-pointer transition-colors"
          style={{
            borderColor: 'var(--sat-border)',
            backgroundColor:
              leftSidebar === 'files' ? 'var(--sat-bg-surface)' : 'var(--sat-bg-subtle)',
            color:
              leftSidebar === 'files'
                ? 'var(--sat-text-primary)'
                : 'var(--sat-text-muted)',
            borderBottom:
              leftSidebar === 'files'
                ? '2px solid var(--sat-accent)'
                : '2px solid transparent',
          }}
        >
          <Folder size={13} />
          <span>Arquivos</span>
        </button>

        <button
          onClick={() => setLeftSidebar('variables')}
          className="flex-1 px-3 text-xs font-medium uppercase tracking-wider flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
          style={{
            backgroundColor:
              leftSidebar === 'variables'
                ? 'var(--sat-bg-surface)'
                : 'var(--sat-bg-subtle)',
            color:
              leftSidebar === 'variables'
                ? 'var(--sat-text-primary)'
                : 'var(--sat-text-muted)',
            borderBottom:
              leftSidebar === 'variables'
                ? '2px solid var(--sat-accent)'
                : '2px solid transparent',
          }}
        >
          <Database size={13} />
          <span>Variáveis</span>
          {activeNotebook && activeNotebook.variables.length > 0 && (
            <span
              className="text-[10.5px] px-1.5 rounded-[2px] font-mono"
              style={{
                backgroundColor: 'var(--sat-bg-hover)',
                color: 'var(--sat-text-primary)',
              }}
            >
              {activeNotebook.variables.length}
            </span>
          )}
        </button>
      </div>

      {/* 1. ARQUIVOS */}
      {leftSidebar === 'files' && (
        <>
          <div
            className="px-2.5 py-1.5 flex items-center justify-between border-b"
            style={{ borderColor: 'var(--sat-border-subtle)' }}
          >
            <button
              onClick={() => createNewNotebook()}
              className="h-7 px-2.5 rounded-[3px] border text-xs font-medium flex items-center gap-1.5 cursor-pointer hover:opacity-90 transition-opacity"
              style={{
                backgroundColor: 'var(--sat-bg-subtle)',
                borderColor: 'var(--sat-border)',
                color: 'var(--sat-text-primary)',
              }}
            >
              <FilePlus size={13} style={{ color: 'var(--sat-accent)' }} />
              <span>Novo Notebook</span>
            </button>

            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setCreatingFolder((v) => !v)}
                title="Nova Pasta"
                className="p-1.5 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
                style={{ color: 'var(--sat-text-secondary)' }}
              >
                <FolderPlus size={14} />
              </button>
              <button
                onClick={() => refreshFiles()}
                title="Atualizar"
                className="p-1.5 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
                style={{ color: 'var(--sat-text-secondary)' }}
              >
                <RefreshCw size={13} />
              </button>
            </div>
          </div>

          {breadcrumbs.length > 0 && (
            <div
              className="px-2.5 py-1.5 text-xs flex items-center gap-1 flex-wrap border-b font-mono"
              style={{
                backgroundColor: 'var(--sat-bg-subtle)',
                borderColor: 'var(--sat-border-subtle)',
                color: 'var(--sat-text-secondary)',
              }}
            >
              <button
                onClick={() => refreshFiles('')}
                title={workspaceRoot}
                className="hover:underline flex items-center gap-1 cursor-pointer"
              >
                <Home size={12} />
                <span>/</span>
              </button>
              {breadcrumbs.map((seg, i) => {
                const subPath = breadcrumbs.slice(0, i + 1).join('/');
                return (
                  <React.Fragment key={subPath}>
                    <button
                      onClick={() => refreshFiles(subPath)}
                      className="hover:underline truncate max-w-[120px] cursor-pointer"
                    >
                      {seg}
                    </button>
                    <span>/</span>
                  </React.Fragment>
                );
              })}
            </div>
          )}

          {creatingFolder && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (newFolderName.trim()) {
                  await createNewFolder(newFolderName.trim());
                  setNewFolderName('');
                  setCreatingFolder(false);
                }
              }}
              className="p-2 border-b flex gap-1.5"
              style={{ borderColor: 'var(--sat-border-subtle)' }}
            >
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="Nome da pasta..."
                className="flex-1 px-2 py-1 text-xs rounded-[3px] border bg-transparent"
                style={{ borderColor: 'var(--sat-border)' }}
              />
              <button
                type="submit"
                className="px-2.5 py-1 text-xs rounded-[3px] font-medium cursor-pointer"
                style={{
                  backgroundColor: 'var(--sat-btn-primary-bg)',
                  color: 'var(--sat-btn-primary-text)',
                }}
              >
                OK
              </button>
            </form>
          )}

          <div className="flex-1 overflow-y-auto py-1">
            {currentDir && (
              <div
                onClick={() => {
                  const parent = breadcrumbs.slice(0, -1).join('/');
                  refreshFiles(parent);
                }}
                className="px-3 py-1.5 text-[13px] flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
                style={{ color: 'var(--sat-text-secondary)' }}
              >
                <Folder size={15} />
                <span>..</span>
              </div>
            )}

            {files.length === 0 && (
              <div
                className="px-4 py-8 text-center text-xs"
                style={{ color: 'var(--sat-text-muted)' }}
              >
                Pasta vazia.
              </div>
            )}

            {files.map((item) => {
              const isActive = activeTabId === item.path;
              const isRenaming = renamingPath === item.path;

              return (
                <div
                  key={item.path}
                  onClick={() => !isRenaming && openEntry(item)}
                  className="group px-3 py-1.5 text-[13.5px] flex items-center justify-between gap-2 cursor-pointer transition-colors"
                  style={{
                    backgroundColor: isActive ? 'var(--sat-bg-subtle)' : 'transparent',
                    color: 'var(--sat-text-primary)',
                    borderLeft: isActive
                      ? '2px solid var(--sat-accent)'
                      : '2px solid transparent',
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {item.type === 'directory' ? (
                      <Folder
                        size={15}
                        className="shrink-0"
                        style={{ color: 'var(--sat-text-secondary)' }}
                      />
                    ) : item.type === 'notebook' ? (
                      <FileCode
                        size={15}
                        className="shrink-0"
                        style={{ color: 'var(--sat-orange)' }}
                      />
                    ) : (
                      <FileText
                        size={15}
                        className="shrink-0"
                        style={{ color: 'var(--sat-text-muted)' }}
                      />
                    )}

                    {isRenaming ? (
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (renameVal.trim() && renameVal.trim() !== item.name) {
                            await renameEntry(item.path, renameVal.trim());
                          }
                          setRenamingPath(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1"
                      >
                        <input
                          autoFocus
                          value={renameVal}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onBlur={() => setRenamingPath(null)}
                          className="w-full px-1.5 py-0.5 text-xs border rounded-[2px] bg-transparent"
                          style={{ borderColor: 'var(--sat-border)' }}
                        />
                      </form>
                    ) : (
                      <span className={`truncate ${isActive ? 'font-medium' : ''}`}>
                        {item.name}
                      </span>
                    )}
                  </div>

                  {!isRenaming && (
                    <div
                      className="hidden group-hover:flex items-center gap-0.5 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => {
                          setRenamingPath(item.path);
                          setRenameVal(item.name);
                        }}
                        title="Renomear"
                        className="p-1 rounded-[2px] hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
                        style={{ color: 'var(--sat-text-secondary)' }}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Remover "${item.name}"?`)) {
                            deleteEntry(item.path);
                          }
                        }}
                        title="Excluir"
                        className="p-1 rounded-[2px] hover:bg-red-500/15 text-red-500 cursor-pointer"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* 2. VARIÁVEIS EM MEMÓRIA */}
      {leftSidebar === 'variables' && (
        <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
          {!activeNotebook ? (
            <p
              className="text-xs py-8 text-center"
              style={{ color: 'var(--sat-text-muted)' }}
            >
              Abra um notebook para inspecionar variáveis em memória.
            </p>
          ) : activeNotebook.variables.length === 0 ? (
            <p
              className="text-xs py-8 px-2 text-center leading-relaxed"
              style={{ color: 'var(--sat-text-muted)' }}
            >
              Nenhuma variável carregada ainda. Execute uma célula para inspecionar o
              estado do kernel.
            </p>
          ) : (
            activeNotebook.variables.map((v) => (
              <div
                key={v.name}
                className="p-2.5 rounded-[4px] border space-y-1"
                style={{
                  backgroundColor: 'var(--sat-bg-subtle)',
                  borderColor: 'var(--sat-border)',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="font-mono font-semibold text-xs"
                    style={{ color: 'var(--sat-accent)' }}
                  >
                    {v.name}
                  </span>
                  <span
                    className="text-[11px] px-1.5 py-0.5 rounded-[2px] font-mono border"
                    style={{
                      backgroundColor: 'var(--sat-bg-surface)',
                      borderColor: 'var(--sat-border)',
                      color: 'var(--sat-text-secondary)',
                    }}
                  >
                    {v.type} {v.shape}
                  </span>
                </div>
                {v.preview && (
                  <div
                    className="text-[11.5px] font-mono break-words leading-relaxed"
                    style={{ color: 'var(--sat-text-muted)' }}
                  >
                    {v.preview}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </aside>
  );
};
