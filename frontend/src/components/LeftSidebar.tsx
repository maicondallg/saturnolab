import React, { useMemo, useRef, useState } from 'react';
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Columns2,
  Database,
  FileCode,
  FilePlus,
  Folder,
  FolderInput,
  FolderPlus,
  PanelLeft,
  PanelRight,
  Pencil,
  RefreshCw,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { FileEntry, OpenNotebookTab } from '../types/notebook';
import {
  collectAllFolders,
  flattenVisibleTree,
  formatModifiedShort,
  formatModifiedTooltip,
} from '../utils/fileUtils';
import { FileTypeIcon } from './FileTypeIcon';

export const LeftSidebar: React.FC = () => {
  const {
    leftSidebar,
    setLeftSidebar,
    sidebarPosition,
    toggleSidebarPosition,
    sidebarWidth,
    setSidebarWidth,
    showModifiedTime,
    files,
    expandedFolders,
    toggleFolderExpanded,
    collapseAllFolders,
    activeFolderContext,
    setActiveFolderContext,
    selectedFilePaths,
    toggleFileSelection,
    selectFileRange,
    selectAllFiles,
    clearFileSelection,
    refreshFiles,
    openEntry,
    createNewNotebook,
    createNewFile,
    createNewFolder,
    renameEntry,
    deleteEntry,
    deleteBatchEntries,
    moveEntries,
    tabs,
    activeTabId,
  } = useSaturnoStore();

  const [createMode, setCreateMode] = useState<'folder' | 'file' | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [moveTargetFolder, setMoveTargetFolder] = useState('');
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const sidebarRef = useRef<HTMLElement>(null);

  const visibleNodes = useMemo(
    () => flattenVisibleTree(files, expandedFolders),
    [files, expandedFolders]
  );

  const visiblePaths = useMemo(
    () => visibleNodes.map((n) => n.entry.path),
    [visibleNodes]
  );

  const availableDestinationFolders = useMemo(
    () => collectAllFolders(files, new Set(selectedFilePaths)),
    [files, selectedFilePaths]
  );

  if (!leftSidebar) return null;

  const activeNotebook = tabs.find(
    (t): t is OpenNotebookTab => t.id === activeTabId && t.kind === 'notebook'
  );

  const hasSelection = selectedFilePaths.length > 0;

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (moveEvt: MouseEvent) => {
      const delta =
        sidebarPosition === 'left'
          ? moveEvt.clientX - startX
          : startX - moveEvt.clientX;
      setSidebarWidth(startWidth + delta, false);
    };

    const onMouseUp = (upEvt: MouseEvent) => {
      const delta =
        sidebarPosition === 'left'
          ? upEvt.clientX - startX
          : startX - upEvt.clientX;
      setSidebarWidth(startWidth + delta, true);
      setIsResizing(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleRowClick = (e: React.MouseEvent, entry: FileEntry) => {
    if (renamingPath === entry.path) return;

    if (e.shiftKey) {
      e.preventDefault();
      selectFileRange(visiblePaths, entry.path);
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleFileSelection(entry.path, false);
      return;
    }

    if (entry.type === 'directory') {
      setActiveFolderContext(entry.path);
      toggleFolderExpanded(entry.path);
    } else {
      const parentParts = entry.path.split('/');
      parentParts.pop();
      setActiveFolderContext(parentParts.join('/'));
      openEntry(entry);
    }
  };

  const handleDropOnFolder = async (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolder(null);
    const raw = e.dataTransfer.getData('application/x-saturno-paths');
    if (!raw) return;
    try {
      const paths: string[] = JSON.parse(raw);
      if (paths.length > 0) {
        await moveEntries(paths, targetFolder);
      }
    } catch {
      // ignore invalid drag payload
    }
  };

  return (
    <aside
      ref={sidebarRef}
      style={{
        width: `${sidebarWidth}px`,
        backgroundColor: 'var(--sat-bg-surface)',
        borderColor: 'var(--sat-border)',
      }}
      className={`relative flex flex-col h-full shrink-0 select-none overflow-hidden ${
        sidebarPosition === 'left' ? 'border-r' : 'border-l'
      }`}
    >
      {/* Flush Header Tabs: Arquivos | Variáveis + Position Toggle */}
      <div
        className="h-9 flex items-stretch border-b shrink-0"
        style={{ borderColor: 'var(--sat-border)' }}
      >
        <button
          onClick={() => setLeftSidebar('files')}
          className="flex-1 px-2.5 text-xs font-medium uppercase tracking-wider flex items-center justify-center gap-1.5 border-r cursor-pointer transition-colors"
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
          className="flex-1 px-2.5 text-xs font-medium uppercase tracking-wider flex items-center justify-center gap-1.5 border-r cursor-pointer transition-colors"
          style={{
            borderColor: 'var(--sat-border)',
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

        <button
          onClick={toggleSidebarPosition}
          title={
            sidebarPosition === 'left'
              ? 'Mover barra lateral para a direita'
              : 'Mover barra lateral para a esquerda'
          }
          className="px-2 flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors shrink-0"
          style={{
            backgroundColor: 'var(--sat-bg-subtle)',
            color: 'var(--sat-text-secondary)',
          }}
        >
          {sidebarPosition === 'left' ? <PanelRight size={14} /> : <PanelLeft size={14} />}
        </button>
      </div>

      {/* 1. ARQUIVOS (Tree Explorer) */}
      {leftSidebar === 'files' && (
        <>
          {/* Action Toolbar */}
          <div
            className="px-2 py-1.5 flex items-center justify-between border-b gap-1"
            style={{ borderColor: 'var(--sat-border-subtle)' }}
          >
            <div className="flex items-center gap-1 min-w-0">
              <button
                onClick={() => createNewNotebook(activeFolderContext)}
                title={
                  activeFolderContext
                    ? `Novo Notebook em /${activeFolderContext}`
                    : 'Novo Notebook na raiz'
                }
                className="h-7 px-2 rounded-[3px] border text-xs font-medium flex items-center gap-1 cursor-pointer hover:opacity-90 transition-opacity shrink-0"
                style={{
                  backgroundColor: 'var(--sat-bg-subtle)',
                  borderColor: 'var(--sat-border)',
                  color: 'var(--sat-text-primary)',
                }}
              >
                <FilePlus size={13} style={{ color: 'var(--sat-orange)' }} />
                <span>+ Notebook</span>
              </button>

              <button
                onClick={() => {
                  setCreateMode((m) => (m === 'file' ? null : 'file'));
                  setNewItemName('script.py');
                }}
                title="Criar novo arquivo (.py, .md, .txt...)"
                className="h-7 px-2 rounded-[3px] border text-xs font-medium flex items-center gap-1 cursor-pointer hover:opacity-90 transition-opacity shrink-0"
                style={{
                  backgroundColor: 'var(--sat-bg-subtle)',
                  borderColor: 'var(--sat-border)',
                  color: 'var(--sat-text-primary)',
                }}
              >
                <FileCode size={13} style={{ color: 'var(--sat-type-py)' }} />
                <span>.py</span>
              </button>
            </div>

            <div className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={() => {
                  setCreateMode((m) => (m === 'folder' ? null : 'folder'));
                  setNewItemName('');
                }}
                title="Nova Pasta"
                className="p-1.5 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
                style={{ color: 'var(--sat-text-secondary)' }}
              >
                <FolderPlus size={14} />
              </button>
              <button
                onClick={collapseAllFolders}
                title="Recolher todas as pastas"
                className="p-1.5 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
                style={{ color: 'var(--sat-text-secondary)' }}
              >
                <ChevronsDownUp size={13} />
              </button>
              <button
                onClick={() => refreshFiles()}
                title="Atualizar árvore de arquivos"
                className="p-1.5 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
                style={{ color: 'var(--sat-text-secondary)' }}
              >
                <RefreshCw size={13} />
              </button>
            </div>
          </div>

          {/* Active target folder indicator when creating inside a subfolder */}
          {activeFolderContext && (
            <div
              className="px-2.5 py-1 text-[11px] flex items-center justify-between border-b font-mono"
              style={{
                backgroundColor: 'var(--sat-bg-subtle)',
                borderColor: 'var(--sat-border-subtle)',
                color: 'var(--sat-text-secondary)',
              }}
            >
              <span className="truncate" title={`Pasta alvo: /${activeFolderContext}`}>
                Alvo: /{activeFolderContext}
              </span>
              <button
                onClick={() => setActiveFolderContext('')}
                title="Voltar alvo para a raiz /"
                className="px-1 rounded-[2px] hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
              >
                <X size={11} />
              </button>
            </div>
          )}

          {/* Create Folder or File Inline Input */}
          {createMode && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const clean = newItemName.trim();
                if (!clean) return;
                if (createMode === 'folder') {
                  await createNewFolder(clean, activeFolderContext);
                } else {
                  await createNewFile(activeFolderContext, clean);
                }
                setNewItemName('');
                setCreateMode(null);
              }}
              className="p-2 border-b space-y-1.5"
              style={{
                backgroundColor: 'var(--sat-bg-subtle)',
                borderColor: 'var(--sat-border)',
              }}
            >
              <div className="text-[11px] font-medium flex items-center justify-between">
                <span style={{ color: 'var(--sat-text-secondary)' }}>
                  {createMode === 'folder' ? 'Nova pasta' : 'Novo arquivo'}{' '}
                  {activeFolderContext ? `em /${activeFolderContext}` : 'na raiz /'}
                </span>
                <button
                  type="button"
                  onClick={() => setCreateMode(null)}
                  className="opacity-70 hover:opacity-100 cursor-pointer"
                >
                  <X size={12} />
                </button>
              </div>
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  placeholder={
                    createMode === 'folder' ? 'Nome da pasta...' : 'Ex: analise.py'
                  }
                  className="flex-1 px-2 py-1 text-xs rounded-[3px] border bg-transparent font-mono focus:outline-none"
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
                  Criar
                </button>
              </div>
            </form>
          )}

          {/* Multi-Select Batch Action Bar */}
          {hasSelection && (
            <div
              className="px-2.5 py-1.5 border-b space-y-1.5"
              style={{
                backgroundColor: 'var(--sat-bg-subtle)',
                borderColor: 'var(--sat-border)',
              }}
            >
              <div className="flex items-center justify-between gap-1 text-xs">
                <div className="flex items-center gap-1.5 font-medium">
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedFilePaths.length === visiblePaths.length) {
                        clearFileSelection();
                      } else {
                        selectAllFiles(visiblePaths);
                      }
                    }}
                    title="Selecionar todos / limpar"
                    className="cursor-pointer flex items-center"
                    style={{ color: 'var(--sat-accent)' }}
                  >
                    <CheckSquare size={13} />
                  </button>
                  <span>{selectedFilePaths.length} selecionado(s)</span>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setShowMoveMenu((v) => !v);
                      setMoveTargetFolder('');
                    }}
                    title="Mover itens selecionados para outra pasta"
                    className="h-6 px-2 rounded-[2px] border text-[11px] font-medium flex items-center gap-1 cursor-pointer hover:opacity-90"
                    style={{
                      backgroundColor: 'var(--sat-bg-surface)',
                      borderColor: 'var(--sat-border)',
                    }}
                  >
                    <FolderInput size={12} />
                    <span>Mover</span>
                  </button>

                  <button
                    type="button"
                    onClick={async () => {
                      const selectedEntries = visibleNodes
                        .map((n) => n.entry)
                        .filter(
                          (e) =>
                            selectedFilePaths.includes(e.path) && e.type !== 'directory'
                        );
                      for (let i = 0; i < selectedEntries.length; i++) {
                        await openEntry(selectedEntries[i], {
                          sideBySide: i > 0 || selectedEntries.length === 1,
                        });
                      }
                    }}
                    title="Abrir selecionados lado a lado"
                    className="h-6 px-1.5 rounded-[2px] border text-[11px] flex items-center gap-1 cursor-pointer hover:opacity-90"
                    style={{
                      backgroundColor: 'var(--sat-bg-surface)',
                      borderColor: 'var(--sat-border)',
                    }}
                  >
                    <Columns2 size={12} />
                  </button>

                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        window.confirm(
                          `Excluir ${selectedFilePaths.length} item(ns) selecionado(s)?`
                        )
                      ) {
                        await deleteBatchEntries(selectedFilePaths);
                      }
                    }}
                    title="Excluir selecionados"
                    className="h-6 px-1.5 rounded-[2px] border text-[11px] flex items-center gap-1 text-red-400 hover:bg-red-500/15 cursor-pointer"
                    style={{ borderColor: 'var(--sat-border)' }}
                  >
                    <Trash2 size={12} />
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      clearFileSelection();
                      setShowMoveMenu(false);
                    }}
                    title="Limpar seleção"
                    className="h-6 w-6 rounded-[2px] flex items-center justify-center hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>

              {showMoveMenu && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await moveEntries(selectedFilePaths, moveTargetFolder);
                    setShowMoveMenu(false);
                  }}
                  className="flex items-center gap-1.5 pt-1"
                >
                  <select
                    value={moveTargetFolder}
                    onChange={(e) => setMoveTargetFolder(e.target.value)}
                    className="flex-1 h-7 px-2 rounded-[3px] border text-xs font-mono"
                    style={{
                      backgroundColor: 'var(--sat-bg-surface)',
                      borderColor: 'var(--sat-border)',
                      color: 'var(--sat-text-primary)',
                    }}
                  >
                    {availableDestinationFolders.map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="h-7 px-2.5 rounded-[3px] text-xs font-medium cursor-pointer shrink-0"
                    style={{
                      backgroundColor: 'var(--sat-btn-primary-bg)',
                      color: 'var(--sat-btn-primary-text)',
                    }}
                  >
                    Confirmar
                  </button>
                </form>
              )}
            </div>
          )}

          {/* Tree View List */}
          <div
            className="flex-1 overflow-y-auto py-1"
            onDragOver={(e) => {
              e.preventDefault();
              if (e.target === e.currentTarget) {
                setDragOverFolder('__root__');
              }
            }}
            onDragLeave={(e) => {
              if (e.target === e.currentTarget) {
                setDragOverFolder(null);
              }
            }}
            onDrop={(e) => handleDropOnFolder(e, '')}
          >
            {visibleNodes.length === 0 && (
              <div
                className="px-4 py-8 text-center text-xs"
                style={{ color: 'var(--sat-text-muted)' }}
              >
                Pasta vazia.
              </div>
            )}

            {visibleNodes.map(({ entry: item, depth }) => {
              const isActive = activeTabId === item.path;
              const isSelected = selectedFilePaths.includes(item.path);
              const isRenaming = renamingPath === item.path;
              const isDir = item.type === 'directory';
              const isExpanded = Boolean(expandedFolders[item.path]);
              const isDropTarget = isDir && dragOverFolder === item.path;
              const modTimeStr = showModifiedTime ? formatModifiedShort(item.modified) : '';

              return (
                <div
                  key={item.path}
                  draggable={!isRenaming}
                  onDragStart={(e) => {
                    const pathsToDrag = isSelected
                      ? selectedFilePaths
                      : [item.path];
                    e.dataTransfer.setData(
                      'application/x-saturno-paths',
                      JSON.stringify(pathsToDrag)
                    );
                    e.dataTransfer.setData(
                      'application/x-saturno-entry',
                      JSON.stringify(item)
                    );
                    e.dataTransfer.effectAllowed = 'copyMove';
                  }}
                  onDragOver={(e) => {
                    if (isDir) {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverFolder(item.path);
                    }
                  }}
                  onDragLeave={(e) => {
                    if (isDir) {
                      e.stopPropagation();
                      if (dragOverFolder === item.path) {
                        setDragOverFolder(null);
                      }
                    }
                  }}
                  onDrop={(e) => {
                    if (isDir) {
                      handleDropOnFolder(e, item.path);
                    }
                  }}
                  onClick={(e) => handleRowClick(e, item)}
                  title={formatModifiedTooltip(item)}
                  style={{
                    paddingLeft: `${depth * 14 + 8}px`,
                    paddingRight: '8px',
                    color: 'var(--sat-text-primary)',
                  }}
                  className={`saturno-file-row group py-1.5 text-[13px] flex items-center justify-between gap-1.5 cursor-pointer ${
                    isActive ? 'is-active' : ''
                  } ${isSelected ? 'is-selected' : ''} ${
                    isDropTarget ? 'is-drop-target' : ''
                  }`}
                >
                  {/* Left: Checkbox + Chevron (if folder) + Colorful Icon + Name */}
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    {/* Multi-select checkbox (visible on hover or when any item is selected) */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (e.shiftKey) {
                          selectFileRange(visiblePaths, item.path);
                        } else {
                          toggleFileSelection(item.path, false);
                        }
                      }}
                      title="Selecionar item (Ctrl+Clique ou Shift+Clique)"
                      className={`shrink-0 p-0.5 rounded-[2px] cursor-pointer transition-opacity ${
                        isSelected || hasSelection
                          ? 'opacity-100'
                          : 'opacity-0 group-hover:opacity-75 hover:!opacity-100'
                      }`}
                      style={{
                        color: isSelected
                          ? 'var(--sat-accent)'
                          : 'var(--sat-text-muted)',
                      }}
                    >
                      {isSelected ? <CheckSquare size={13} /> : <Square size={13} />}
                    </button>

                    {/* Tree Chevron for directories */}
                    {isDir ? (
                      <span
                        className="w-3.5 h-3.5 inline-flex items-center justify-center shrink-0"
                        style={{ color: 'var(--sat-text-muted)' }}
                      >
                        {isExpanded ? (
                          <ChevronDown size={13} />
                        ) : (
                          <ChevronRight size={13} />
                        )}
                      </span>
                    ) : (
                      <span className="w-1 shrink-0" />
                    )}

                    <FileTypeIcon
                      name={item.name}
                      type={item.type}
                      isOpenFolder={isExpanded}
                      size={15}
                      showBadge={!isDir}
                    />

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
                        className="flex-1 min-w-0"
                      >
                        <input
                          autoFocus
                          value={renameVal}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onBlur={() => setRenamingPath(null)}
                          className="w-full px-1.5 py-0.5 text-xs border rounded-[2px] bg-transparent font-mono"
                          style={{ borderColor: 'var(--sat-border)' }}
                        />
                      </form>
                    ) : (
                      <span
                        className={`truncate ${
                          isActive || isSelected ? 'font-medium' : ''
                        }`}
                      >
                        {item.name}
                      </span>
                    )}
                  </div>

                  {/* Right: Modification Time (hidden on hover when action buttons appear) + Action Buttons */}
                  {!isRenaming && (
                    <div className="flex items-center gap-1 shrink-0">
                      {modTimeStr && (
                        <span
                          className="group-hover:hidden text-[10.5px] font-mono opacity-65 whitespace-nowrap"
                          style={{ color: 'var(--sat-text-muted)' }}
                        >
                          {modTimeStr}
                        </span>
                      )}

                      <div
                        className="hidden group-hover:flex items-center gap-0.5 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {!isDir && (
                          <button
                            onClick={() => openEntry(item, { sideBySide: true })}
                            title="Abrir lado a lado (Split View)"
                            className="p-1 rounded-[2px] hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
                            style={{ color: 'var(--sat-text-secondary)' }}
                          >
                            <Columns2 size={12} />
                          </button>
                        )}
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

      {/* Interactive Resize Handle on Inner Edge */}
      <div
        onMouseDown={startResize}
        onDoubleClick={() => setSidebarWidth(280, true)}
        title="Arraste para ajustar a largura (duplo clique para 280px)"
        className={`absolute top-0 bottom-0 w-1.5 z-20 cursor-col-resize transition-colors ${
          sidebarPosition === 'left' ? 'right-0' : 'left-0'
        } ${isResizing ? 'bg-amber-500/60' : 'hover:bg-amber-500/40'}`}
      />
    </aside>
  );
};
