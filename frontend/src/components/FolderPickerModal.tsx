import { useShallow } from 'zustand/react/shallow';
import React, { useEffect, useState } from 'react';
import { ArrowUp, Folder, Home, X } from 'lucide-react';
import { api } from '../services/api';
import { useSaturnoStore } from '../store/useSaturnoStore';

export const FolderPickerModal: React.FC = React.memo(() => {
  const { showFolderModal, setShowFolderModal, workspaceRoot, switchWorkspace } = useSaturnoStore(useShallow((s) => ({
    showFolderModal: s.showFolderModal,
    setShowFolderModal: s.setShowFolderModal,
    workspaceRoot: s.workspaceRoot,
    switchWorkspace: s.switchWorkspace,
  })));
  const [pathInput, setPathInput] = useState(workspaceRoot);
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>('');
  const [error, setError] = useState('');

  const loadDirs = async (targetPath: string) => {
    try {
      setError('');
      const res = await api.browseSystemDirs(targetPath);
      setPathInput(res.current);
      setDirs(res.directories);
      setParentDir(res.parent);
      setHomeDir(res.home);
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (showFolderModal) {
      loadDirs(workspaceRoot);
    }
  }, [showFolderModal, workspaceRoot]);

  useEffect(() => {
    if (!showFolderModal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setShowFolderModal(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [showFolderModal, setShowFolderModal]);

  if (!showFolderModal) return null;

  return (
    <div
      data-modal-root="true"
      onClick={() => setShowFolderModal(false)}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-[4px] shadow-2xl border flex flex-col max-h-[80vh] overflow-hidden"
        style={{
          backgroundColor: 'var(--sat-bg-surface)',
          borderColor: 'var(--sat-border)',
          color: 'var(--sat-text-primary)',
        }}
      >
        <div
          className="px-5 py-3 border-b flex items-center justify-between"
          style={{ borderColor: 'var(--sat-border)' }}
        >
          <h3 className="font-semibold text-sm m-0">Conectar Diretório</h3>
          <button
            onClick={() => setShowFolderModal(false)}
            className="sat-icon-btn p-1"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3 flex-1 overflow-hidden flex flex-col">
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => homeDir && loadDirs(homeDir)}
              title="Home"
              className="h-8 px-2.5 rounded-[3px] border hover:bg-[var(--sat-bg-hover)] transition-colors cursor-pointer"
              style={{ borderColor: 'var(--sat-border)' }}
            >
              <Home size={14} />
            </button>
            <button
              type="button"
              disabled={!parentDir}
              onClick={() => parentDir && loadDirs(parentDir)}
              title="Subir nível"
              className="h-8 px-2.5 rounded-[3px] border hover:bg-[var(--sat-bg-hover)] transition-colors disabled:opacity-40 cursor-pointer"
              style={{ borderColor: 'var(--sat-border)' }}
            >
              <ArrowUp size={14} />
            </button>
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') loadDirs(pathInput);
              }}
              className="flex-1 h-8 px-3 rounded-[3px] border font-mono text-xs bg-transparent focus:outline-none"
              style={{ borderColor: 'var(--sat-border)' }}
            />
          </div>

          {error && <div className="text-xs text-red-400">{error}</div>}

          <div
            className="flex-1 overflow-y-auto border rounded-[3px] divide-y"
            style={{ borderColor: 'var(--sat-border)' }}
          >
            {dirs.length === 0 ? (
              <div
                className="p-6 text-xs text-center"
                style={{ color: 'var(--sat-text-muted)' }}
              >
                Nenhuma subpasta visível aqui.
              </div>
            ) : (
              dirs.map((d) => (
                <div
                  key={d.path}
                  onClick={() => loadDirs(d.path)}
                  className="px-3.5 py-2 text-xs flex items-center gap-2 hover:bg-[var(--sat-bg-hover)] transition-colors cursor-pointer"
                  style={{ borderColor: 'var(--sat-border-subtle)' }}
                >
                  <Folder size={14} style={{ color: 'var(--sat-text-secondary)' }} />
                  <span>{d.name}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div
          className="px-5 py-3 border-t flex items-center justify-end gap-2"
          style={{ borderColor: 'var(--sat-border)' }}
        >
          <button
            type="button"
            onClick={() => setShowFolderModal(false)}
            className="h-8 px-3.5 rounded-[3px] border text-xs font-medium hover:bg-[var(--sat-bg-hover)] transition-colors cursor-pointer"
            style={{ borderColor: 'var(--sat-border)' }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await switchWorkspace(pathInput);
              } catch (err: any) {
                setError(err.message);
              }
            }}
            className="h-8 px-4 rounded-[3px] text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer"
            style={{
              backgroundColor: 'var(--sat-btn-primary-bg)',
              color: 'var(--sat-btn-primary-text)',
            }}
          >
            Abrir Diretório
          </button>
        </div>
      </div>
    </div>
  );
});
