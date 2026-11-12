import React from 'react';
import { FileCode, FolderOpen, Sparkles } from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';

export const LauncherView: React.FC = () => {
  const {
    createNewNotebook,
    setShowFolderModal,
    setShowAIModal,
    workspaceRoot,
    config,
  } = useSaturnoStore();

  return (
    <div
      className="h-full overflow-y-auto p-8 md:p-10"
      style={{ backgroundColor: 'var(--sat-bg-canvas)' }}
    >
      <div className="max-w-3xl mx-auto space-y-8">
        <div
          className="pb-4 border-b space-y-1"
          style={{ borderColor: 'var(--sat-border)' }}
        >
          <h1 className="text-lg font-semibold m-0">SaturnoLab</h1>
          <p className="text-xs m-0 font-mono" style={{ color: 'var(--sat-text-muted)' }}>
            {workspaceRoot}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button
            onClick={() => createNewNotebook()}
            className="p-4 rounded-[4px] border flex flex-col items-start gap-2.5 hover:opacity-90 transition-opacity cursor-pointer text-left"
            style={{
              backgroundColor: 'var(--sat-bg-surface)',
              borderColor: 'var(--sat-border)',
            }}
          >
            <FileCode size={22} style={{ color: 'var(--sat-orange)' }} />
            <div>
              <div className="font-semibold text-sm">Python 3 (ipykernel)</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--sat-text-muted)' }}>
                Criar notebook .ipynb
              </div>
            </div>
          </button>

          <button
            onClick={() => setShowFolderModal(true)}
            className="p-4 rounded-[4px] border flex flex-col items-start gap-2.5 hover:opacity-90 transition-opacity cursor-pointer text-left"
            style={{
              backgroundColor: 'var(--sat-bg-surface)',
              borderColor: 'var(--sat-border)',
            }}
          >
            <FolderOpen size={22} style={{ color: 'var(--sat-text-secondary)' }} />
            <div>
              <div className="font-semibold text-sm">Conectar Diretório</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--sat-text-muted)' }}>
                Alterar pasta de trabalho
              </div>
            </div>
          </button>

          <button
            onClick={() => setShowAIModal(true)}
            className="p-4 rounded-[4px] border flex flex-col items-start gap-2.5 hover:opacity-90 transition-opacity cursor-pointer text-left"
            style={{
              backgroundColor: 'var(--sat-bg-surface)',
              borderColor: 'var(--sat-border)',
            }}
          >
            <Sparkles size={22} style={{ color: 'var(--sat-accent)' }} />
            <div>
              <div className="font-semibold text-sm">Provedor de IA</div>
              <div className="text-xs mt-0.5 font-mono" style={{ color: 'var(--sat-text-muted)' }}>
                {config?.active_provider || 'gemini'}
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};
