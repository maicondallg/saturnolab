import React from 'react';
import {
  ChevronDown,
  FolderOpen,
  Keyboard,
  PanelLeft,
  PanelRight,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';

export const MenuBar: React.FC = () => {
  const {
    config,
    workspaceRoot,
    leftSidebar,
    setLeftSidebar,
    sidebarPosition,
    statusMessage,
    setShowFolderModal,
    openSettings,
  } = useSaturnoStore();

  const activeProvider = config?.active_provider || 'gemini';
  const activeModel = config?.providers?.[activeProvider]?.model;

  const providerShort: Record<string, string> = {
    gemini: 'Gemini',
    codex: 'Codex',
    openai_compatible: 'OpenAI',
    anthropic: 'Claude',
  };

  const modelBadge = activeModel
    ? `${providerShort[activeProvider] || activeProvider} / ${activeModel}`
    : providerShort[activeProvider] || 'IA';

  const folderName = workspaceRoot
    ? workspaceRoot.split('/').filter(Boolean).slice(-1)[0] || workspaceRoot
    : 'Workspace';

  return (
    <header
      className="h-10 px-3 flex items-center justify-between select-none border-b shrink-0"
      style={{
        backgroundColor: 'var(--sat-bg-surface)',
        borderColor: 'var(--sat-border)',
        color: 'var(--sat-text-primary)',
      }}
    >
      {/* Left: Sidebar Toggle + Saturno Brand + Connected Folder */}
      <div className="flex items-center gap-2 min-w-0">
        {sidebarPosition === 'left' && (
          <button
            onClick={() => setLeftSidebar(leftSidebar ? null : 'files')}
            title="Alternar painel lateral"
            className="p-1.5 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
            style={{ color: leftSidebar ? 'var(--sat-accent)' : 'var(--sat-text-secondary)' }}
          >
            <PanelLeft size={16} />
          </button>
        )}

        <div className="flex items-center gap-2 font-semibold text-sm tracking-tight pr-1 shrink-0">
          <svg width="20" height="20" viewBox="0 0 64 64" className="shrink-0">
            <circle cx="32" cy="32" r="14" fill="var(--sat-orange)" />
            <ellipse
              cx="32"
              cy="32"
              rx="28"
              ry="9"
              fill="none"
              stroke="var(--sat-text-secondary)"
              strokeWidth="4.2"
              transform="rotate(-18 32 32)"
            />
          </svg>
          <span>SaturnoLab</span>
        </div>

        <div
          className="h-4 w-px mx-0.5 shrink-0"
          style={{ backgroundColor: 'var(--sat-border)' }}
        />

        <button
          onClick={() => setShowFolderModal(true)}
          title={`Pasta conectada: ${workspaceRoot}\nClique para alterar`}
          className="h-7 px-2.5 rounded-[3px] border text-xs font-medium flex items-center gap-1.5 hover:opacity-90 transition-opacity cursor-pointer"
          style={{
            backgroundColor: 'var(--sat-bg-subtle)',
            borderColor: 'var(--sat-border)',
            color: 'var(--sat-text-primary)',
          }}
        >
          <FolderOpen size={13} style={{ color: 'var(--sat-orange)' }} />
          <span className="max-w-[200px] truncate font-mono">{folderName}</span>
          <ChevronDown size={12} style={{ color: 'var(--sat-text-muted)' }} />
        </button>

        {statusMessage && statusMessage !== 'Pronto' && (
          <span
            className="hidden lg:inline-block text-[11.5px] font-mono px-2 py-0.5 rounded-[3px] truncate max-w-[260px]"
            style={{
              backgroundColor: 'var(--sat-bg-subtle)',
              color: 'var(--sat-text-secondary)',
            }}
          >
            {statusMessage}
          </span>
        )}
      </div>

      {/* Right: Centralized Settings + Shortcuts + Right Sidebar Toggle */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={() => openSettings('ai')}
          title="Modelo de IA ativo (clique para abrir Configurações > IA)"
          className="hidden sm:flex h-7 px-2.5 rounded-[3px] border text-xs items-center gap-1.5 hover:opacity-90 transition-opacity cursor-pointer"
          style={{
            backgroundColor: 'var(--sat-bg-subtle)',
            borderColor: 'var(--sat-border)',
            color: 'var(--sat-text-secondary)',
          }}
        >
          <Sparkles size={12} style={{ color: 'var(--sat-accent)' }} />
          <span className="max-w-[180px] truncate font-mono text-[11.5px]">{modelBadge}</span>
        </button>

        <button
          onClick={() => openSettings('appearance')}
          title="Configurações (Temas, IA, Layout, Editor)"
          className="h-7 px-2.5 rounded-[3px] border text-xs font-medium flex items-center gap-1.5 hover:opacity-90 transition-opacity cursor-pointer"
          style={{
            backgroundColor: 'var(--sat-bg-subtle)',
            borderColor: 'var(--sat-border)',
            color: 'var(--sat-text-primary)',
          }}
        >
          <Settings size={13} style={{ color: 'var(--sat-accent)' }} />
          <span>Configurações</span>
        </button>

        <button
          onClick={() => openSettings('shortcuts')}
          title="Atalhos de teclado"
          className="h-7 w-7 rounded-[3px] flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          style={{ color: 'var(--sat-text-secondary)' }}
        >
          <Keyboard size={15} />
        </button>

        {sidebarPosition === 'right' && (
          <button
            onClick={() => setLeftSidebar(leftSidebar ? null : 'files')}
            title="Alternar painel lateral"
            className="p-1.5 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
            style={{ color: leftSidebar ? 'var(--sat-accent)' : 'var(--sat-text-secondary)' }}
          >
            <PanelRight size={16} />
          </button>
        )}
      </div>
    </header>
  );
};
