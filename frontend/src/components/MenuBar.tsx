import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  FolderOpen,
  Keyboard,
  Palette,
  PanelLeft,
  Sparkles,
} from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { SATURNO_THEMES, normalizeThemeId } from '../themes';

export const MenuBar: React.FC = () => {
  const {
    config,
    workspaceRoot,
    leftSidebar,
    setLeftSidebar,
    setTheme,
    setShowFolderModal,
    setShowAIModal,
    setShowShortcutsModal,
  } = useSaturnoStore();

  const [themeOpen, setThemeOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target as Node)) {
        setThemeOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

  const activeProvider = config?.active_provider || 'gemini';
  const activeModel = config?.providers?.[activeProvider]?.model;
  const currentThemeId = normalizeThemeId(config?.theme);
  const currentTheme = SATURNO_THEMES.find((t) => t.id === currentThemeId) || SATURNO_THEMES[0];

  const providerShort: Record<string, string> = {
    gemini: 'Gemini',
    codex: 'Codex',
    openai_compatible: 'OpenAI',
    anthropic: 'Claude',
  };

  const modelBadge = activeModel
    ? `${providerShort[activeProvider] || activeProvider} / ${activeModel}`
    : providerShort[activeProvider] || 'Modelo IA';

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
      <div className="flex items-center gap-2">
        <button
          onClick={() => setLeftSidebar(leftSidebar ? null : 'files')}
          title="Alternar painel lateral"
          className="p-1.5 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          style={{ color: 'var(--sat-text-secondary)' }}
        >
          <PanelLeft size={16} />
        </button>

        <div className="flex items-center gap-2 font-semibold text-sm tracking-tight pr-1">
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
          className="h-4 w-px mx-0.5"
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
          <span className="max-w-[220px] truncate font-mono">{folderName}</span>
          <ChevronDown size={12} style={{ color: 'var(--sat-text-muted)' }} />
        </button>
      </div>

      {/* Right: Model Config + Theme Selector + Shortcuts */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setShowAIModal(true)}
          title="Configurar modelo e provedor de IA"
          className="h-7 px-2.5 rounded-[3px] border text-xs font-medium flex items-center gap-1.5 hover:opacity-90 transition-opacity cursor-pointer"
          style={{
            backgroundColor: 'var(--sat-bg-subtle)',
            borderColor: 'var(--sat-border)',
            color: 'var(--sat-text-primary)',
          }}
        >
          <Sparkles size={13} style={{ color: 'var(--sat-accent)' }} />
          <span className="max-w-[220px] truncate font-mono">{modelBadge}</span>
          <ChevronDown size={12} style={{ color: 'var(--sat-text-muted)' }} />
        </button>

        {/* Theme Picker Dropdown */}
        <div ref={themeMenuRef} className="relative">
          <button
            onClick={() => setThemeOpen((v) => !v)}
            title="Selecionar tema"
            className="h-7 px-2.5 rounded-[3px] border text-xs font-medium flex items-center gap-1.5 hover:opacity-90 transition-opacity cursor-pointer"
            style={{
              backgroundColor: 'var(--sat-bg-subtle)',
              borderColor: 'var(--sat-border)',
              color: 'var(--sat-text-secondary)',
            }}
          >
            <Palette size={13} />
            <span className="hidden sm:inline">{currentTheme.label.split(' ')[0]}</span>
            <ChevronDown size={12} style={{ color: 'var(--sat-text-muted)' }} />
          </button>

          {themeOpen && (
            <div
              className="absolute right-0 top-full mt-1 w-56 py-1 rounded-[4px] border shadow-xl z-50"
              style={{
                backgroundColor: 'var(--sat-bg-surface)',
                borderColor: 'var(--sat-border)',
              }}
            >
              <div
                className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider border-b"
                style={{
                  color: 'var(--sat-text-muted)',
                  borderColor: 'var(--sat-border-subtle)',
                }}
              >
                Temas
              </div>
              {SATURNO_THEMES.map((t) => {
                const active = t.id === currentThemeId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setTheme(t.id);
                      setThemeOpen(false);
                    }}
                    className="w-full px-3 py-1.5 text-xs flex items-center justify-between hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer text-left"
                    style={{ color: 'var(--sat-text-primary)' }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="w-3.5 h-3.5 rounded-[2px] border inline-flex items-center justify-center shrink-0"
                        style={{
                          backgroundColor: t.bgPreview,
                          borderColor: 'var(--sat-border-strong)',
                        }}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-[1px]"
                          style={{ backgroundColor: t.accentPreview }}
                        />
                      </span>
                      <span className={active ? 'font-semibold' : ''}>{t.label}</span>
                    </div>
                    {active && <Check size={13} style={{ color: 'var(--sat-accent)' }} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          onClick={() => setShowShortcutsModal(true)}
          title="Atalhos de teclado"
          className="h-7 w-7 rounded-[3px] flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          style={{ color: 'var(--sat-text-secondary)' }}
        >
          <Keyboard size={15} />
        </button>
      </div>
    </header>
  );
};
