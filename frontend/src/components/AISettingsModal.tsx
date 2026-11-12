import React, { useEffect, useState } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';

export const AISettingsModal: React.FC = () => {
  const { showAIModal, setShowAIModal, config, updateConfig } = useSaturnoStore();

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
    if (!config || !showAIModal) return;
    const prov = config.active_provider || 'gemini';
    setSelectedProvider(prov);
    const p = config.providers[prov];
    setApiKeyInput(p?.api_key || '');
    setModelInput(p?.model || '');
    setBaseUrlInput(p?.base_url || '');
    setEffortInput(p?.reasoning_effort || 'low');
    setDefaultApplyMode(config.default_ai_apply_mode || 'replace_cell');
    setIncludeVars(config.include_kernel_variables ?? true);
  }, [config, showAIModal]);

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

  if (!showAIModal) return null;

  const provMeta = config?.providers?.[selectedProvider];

  const handleSave = async (e: React.FormEvent) => {
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
      setShowAIModal(false);
    }, 450);
  };

  return (
    <div
      data-modal-root="true"
      onClick={() => setShowAIModal(false)}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-[4px] shadow-2xl border overflow-hidden max-h-[90vh] flex flex-col"
        style={{
          backgroundColor: 'var(--sat-bg-surface)',
          borderColor: 'var(--sat-border)',
          color: 'var(--sat-text-primary)',
        }}
      >
        <div
          className="px-5 py-3 border-b flex items-center justify-between shrink-0"
          style={{ borderColor: 'var(--sat-border)' }}
        >
          <div className="flex items-center gap-2">
            <Sparkles size={15} style={{ color: 'var(--sat-accent)' }} />
            <h3 className="font-semibold text-sm m-0">Configurações de IA</h3>
          </div>
          <button
            onClick={() => setShowAIModal(false)}
            className="p-1 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-5 space-y-4 text-xs overflow-y-auto">
          <div className="space-y-1.5">
            <label
              className="block font-medium"
              style={{ color: 'var(--sat-text-secondary)' }}
            >
              Provedor
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
            <label className="block font-medium" style={{ color: 'var(--sat-text-secondary)' }}>
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
            <label className="block font-medium" style={{ color: 'var(--sat-text-secondary)' }}>
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
              <label className="block font-medium" style={{ color: 'var(--sat-text-secondary)' }}>
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
              <label className="block font-medium" style={{ color: 'var(--sat-text-secondary)' }}>
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
            <label className="block font-medium" style={{ color: 'var(--sat-text-secondary)' }}>
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
              type="button"
              onClick={() => setShowAIModal(false)}
              className="h-8 px-3.5 rounded-[3px] border text-xs font-medium cursor-pointer"
              style={{ borderColor: 'var(--sat-border)' }}
            >
              Cancelar
            </button>
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
                  <span>Salvo</span>
                </>
              ) : (
                <span>Salvar</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
