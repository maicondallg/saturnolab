import React, { useEffect } from 'react';
import { FileCode, FileText, Plus, Rocket, X } from 'lucide-react';
import { useSaturnoStore } from './store/useSaturnoStore';
import { MenuBar } from './components/MenuBar';
import { LeftSidebar } from './components/LeftSidebar';
import { NotebookView } from './components/NotebookView';
import { LauncherView } from './components/LauncherView';
import { TextFileEditor } from './components/TextFileEditor';
import { FolderPickerModal } from './components/FolderPickerModal';
import { AISettingsModal } from './components/AISettingsModal';
import { ShortcutsModal } from './components/ShortcutsModal';

export const App: React.FC = () => {
  const {
    initialize,
    tabs,
    activeTabId,
    setActiveTab,
    closeTab,
    createNewNotebook,
  } = useSaturnoStore();

  useEffect(() => {
    initialize();
  }, [initialize]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden">
      <MenuBar />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <LeftSidebar />

        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Flush Technical Tab Bar (JupyterLab / VS Code style) */}
          <div
            className="h-9 flex items-stretch overflow-x-auto border-b select-none shrink-0"
            style={{
              backgroundColor: 'var(--sat-bg-subtle)',
              borderColor: 'var(--sat-border)',
            }}
          >
            {tabs.map((tab) => {
              const isSelected = tab.id === activeTab?.id;
              const isDirty = tab.kind !== 'launcher' && tab.dirty;

              return (
                <div
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="px-3.5 flex items-center gap-2 border-r text-xs cursor-pointer shrink-0 max-w-[230px] transition-colors"
                  style={{
                    backgroundColor: isSelected
                      ? 'var(--sat-bg-surface)'
                      : 'var(--sat-bg-subtle)',
                    color: isSelected
                      ? 'var(--sat-text-primary)'
                      : 'var(--sat-text-muted)',
                    borderColor: 'var(--sat-border)',
                    borderTop: isSelected
                      ? '2px solid var(--sat-accent)'
                      : '2px solid transparent',
                  }}
                >
                  {tab.kind === 'notebook' ? (
                    <FileCode
                      size={14}
                      className="shrink-0"
                      style={{ color: 'var(--sat-orange)' }}
                    />
                  ) : tab.kind === 'launcher' ? (
                    <Rocket
                      size={14}
                      className="shrink-0"
                      style={{ color: 'var(--sat-text-secondary)' }}
                    />
                  ) : (
                    <FileText size={14} className="shrink-0 opacity-75" />
                  )}

                  <span className={`truncate ${isSelected ? 'font-medium' : ''}`}>
                    {tab.name}
                  </span>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        isDirty &&
                        !window.confirm(`Fechar "${tab.name}" sem salvar alterações?`)
                      ) {
                        return;
                      }
                      closeTab(tab.id);
                    }}
                    title="Fechar aba"
                    className="p-0.5 rounded-[2px] hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer ml-1"
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
              );
            })}

            <button
              onClick={() => createNewNotebook()}
              title="Novo Notebook"
              className="px-2.5 flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer shrink-0"
              style={{ color: 'var(--sat-text-muted)' }}
            >
              <Plus size={15} />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-hidden">
            {activeTab?.kind === 'notebook' && <NotebookView tab={activeTab} />}
            {activeTab?.kind === 'launcher' && <LauncherView />}
            {activeTab?.kind === 'file' && <TextFileEditor tab={activeTab} />}
          </div>
        </main>
      </div>

      <FolderPickerModal />
      <AISettingsModal />
      <ShortcutsModal />
    </div>
  );
};

export default App;
