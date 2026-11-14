import { useShallow } from 'zustand/react/shallow';
import React, { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Columns2, Plus, Rocket, X } from 'lucide-react';
import { useSaturnoStore } from './store/useSaturnoStore';
import { StatusBar } from './components/StatusBar';
import { MenuBar } from './components/MenuBar';
import { LeftSidebar } from './components/LeftSidebar';
import { LauncherView } from './components/LauncherView';
import { FileTypeIcon } from './components/FileTypeIcon';
import { FileEntry } from './types/notebook';

const NotebookView = lazy(() => import('./components/NotebookView').then((m) => ({ default: m.NotebookView })));
const TextFileEditor = lazy(() => import('./components/TextFileEditor').then((m) => ({ default: m.TextFileEditor })));
const FolderPickerModal = lazy(() => import('./components/FolderPickerModal').then((m) => ({ default: m.FolderPickerModal })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal })));

export const App: React.FC = () => {
  const {
    showFolderModal,
    showSettingsModal,
    initialize,
    tabs,
    panes,
    activePaneId,
    sidebarPosition,
    setActivePane,
    setActiveTab,
    closeTab,
    splitTab,
    moveTabToPane,
    closePane,
    setPaneWidths,
    openLauncher,
    openEntry,
  } = useSaturnoStore(useShallow((s) => ({
    showFolderModal: s.showFolderModal,
    showSettingsModal: s.showSettingsModal,
    initialize: s.initialize,
    tabs: s.tabs,
    panes: s.panes,
    activePaneId: s.activePaneId,
    sidebarPosition: s.sidebarPosition,
    setActivePane: s.setActivePane,
    setActiveTab: s.setActiveTab,
    closeTab: s.closeTab,
    splitTab: s.splitTab,
    moveTabToPane: s.moveTabToPane,
    closePane: s.closePane,
    setPaneWidths: s.setPaneWidths,
    openLauncher: s.openLauncher,
    openEntry: s.openEntry,
  })));

  const [dragDropZone, setDragDropZone] = useState<{
    paneId: string;
    zone: 'center' | 'left' | 'right';
  } | null>(null);

  const workspaceContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'b'
      ) {
        e.preventDefault();
        const curr = useSaturnoStore.getState().leftSidebar;
        useSaturnoStore.getState().setLeftSidebar(curr ? null : 'files');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const startPaneResize = (e: React.MouseEvent, leftPaneIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const leftPane = panes[leftPaneIdx];
    const rightPane = panes[leftPaneIdx + 1];
    if (!leftPane || !rightPane || !workspaceContainerRef.current) return;

    const containerWidth = workspaceContainerRef.current.getBoundingClientRect().width;
    const totalRatio = panes.reduce((acc, p) => acc + p.widthRatio, 0);
    const startX = e.clientX;
    const startLeftRatio = leftPane.widthRatio;
    const startRightRatio = rightPane.widthRatio;

    const onMouseMove = (moveEvt: MouseEvent) => {
      const deltaPx = moveEvt.clientX - startX;
      const deltaRatio = (deltaPx / Math.max(1, containerWidth)) * totalRatio;
      const minRatio = totalRatio * 0.15;
      const maxLeft = startLeftRatio + startRightRatio - minRatio;
      const nextLeft = Math.max(minRatio, Math.min(maxLeft, startLeftRatio + deltaRatio));
      const nextRight = startLeftRatio + startRightRatio - nextLeft;
      setPaneWidths({
        [leftPane.id]: nextLeft,
        [rightPane.id]: nextRight,
      });
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const resetEqualWidths = () => {
    const map: Record<string, number> = {};
    panes.forEach((p) => {
      map[p.id] = 1;
    });
    setPaneWidths(map);
  };

  const handleDropOnPane = async (
    e: React.DragEvent,
    targetPaneId: string,
    zone: 'center' | 'left' | 'right'
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setDragDropZone(null);

    const tabDataRaw = e.dataTransfer.getData('application/x-saturno-tab');
    if (tabDataRaw) {
      try {
        const { tabId, sourcePaneId } = JSON.parse(tabDataRaw);
        if (zone === 'left' || zone === 'right') {
          splitTab(tabId, targetPaneId, zone);
        } else {
          moveTabToPane(tabId, sourcePaneId, targetPaneId);
        }
        return;
      } catch {
        // ignore
      }
    }

    const entriesRaw = e.dataTransfer.getData('application/x-saturno-entries');
    const entryRaw = e.dataTransfer.getData('application/x-saturno-entry');
    if (entriesRaw || entryRaw) {
      try {
        const entries: FileEntry[] = entriesRaw ? JSON.parse(entriesRaw) : [JSON.parse(entryRaw)];
        let destination = targetPaneId;
        for (const entry of entries.filter(entry => entry.type !== 'directory')) {
          await openEntry(entry, { targetPaneId: destination });
          if (zone !== 'center' && destination === targetPaneId) {
            splitTab(entry.path, targetPaneId, zone);
            destination = useSaturnoStore.getState().activePaneId;
          }
        }
      } catch (error) {
        useSaturnoStore.setState({statusMessage: `Não foi possível abrir: ${String(error)}`});
      }
    }
  };

  return (
    <div className="h-dvh w-full flex flex-col overflow-hidden">
      <MenuBar />

      <div className="relative flex-1 flex min-h-0 overflow-hidden">
        {sidebarPosition === 'left' && <LeftSidebar />}

        <main
          ref={workspaceContainerRef}
          className="flex-1 flex min-w-0 min-h-0 overflow-hidden"
        >
          {panes.map((pane, paneIdx) => {
            const isPaneFocused = pane.id === activePaneId;
            const paneTabs = pane.tabIds
              .map((tid) => tabs.find((t) => t.id === tid))
              .filter((t): t is NonNullable<typeof t> => Boolean(t));
            const activeTab =
              paneTabs.find((t) => t.id === pane.activeTabId) || paneTabs[0];
            const dropInfo =
              dragDropZone?.paneId === pane.id ? dragDropZone.zone : null;

            return (
              <React.Fragment key={pane.id}>
                <section
                  onMouseDownCapture={() => {
                    if (!isPaneFocused) {
                      setActivePane(pane.id);
                    }
                  }}
                  onDragOver={(e) => {
                    const hasTab = e.dataTransfer.types.includes(
                      'application/x-saturno-tab'
                    );
                    const hasEntry = e.dataTransfer.types.includes(
                      'application/x-saturno-entry'
                    );
                    if (!hasTab && !hasEntry) return;
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
                    const zone: 'left' | 'right' | 'center' =
                      relX < 0.22 ? 'left' : relX > 0.78 ? 'right' : 'center';
                    if (
                      dragDropZone?.paneId !== pane.id ||
                      dragDropZone?.zone !== zone
                    ) {
                      setDragDropZone({ paneId: pane.id, zone });
                    }
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      setDragDropZone(null);
                    }
                  }}
                  onDrop={(e) =>
                    handleDropOnPane(e, pane.id, dropInfo || 'center')
                  }
                  style={{ flex: `${pane.widthRatio} 1 0%` }}
                  className="relative flex flex-col min-w-0 min-h-0 overflow-hidden"
                >
                  {/* Pane Tab Bar */}
                  <div
                    className="h-9 flex items-stretch justify-between border-b select-none shrink-0 overflow-hidden"
                    style={{
                      backgroundColor: 'var(--sat-bg-subtle)',
                      borderColor: 'var(--sat-border)',
                    }}
                  >
                    <div
                      onWheel={(e) => {
                        if (e.deltaY !== 0) {
                          e.currentTarget.scrollLeft += e.deltaY;
                        }
                      }}
                      className="flex items-stretch overflow-x-auto overflow-y-hidden no-scrollbar min-w-0 flex-1"
                    >
                      {paneTabs.map((tab) => {
                        const isSelected = tab.id === activeTab?.id;
                        const isDirty = tab.kind !== 'launcher' && tab.dirty;

                        const requestCloseTab = () => {
                          const openInOtherPane = panes.some(
                            (p) =>
                              p.id !== pane.id && p.tabIds.includes(tab.id)
                          );
                          if (
                            isDirty &&
                            !openInOtherPane &&
                            !window.confirm(
                              `Fechar "${tab.name}" sem salvar alterações?`
                            )
                          ) {
                            return;
                          }
                          closeTab(tab.id, pane.id);
                        };

                        return (
                          <div
                            key={`${pane.id}_${tab.id}`}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData(
                                'application/x-saturno-tab',
                                JSON.stringify({
                                  tabId: tab.id,
                                  sourcePaneId: pane.id,
                                })
                              );
                              e.dataTransfer.effectAllowed = 'move';
                            }}
                            onMouseDown={(e) => {
                              if (e.button === 1) {
                                e.preventDefault();
                              }
                            }}
                            onAuxClick={(e) => {
                              if (e.button === 1) {
                                e.preventDefault();
                                e.stopPropagation();
                                requestCloseTab();
                              }
                            }}
                            onClick={() => setActiveTab(tab.id, pane.id)}
                            title={`${tab.name} (Clique do meio para fechar)`}
                            className="group/tab px-3 flex items-center gap-2 border-r text-xs cursor-pointer shrink-0 max-w-[240px] transition-colors"
                            style={{
                              backgroundColor: isSelected
                                ? 'var(--sat-bg-surface)'
                                : 'var(--sat-bg-subtle)',
                              color: isSelected
                                ? 'var(--sat-text-primary)'
                                : 'var(--sat-text-muted)',
                              borderColor: 'var(--sat-border)',
                              borderTop: isSelected
                                ? isPaneFocused
                                  ? '2px solid var(--sat-accent)'
                                  : '2px solid var(--sat-border-strong)'
                                : '2px solid transparent',
                            }}
                          >
                            {tab.kind === 'launcher' ? (
                              <Rocket
                                size={14}
                                className="shrink-0"
                                style={{ color: 'var(--sat-text-secondary)' }}
                              />
                            ) : (
                              <FileTypeIcon
                                name={tab.name}
                                type={tab.kind === 'notebook' ? 'notebook' : 'file'}
                                size={14}
                              />
                            )}

                            <span
                              className={`truncate ${isSelected ? 'font-medium' : ''}`}
                            >
                              {tab.name}
                            </span>

                            <div className="flex items-center gap-0.5 ml-1">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  splitTab(tab.id, pane.id, 'right');
                                }}
                                title="Abrir aba lado a lado (Split View)"
                                className="opacity-0 group-hover/tab:opacity-80 hover:!opacity-100 p-0.5 rounded-[2px] hover:bg-[var(--sat-bg-hover)] cursor-pointer transition-opacity"
                              >
                                <Columns2 size={12} />
                              </button>

                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestCloseTab();
                                }}
                                title="Fechar aba (ou clique com botão do meio)"
                                className="p-0.5 rounded-[2px] hover:bg-[var(--sat-bg-hover)] cursor-pointer transition-colors"
                              >
                                {isDirty ? (
                                  <span
                                    className="w-2 h-2 rounded-full inline-block"
                                    style={{ backgroundColor: 'var(--sat-accent)' }}
                                  />
                                ) : (
                                  <X size={13} />
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}

                      <button
                        onClick={() => {
                          setActivePane(pane.id);
                          openLauncher(pane.id);
                        }}
                        title="Abrir Launcher"
                        className="px-2.5 flex items-center justify-center hover:bg-[var(--sat-bg-hover)] hover:text-[var(--sat-text-primary)] transition-colors cursor-pointer shrink-0"
                        style={{ color: 'var(--sat-text-muted)' }}
                      >
                        <Plus size={15} />
                      </button>
                    </div>

                    {/* Right-side Pane Split / Close Controls */}
                    <div
                      className="flex items-center px-1.5 gap-0.5 border-l shrink-0"
                      style={{ borderColor: 'var(--sat-border)' }}
                    >
                      {panes.length > 1 && (
                        <button
                          onClick={() => closePane(pane.id)}
                          title="Fechar este painel dividido (mantendo abas abertas)"
                          className="h-6 w-6 rounded-[2px] flex items-center justify-center hover:bg-[var(--sat-bg-hover)] hover:text-[var(--sat-text-primary)] transition-colors cursor-pointer"
                          style={{ color: 'var(--sat-text-muted)' }}
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Active Tab Content */}
                  <div className="flex-1 min-h-0 overflow-hidden relative">
                    <Suspense fallback={<div role="status" className="p-4 text-sm">Carregando…</div>}>
                      {activeTab?.kind === 'notebook' && (
                        <NotebookView
                          tab={activeTab}
                          isActivePane={isPaneFocused}
                        />
                      )}
                      {activeTab?.kind === 'launcher' && <LauncherView />}
                      {activeTab?.kind === 'file' && (
                        <TextFileEditor tab={activeTab} />
                      )}
                    </Suspense>

                    {/* Visual Drop Zone Overlay when dragging a tab or file */}
                    {dropInfo && (
                      <div
                        className={`pointer-events-none absolute top-0 bottom-0 z-30 border-2 border-dashed flex items-center justify-center transition-all ${
                          dropInfo === 'left'
                            ? 'left-0 w-1/2'
                            : dropInfo === 'right'
                              ? 'right-0 w-1/2'
                              : 'inset-0'
                        }`}
                        style={{
                          backgroundColor: 'var(--sat-accent-soft)',
                          borderColor: 'var(--sat-accent)',
                        }}
                      >
                        <span
                          className="px-3 py-1.5 rounded-[4px] border text-xs font-medium shadow-lg"
                          style={{
                            backgroundColor: 'var(--sat-bg-surface)',
                            borderColor: 'var(--sat-border)',
                            color: 'var(--sat-text-primary)',
                          }}
                        >
                          {dropInfo === 'left'
                            ? 'Abrir Lado Esquerdo'
                            : dropInfo === 'right'
                              ? 'Abrir Lado Direito'
                              : 'Abrir neste Painel'}
                        </span>
                      </div>
                    )}
                  </div>
                </section>

                {/* Resizable Vertical Divider between Side-by-Side Panes */}
                {paneIdx < panes.length - 1 && (
                  <div
                    onMouseDown={(e) => startPaneResize(e, paneIdx)}
                    onDoubleClick={resetEqualWidths}
                    title="Arraste para redimensionar painéis (duplo clique para 50/50)"
                    className="w-1.5 shrink-0 cursor-col-resize hover:bg-amber-500/40 active:bg-amber-500/60 transition-colors border-x"
                    style={{
                      backgroundColor: 'var(--sat-bg-subtle)',
                      borderColor: 'var(--sat-border)',
                    }}
                  />
                )}
              </React.Fragment>
            );
          })}
        </main>

        {sidebarPosition === 'right' && <LeftSidebar />}
      </div>

      <StatusBar />

      <Suspense fallback={null}>
        {showFolderModal && <FolderPickerModal />}
        {showSettingsModal && <SettingsModal />}
      </Suspense>
    </div>
  );
};

export default App;
