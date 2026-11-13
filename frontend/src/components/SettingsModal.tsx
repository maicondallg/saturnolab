import React, { useEffect, useState } from 'react';
import {
  Check,
  Columns2,
  Keyboard,
  Maximize2,
  Minimize2,
  Palette,
  PanelLeft,
  PanelRight,
  Settings,
  Sliders,
  Sparkles,
  X,
} from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { SATURNO_THEMES, normalizeThemeId } from '../themes';
import { SettingsSection } from '../types/notebook';

export const SettingsModal: React.FC = () => {
  const {
    showSettingsModal,
    settingsSection,
    openSettings,
    closeSettings,
    config,
    updateConfig,
    setTheme,
    notebookLayout,
    setNotebookLayout,
    sidebarPosition,
    setSidebarPosition,
    sidebarWidth,
    setSidebarWidth,
    editorFontSize,
    setEditorFontSize,
    showLineNumbers,
    toggleLineNumbers,
    autoScrollOnRun,
    setAutoScrollOnRun,
    showModifiedTime,
    setShowModifiedTime,
    confirmKernelRestart,
    setConfirmKernelRestart,
  } = useSaturnoStore();

  const activeProvider = config?.active_provider || 'gemini';
  const [selectedProvider, setSelectedProvider] = useState<
    'gemini' | 'codex' | 'openai_compatible' | 'anthropic'
  >(activeProvider);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [effortInput, setEffortInput] = useState('low');
  const [defaultApplyMode, setDefaultApplyMode] = useState<'replace_cell' | 'append_cell'>(
    'replace_cell'
  );
  const [includeVars, setIncludeVars] = useState(true);
  const [savedToast, setSavedToast] = useState(false);

  useEffect(() => {
    if (!config || !showSettingsModal) return;
    const prov = config.active_provider || 'gemini';
    setSelectedProvider(prov);
    const p = config.providers?.[prov];
    setApiKeyInput(p?.api_key || '');
    setModelInput(p?.model || '');
    setBaseUrlInput(p?.base_url || '');
    setEffortInput(p?.reasoning_effort || 'low');
    setDefaultApplyMode(config.default_ai_apply_mode || 'replace_cell');
    setIncludeVars(config.include_kernel_variables ?? true);
  }, [config, showSettingsModal]);

  const handleSelectProvider = (
    prov: 'gemini' | 'codex' | 'openai_compatible' | 'anthropic'
  ) => {
    setSelectedProvider(prov);
    const p = config?.providers?.[prov];
    setApiKeyInput(p?.api_key || '');
    setModelInput(p?.model || '');
    setBaseUrlInput(p?.base_url || '');
    setEffortInput(p?.reasoning_effort || 'low');
  };

  if (!showSettingsModal) return null;

  const currentThemeId = normalizeThemeId(config?.theme);
  const provMeta = config?.providers?.[selectedProvider];

  const handleSaveAI = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateConfig({
      active_provider: selectedProvider,
      default_ai_apply_mode: defaultApplyMode,
      include_kernel_variables: includeVars,
      providers: {
        [selectedProvider]: {
          api_key: apiKeyInput,
          model: modelInput,
          base_url: baseUrlInput,
          reasoning_effort: effortInput,
        },
      },
    });
    setSavedToast(true);
    setTimeout(() => {
      setSavedToast(false);
    }, 1200);
  };

  const navItems: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
    { id: 'appearance', label: 'Aparência & Layout', icon: <Palette size={14} /> },
    { id: 'editor', label: 'Editor & Execução', icon: <Sliders size={14} /> },
    { id: 'ai', label: 'Inteligência Artificial', icon: <Sparkles size={14} /> },
    { id: 'shortcuts', label: 'Atalhos de Teclado', icon: <Keyboard size={14} /> },
  ];

  const shortcutGroups = [
    {
      title: 'Kernel & Notebook (Modo Comando — após Esc)',
      items: [
        { desc: 'Reiniciar o Kernel (estilo Jupyter)', keys: '0, 0' },
        { desc: 'Interromper execução do Kernel', keys: 'I, I' },
        { desc: 'Excluir célula selecionada', keys: 'D, D  ou  Ctrl+Shift+⌫' },
        { desc: 'Desfazer última exclusão de célula', keys: 'Z' },
        { desc: 'Alternar números de linha', keys: 'L' },
        { desc: 'Recolher / expandir saída da célula', keys: 'O' },
        { desc: 'Entrar na célula para editar', keys: 'Enter' },
        { desc: 'Inserir célula acima / abaixo', keys: 'A  /  B' },
        { desc: 'Navegar entre células', keys: '↑ / ↓  ou  K / J' },
        { desc: 'Converter para Markdown / Código', keys: 'M  /  Y' },
        { desc: 'Recortar / Copiar / Colar célula', keys: 'X  /  C  /  V' },
      ],
    },
    {
      title: 'Execução e Edição Direta',
      items: [
        { desc: 'Executar célula e avançar (auto-scroll para resultado)', keys: 'Shift + Enter' },
        { desc: 'Executar célula atual', keys: 'Ctrl + Enter' },
        { desc: 'Executar e inserir nova abaixo', keys: 'Alt + Enter' },
        { desc: 'Mover célula para cima / baixo', keys: 'Alt + ↑ / ↓' },
        { desc: 'Alternar Código / Markdown', keys: 'Ctrl + M' },
        { desc: 'Sair para Command Mode', keys: 'Esc' },
        { desc: 'Salvar notebook ou arquivo', keys: 'Ctrl + S' },
      ],
    },
    {
      title: 'IA Inline na Célula',
      items: [
        { desc: 'Abrir prompt de IA na célula ou seleção', keys: 'Ctrl + I  /  Ctrl + K' },
        { desc: 'Alternar entre Substituir e + No final', keys: 'Shift + Tab' },
        { desc: 'Aceitar código gerado', keys: 'Tab  /  Enter' },
        { desc: 'Aceitar código e executar célula', keys: 'Ctrl + Enter' },
        { desc: 'Cancelar / Fechar prompt', keys: 'Esc' },
      ],
    },
  ];

  return (
    <div
      data-modal-root="true"
      onClick={closeSettings}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl rounded-[4px] shadow-2xl border overflow-hidden h-[82vh] max-h-[680px] flex flex-col"
        style={{
          backgroundColor: 'var(--sat-bg-surface)',
          borderColor: 'var(--sat-border)',
          color: 'var(--sat-text-primary)',
        }}
      >
        {/* Modal Header */}
        <div
          className="px-5 py-3 border-b flex items-center justify-between shrink-0"
          style={{ borderColor: 'var(--sat-border)' }}
        >
          <div className="flex items-center gap-2">
            <Settings size={15} style={{ color: 'var(--sat-accent)' }} />
            <h3 className="font-semibold text-sm m-0">Configurações do SaturnoLab</h3>
          </div>
          <button
            onClick={closeSettings}
            className="p-1 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body: Left Nav + Right Content */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Left Navigation */}
          <nav
            className="w-52 border-r p-2.5 space-y-1 shrink-0 select-none overflow-y-auto"
            style={{
              backgroundColor: 'var(--sat-bg-subtle)',
              borderColor: 'var(--sat-border)',
            }}
          >
            {navItems.map((item) => {
              const active = settingsSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openSettings(item.id)}
                  className="w-full px-3 py-2 rounded-[3px] text-xs font-medium flex items-center gap-2.5 text-left transition-colors cursor-pointer"
                  style={{
                    backgroundColor: active ? 'var(--sat-bg-surface)' : 'transparent',
                    color: active ? 'var(--sat-text-primary)' : 'var(--sat-text-secondary)',
                    borderLeft: active
                      ? '2px solid var(--sat-accent)'
                      : '2px solid transparent',
                  }}
                >
                  <span style={{ color: active ? 'var(--sat-accent)' : 'inherit' }}>
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Right Panel Content */}
          <div className="flex-1 overflow-y-auto p-6 text-xs">
            {/* 1. APARÊNCIA & LAYOUT */}
            {settingsSection === 'appearance' && (
              <div className="space-y-6">
                <div>
                  <h4 className="text-sm font-semibold m-0 mb-1">Tema de Cores</h4>
                  <p className="m-0 mb-3" style={{ color: 'var(--sat-text-muted)' }}>
                    Escolha a paleta de cores da interface, células e realce de sintaxe (.py / .ipynb).
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {SATURNO_THEMES.map((t) => {
                      const active = t.id === currentThemeId;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setTheme(t.id)}
                          className="p-3 rounded-[4px] border flex items-center justify-between transition-colors cursor-pointer text-left"
                          style={{
                            backgroundColor: active
                              ? 'var(--sat-bg-hover)'
                              : 'var(--sat-bg-subtle)',
                            borderColor: active
                              ? 'var(--sat-accent)'
                              : 'var(--sat-border)',
                          }}
                        >
                          <div className="flex items-center gap-2.5">
                            <span
                              className="w-5 h-5 rounded-[3px] border inline-flex items-center justify-center shrink-0"
                              style={{
                                backgroundColor: t.bgPreview,
                                borderColor: 'var(--sat-border-strong)',
                              }}
                            >
                              <span
                                className="w-2 h-2 rounded-[1px]"
                                style={{ backgroundColor: t.accentPreview }}
                              />
                            </span>
                            <div>
                              <div className="font-semibold text-xs">{t.label}</div>
                              <div
                                className="text-[11px]"
                                style={{ color: 'var(--sat-text-muted)' }}
                              >
                                {t.isDark ? 'Tema Escuro' : 'Tema Claro'}
                              </div>
                            </div>
                          </div>
                          {active && <Check size={14} style={{ color: 'var(--sat-accent)' }} />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div
                  className="pt-5 border-t space-y-3"
                  style={{ borderColor: 'var(--sat-border)' }}
                >
                  <div>
                    <h4 className="text-sm font-semibold m-0 mb-1">
                      Exibição do Notebook
                    </h4>
                    <p className="m-0 mb-2.5" style={{ color: 'var(--sat-text-muted)' }}>
                      Defina se as células do notebook ficam centralizadas na página ou ocupam toda a largura disponível.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setNotebookLayout('centered')}
                      className="p-3 rounded-[4px] border flex items-center gap-2.5 cursor-pointer text-left"
                      style={{
                        backgroundColor:
                          notebookLayout === 'centered'
                            ? 'var(--sat-bg-hover)'
                            : 'var(--sat-bg-subtle)',
                        borderColor:
                          notebookLayout === 'centered'
                            ? 'var(--sat-accent)'
                            : 'var(--sat-border)',
                      }}
                    >
                      <Minimize2 size={16} style={{ color: 'var(--sat-accent)' }} />
                      <div>
                        <div className="font-semibold">Centralizado</div>
                        <div
                          className="text-[11px]"
                          style={{ color: 'var(--sat-text-muted)' }}
                        >
                          Largura de leitura confortável
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setNotebookLayout('expanded')}
                      className="p-3 rounded-[4px] border flex items-center gap-2.5 cursor-pointer text-left"
                      style={{
                        backgroundColor:
                          notebookLayout === 'expanded'
                            ? 'var(--sat-bg-hover)'
                            : 'var(--sat-bg-subtle)',
                        borderColor:
                          notebookLayout === 'expanded'
                            ? 'var(--sat-accent)'
                            : 'var(--sat-border)',
                      }}
                    >
                      <Maximize2 size={16} style={{ color: 'var(--sat-accent)' }} />
                      <div>
                        <div className="font-semibold">Expandido (Largura Total)</div>
                        <div
                          className="text-[11px]"
                          style={{ color: 'var(--sat-text-muted)' }}
                        >
                          Ocupa 100% da área horizontal
                        </div>
                      </div>
                    </button>
                  </div>
                </div>

                <div
                  className="pt-5 border-t space-y-4"
                  style={{ borderColor: 'var(--sat-border)' }}
                >
                  <div>
                    <h4 className="text-sm font-semibold m-0 mb-1">
                      Barra Lateral (Arquivos & Variáveis)
                    </h4>
                    <p className="m-0 mb-2.5" style={{ color: 'var(--sat-text-muted)' }}>
                      Posicione a barra lateral à esquerda ou à direita e ajuste sua largura (você também pode arrastar a borda da barra diretamente).
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setSidebarPosition('left')}
                      className="p-3 rounded-[4px] border flex items-center gap-2.5 cursor-pointer text-left"
                      style={{
                        backgroundColor:
                          sidebarPosition === 'left'
                            ? 'var(--sat-bg-hover)'
                            : 'var(--sat-bg-subtle)',
                        borderColor:
                          sidebarPosition === 'left'
                            ? 'var(--sat-accent)'
                            : 'var(--sat-border)',
                      }}
                    >
                      <PanelLeft size={16} style={{ color: 'var(--sat-accent)' }} />
                      <div>
                        <div className="font-semibold">Mostrar à Esquerda</div>
                        <div
                          className="text-[11px]"
                          style={{ color: 'var(--sat-text-muted)' }}
                        >
                          Posição clássica de IDE
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setSidebarPosition('right')}
                      className="p-3 rounded-[4px] border flex items-center gap-2.5 cursor-pointer text-left"
                      style={{
                        backgroundColor:
                          sidebarPosition === 'right'
                            ? 'var(--sat-bg-hover)'
                            : 'var(--sat-bg-subtle)',
                        borderColor:
                          sidebarPosition === 'right'
                            ? 'var(--sat-accent)'
                            : 'var(--sat-border)',
                      }}
                    >
                      <PanelRight size={16} style={{ color: 'var(--sat-accent)' }} />
                      <div>
                        <div className="font-semibold">Mostrar à Direita</div>
                        <div
                          className="text-[11px]"
                          style={{ color: 'var(--sat-text-muted)' }}
                        >
                          Painel acoplado no lado direito
                        </div>
                      </div>
                    </button>
                  </div>

                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">
                        Largura da Barra Lateral: <b className="font-mono">{sidebarWidth}px</b>
                      </span>
                      <button
                        type="button"
                        onClick={() => setSidebarWidth(280, true)}
                        className="text-[11px] px-2 py-0.5 rounded-[2px] border cursor-pointer hover:opacity-80"
                        style={{ borderColor: 'var(--sat-border)' }}
                      >
                        Padrão (280px)
                      </button>
                    </div>
                    <input
                      type="range"
                      min={180}
                      max={600}
                      step={4}
                      value={sidebarWidth}
                      onChange={(e) => setSidebarWidth(Number(e.target.value), true)}
                      className="w-full cursor-pointer accent-amber-600"
                    />
                  </div>
                </div>

                <div
                  className="pt-5 border-t space-y-2"
                  style={{ borderColor: 'var(--sat-border)' }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-semibold m-0">Tamanho da Fonte do Código</h4>
                      <p className="m-0 mt-0.5" style={{ color: 'var(--sat-text-muted)' }}>
                        Tamanho da fonte nas células e arquivos de código (.py, .md, etc.)
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {[12, 13, 14, 15, 16, 18].map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          onClick={() => setEditorFontSize(sz)}
                          className="h-7 px-2.5 rounded-[3px] border font-mono text-xs cursor-pointer"
                          style={{
                            backgroundColor:
                              editorFontSize === sz
                                ? 'var(--sat-btn-primary-bg)'
                                : 'var(--sat-bg-subtle)',
                            color:
                              editorFontSize === sz
                                ? 'var(--sat-btn-primary-text)'
                                : 'var(--sat-text-primary)',
                            borderColor:
                              editorFontSize === sz
                                ? 'var(--sat-btn-primary-bg)'
                                : 'var(--sat-border)',
                          }}
                        >
                          {sz}px
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 2. EDITOR & EXECUÇÃO */}
            {settingsSection === 'editor' && (
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-semibold m-0 mb-1">
                    Comportamento do Notebook e Arquivos
                  </h4>
                  <p className="m-0 mb-4" style={{ color: 'var(--sat-text-muted)' }}>
                    Personalize como as células são executadas e como os arquivos são exibidos.
                  </p>
                </div>

                <label
                  className="p-3.5 rounded-[4px] border flex items-start justify-between gap-4 cursor-pointer"
                  style={{
                    backgroundColor: 'var(--sat-bg-subtle)',
                    borderColor: 'var(--sat-border)',
                  }}
                >
                  <div>
                    <div className="font-semibold text-xs">
                      Mover página até o resultado ao executar célula (Auto-scroll)
                    </div>
                    <div
                      className="text-[11.5px] mt-0.5"
                      style={{ color: 'var(--sat-text-muted)' }}
                    >
                      Rola automaticamente o notebook até a célula executada e sua saída para evitar scroll manual.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={autoScrollOnRun}
                    onChange={(e) => setAutoScrollOnRun(e.target.checked)}
                    className="w-4 h-4 mt-0.5 shrink-0 cursor-pointer"
                  />
                </label>

                <label
                  className="p-3.5 rounded-[4px] border flex items-start justify-between gap-4 cursor-pointer"
                  style={{
                    backgroundColor: 'var(--sat-bg-subtle)',
                    borderColor: 'var(--sat-border)',
                  }}
                >
                  <div>
                    <div className="font-semibold text-xs">
                      Mostrar números de linha no editor de código
                    </div>
                    <div
                      className="text-[11.5px] mt-0.5"
                      style={{ color: 'var(--sat-text-muted)' }}
                    >
                      Exibe a numeração lateral nas células Python e arquivos abertos (atalho: tecla L no modo comando).
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={showLineNumbers}
                    onChange={() => toggleLineNumbers()}
                    className="w-4 h-4 mt-0.5 shrink-0 cursor-pointer"
                  />
                </label>

                <label
                  className="p-3.5 rounded-[4px] border flex items-start justify-between gap-4 cursor-pointer"
                  style={{
                    backgroundColor: 'var(--sat-bg-subtle)',
                    borderColor: 'var(--sat-border)',
                  }}
                >
                  <div>
                    <div className="font-semibold text-xs">
                      Mostrar hora da modificação na árvore de arquivos
                    </div>
                    <div
                      className="text-[11.5px] mt-0.5"
                      style={{ color: 'var(--sat-text-muted)' }}
                    >
                      Exibe o horário/data da última modificação ao lado de cada arquivo e pasta na barra lateral.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={showModifiedTime}
                    onChange={(e) => setShowModifiedTime(e.target.checked)}
                    className="w-4 h-4 mt-0.5 shrink-0 cursor-pointer"
                  />
                </label>

                <label
                  className="p-3.5 rounded-[4px] border flex items-start justify-between gap-4 cursor-pointer"
                  style={{
                    backgroundColor: 'var(--sat-bg-subtle)',
                    borderColor: 'var(--sat-border)',
                  }}
                >
                  <div>
                    <div className="font-semibold text-xs">
                      Pedir confirmação antes de reiniciar o Kernel (0, 0)
                    </div>
                    <div
                      className="text-[11.5px] mt-0.5"
                      style={{ color: 'var(--sat-text-muted)' }}
                    >
                      Exibe um alerta de confirmação antes de limpar as variáveis em memória ao reiniciar o kernel.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={confirmKernelRestart}
                    onChange={(e) => setConfirmKernelRestart(e.target.checked)}
                    className="w-4 h-4 mt-0.5 shrink-0 cursor-pointer"
                  />
                </label>

                <div
                  className="p-3.5 rounded-[4px] border flex items-start gap-3"
                  style={{
                    backgroundColor: 'var(--sat-bg-subtle)',
                    borderColor: 'var(--sat-border)',
                  }}
                >
                  <Columns2 size={16} className="shrink-0 mt-0.5" style={{ color: 'var(--sat-accent)' }} />
                  <div>
                    <div className="font-semibold text-xs">Abas Lado a Lado (Split View)</div>
                    <div
                      className="text-[11.5px] mt-0.5 leading-relaxed"
                      style={{ color: 'var(--sat-text-muted)' }}
                    >
                      Para abrir notebooks ou arquivos lado a lado como no JupyterLab, clique no ícone de dividir (<b>Abrir ao lado</b>) na aba, na árvore de arquivos ou arraste uma aba para a metade direita/esquerda da tela.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 3. INTELIGÊNCIA ARTIFICIAL */}
            {settingsSection === 'ai' && (
              <form onSubmit={handleSaveAI} className="space-y-4">
                <div>
                  <h4 className="text-sm font-semibold m-0 mb-1">
                    Provedor e Modelo de IA
                  </h4>
                  <p className="m-0 mb-3" style={{ color: 'var(--sat-text-muted)' }}>
                    Configure o modelo usado pelo assistente inline nas células (Ctrl+I / Ctrl+K).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label
                    className="block font-medium"
                    style={{ color: 'var(--sat-text-secondary)' }}
                  >
                    Provedor Ativo
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                    {(
                      [
                        { id: 'gemini', label: 'Gemini' },
                        { id: 'codex', label: 'Codex SDK' },
                        { id: 'openai_compatible', label: 'OpenAI / Local' },
                        { id: 'anthropic', label: 'Claude' },
                      ] as const
                    ).map((p) => {
                      const active = selectedProvider === p.id;
                      return (
                        <button
                          type="button"
                          key={p.id}
                          onClick={() => handleSelectProvider(p.id)}
                          className="h-8 px-2.5 rounded-[3px] border text-xs font-medium transition-colors cursor-pointer"
                          style={{
                            backgroundColor: active
                              ? 'var(--sat-btn-primary-bg)'
                              : 'var(--sat-bg-subtle)',
                            color: active
                              ? 'var(--sat-btn-primary-text)'
                              : 'var(--sat-text-primary)',
                            borderColor: active
                              ? 'var(--sat-btn-primary-bg)'
                              : 'var(--sat-border)',
                          }}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {selectedProvider === 'codex' && (
                  <div
                    className="p-3 rounded-[3px] border text-xs leading-relaxed space-y-1"
                    style={{
                      backgroundColor: 'var(--sat-bg-subtle)',
                      borderColor: 'var(--sat-border)',
                    }}
                  >
                    <div className="font-semibold">
                      Pacote: <code className="font-mono">@openai/codex-sdk</code>
                    </div>
                    <div>
                      • SDK Node instalado:{' '}
                      <b>{config?.codex_status?.sdk_ready ? 'Ativo ✓' : 'Não'}</b>
                    </div>
                    <div>
                      • Sessão local (<code className="font-mono">~/.codex</code>):{' '}
                      <b>
                        {config?.codex_status?.auth_found
                          ? 'Autenticado ✓ (chave opcional)'
                          : 'Informe API Key ou rode codex login'}
                      </b>
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label
                    className="block font-medium"
                    style={{ color: 'var(--sat-text-secondary)' }}
                  >
                    Modelo
                  </label>
                  <input
                    type="text"
                    value={modelInput}
                    onChange={(e) => setModelInput(e.target.value)}
                    placeholder={
                      selectedProvider === 'gemini'
                        ? 'gemini-2.5-flash'
                        : selectedProvider === 'codex'
                          ? 'Padrão do Codex (ou o4-mini, gpt-5-codex...)'
                          : selectedProvider === 'anthropic'
                            ? 'claude-sonnet-4-5'
                            : 'gpt-4.1-mini ou qwen2.5-coder:7b'
                    }
                    className="w-full h-8 px-3 rounded-[3px] border font-mono text-xs bg-transparent focus:outline-none"
                    style={{ borderColor: 'var(--sat-border)' }}
                  />
                  {selectedProvider === 'gemini' && (
                    <div className="flex gap-1.5 pt-0.5 flex-wrap">
                      {['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'].map((m) => (
                        <button
                          type="button"
                          key={m}
                          onClick={() => setModelInput(m)}
                          className="text-[11px] font-mono px-2 py-0.5 rounded-[2px] border hover:opacity-100 opacity-80 cursor-pointer"
                          style={{
                            backgroundColor: 'var(--sat-bg-subtle)',
                            borderColor: 'var(--sat-border)',
                          }}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label
                    className="block font-medium"
                    style={{ color: 'var(--sat-text-secondary)' }}
                  >
                    {selectedProvider === 'codex'
                      ? 'API Key (opcional se já logado no Codex)'
                      : 'API Key'}
                  </label>
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder={
                      provMeta?.has_key
                        ? 'Chave já configurada (digite para alterar)'
                        : selectedProvider === 'gemini'
                          ? 'AIzaSy...'
                          : 'sk-...'
                    }
                    className="w-full h-8 px-3 rounded-[3px] border font-mono text-xs bg-transparent focus:outline-none"
                    style={{ borderColor: 'var(--sat-border)' }}
                  />
                </div>

                {selectedProvider === 'openai_compatible' && (
                  <div className="space-y-1.5">
                    <label
                      className="block font-medium"
                      style={{ color: 'var(--sat-text-secondary)' }}
                    >
                      Endpoint Base URL
                    </label>
                    <input
                      type="text"
                      value={baseUrlInput}
                      onChange={(e) => setBaseUrlInput(e.target.value)}
                      placeholder="https://api.openai.com/v1"
                      className="w-full h-8 px-3 rounded-[3px] border font-mono text-xs bg-transparent"
                      style={{ borderColor: 'var(--sat-border)' }}
                    />
                    <div className="flex gap-1.5 pt-0.5">
                      <button
                        type="button"
                        onClick={() => setBaseUrlInput('https://api.openai.com/v1')}
                        className="text-[11px] px-2 py-0.5 rounded-[2px] border cursor-pointer"
                        style={{ borderColor: 'var(--sat-border)' }}
                      >
                        OpenAI
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setBaseUrlInput('http://localhost:11434/v1');
                          if (!modelInput || modelInput.startsWith('gpt')) {
                            setModelInput('qwen2.5-coder:7b');
                          }
                        }}
                        className="text-[11px] px-2 py-0.5 rounded-[2px] border cursor-pointer"
                        style={{ borderColor: 'var(--sat-border)' }}
                      >
                        Ollama Local (11434)
                      </button>
                    </div>
                  </div>
                )}

                {selectedProvider === 'codex' && (
                  <div className="space-y-1.5">
                    <label
                      className="block font-medium"
                      style={{ color: 'var(--sat-text-secondary)' }}
                    >
                      Reasoning Effort
                    </label>
                    <select
                      value={effortInput}
                      onChange={(e) => setEffortInput(e.target.value)}
                      className="w-full h-8 px-2.5 rounded-[3px] border text-xs"
                      style={{
                        backgroundColor: 'var(--sat-bg-subtle)',
                        borderColor: 'var(--sat-border)',
                      }}
                    >
                      <option value="low">low (rápido)</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                  </div>
                )}

                <div className="space-y-1.5 pt-1">
                  <label
                    className="block font-medium"
                    style={{ color: 'var(--sat-text-secondary)' }}
                  >
                    Modo padrão ao inserir código da IA{' '}
                    <span className="font-normal opacity-70">(Shift+Tab alterna na célula)</span>
                  </label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {(
                      [
                        { id: 'replace_cell', label: 'Substituir célula' },
                        { id: 'append_cell', label: 'Adicionar no final' },
                      ] as const
                    ).map((m) => {
                      const active = defaultApplyMode === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setDefaultApplyMode(m.id)}
                          className="h-8 px-3 rounded-[3px] border text-xs font-medium transition-colors cursor-pointer"
                          style={{
                            backgroundColor: active
                              ? 'var(--sat-bg-hover)'
                              : 'var(--sat-bg-subtle)',
                            borderColor: active
                              ? 'var(--sat-border-strong)'
                              : 'var(--sat-border)',
                            color: active
                              ? 'var(--sat-text-primary)'
                              : 'var(--sat-text-muted)',
                          }}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label className="flex items-center gap-2 pt-1 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={includeVars}
                    onChange={(e) => setIncludeVars(e.target.checked)}
                    className="w-3.5 h-3.5"
                  />
                  <span style={{ color: 'var(--sat-text-secondary)' }}>
                    Injetar automaticamente schema das variáveis/DataFrames do kernel
                  </span>
                </label>

                <div
                  className="pt-3 border-t flex items-center justify-end gap-2"
                  style={{ borderColor: 'var(--sat-border)' }}
                >
                  <button
                    type="submit"
                    className="h-8 px-4 rounded-[3px] text-xs font-medium flex items-center gap-1.5 cursor-pointer"
                    style={{
                      backgroundColor: 'var(--sat-btn-primary-bg)',
                      color: 'var(--sat-btn-primary-text)',
                    }}
                  >
                    {savedToast ? (
                      <>
                        <Check size={14} />
                        <span>Configurações de IA Salvas!</span>
                      </>
                    ) : (
                      <span>Salvar Configurações de IA</span>
                    )}
                  </button>
                </div>
              </form>
            )}

            {/* 4. ATALHOS DE TECLADO */}
            {settingsSection === 'shortcuts' && (
              <div className="space-y-5">
                {shortcutGroups.map((g) => (
                  <div key={g.title} className="space-y-1.5">
                    <h4
                      className="text-[11px] font-semibold uppercase tracking-wider m-0"
                      style={{ color: 'var(--sat-text-muted)' }}
                    >
                      {g.title}
                    </h4>
                    <div className="space-y-1">
                      {g.items.map((it) => (
                        <div
                          key={it.desc}
                          className="flex items-center justify-between gap-3 py-1.5 px-2.5 rounded-[3px] text-xs"
                          style={{ backgroundColor: 'var(--sat-bg-subtle)' }}
                        >
                          <span>{it.desc}</span>
                          <kbd
                            className="font-mono text-[11px] px-1.5 py-0.5 rounded-[2px] border shrink-0"
                            style={{
                              backgroundColor: 'var(--sat-bg-surface)',
                              borderColor: 'var(--sat-border)',
                            }}
                          >
                            {it.keys}
                          </kbd>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
