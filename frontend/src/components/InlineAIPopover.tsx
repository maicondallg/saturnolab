import { useShallow } from 'zustand/react/shallow';
import React, { useEffect, useRef } from 'react';
import {
  Check,
  CornerDownLeft,
  Loader2,
  Play,
  RotateCw,
  Sparkles,
  X,
} from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { InlineAIState } from '../types/notebook';

interface Props {
  cellId: string;
  aiState: InlineAIState;
  hasExistingCode: boolean;
}

export const InlineAIPopover: React.FC<Props> = React.memo(({
  cellId,
  aiState,
  hasExistingCode,
}) => {
  const {
    setInlineAIPrompt,
    setInlineAIApplyMode,
    submitInlineAI,
    cancelInlineAI,
    acceptInlineAI,
    closeInlineAI,
    openSettings,
  } = useSaturnoStore(useShallow((s) => ({
    setInlineAIPrompt: s.setInlineAIPrompt,
    setInlineAIApplyMode: s.setInlineAIApplyMode,
    submitInlineAI: s.submitInlineAI,
    cancelInlineAI: s.cancelInlineAI,
    acceptInlineAI: s.acceptInlineAI,
    closeInlineAI: s.closeInlineAI,
    openSettings: s.openSettings,
  })));

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSubmittedPromptRef = useRef<string>('');

  const stateRef = useRef({
    aiState,
    hasExistingCode,
    cellId,
  });
  stateRef.current = { aiState, hasExistingCode, cellId };

  useEffect(() => {
    if (!aiState.isOpen) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(timer);
  }, [aiState.isOpen]);

  useEffect(() => {
    if (aiState.status === 'streaming') {
      lastSubmittedPromptRef.current = aiState.prompt.trim();
    }
  }, [aiState.status, aiState.prompt]);

  const restoreEditorFocus = () => {
    const editor = rootRef.current?.closest('[data-cell-id]')
      ?.querySelector<HTMLElement>('.cm-content');
    requestAnimationFrame(() => {
      if (editor?.isConnected) editor.focus();
    });
  };

  const dismiss = () => {
    restoreEditorFocus();
    closeInlineAI(cellId);
  };

  const accept = (andRun: boolean) => {
    restoreEditorFocus();
    acceptInlineAI(cellId, andRun);
  };

  const cycleApplyMode = () => {
    const { aiState: cur } = stateRef.current;
    if (cur.selection) {
      const order: Array<'replace_selection' | 'append_cell' | 'replace_cell'> = [
        'replace_selection',
        'replace_cell',
        'append_cell',
      ];
      const next = order[(order.indexOf(cur.applyMode) + 1) % order.length];
      setInlineAIApplyMode(cellId, next);
    } else {
      setInlineAIApplyMode(
        cellId,
        cur.applyMode === 'replace_cell' ? 'append_cell' : 'replace_cell'
      );
    }
  };

  const triggerSubmit = () => {
    const p = stateRef.current.aiState.prompt.trim();
    if (!p) return;
    lastSubmittedPromptRef.current = p;
    submitInlineAI(cellId);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    const inPrompt = e.target === inputRef.current;
    const cur = stateRef.current.aiState;
    const promptEditedAfterPreview =
      cur.status === 'preview' &&
      cur.prompt.trim() !== lastSubmittedPromptRef.current;

    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
        inPrompt && (cur.selection || stateRef.current.hasExistingCode) &&
        (cur.status === 'idle' || cur.status === 'preview')) {
      e.preventDefault();
      e.stopPropagation();
      cycleApplyMode();
      return;
    }

    if (
      e.key === 'Tab' &&
      !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
      inPrompt && !promptEditedAfterPreview &&
      cur.status === 'preview' &&
      cur.streamedCode.trim()
    ) {
      e.preventDefault();
      e.stopPropagation();
      accept(false);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (cur.status === 'streaming') {
        cancelInlineAI(cellId);
      } else {
        dismiss();
      }
      return;
    }

    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (
        cur.status === 'preview' &&
        cur.streamedCode.trim() &&
        !promptEditedAfterPreview
      ) {
        accept(true);
      } else if (cur.prompt.trim() && cur.status !== 'streaming') {
        triggerSubmit();
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && inPrompt) {
      e.preventDefault();
      e.stopPropagation();
      if (
        cur.status === 'preview' &&
        cur.streamedCode.trim() &&
        !promptEditedAfterPreview
      ) {
        accept(false);
      } else if (cur.status !== 'streaming' && cur.prompt.trim()) {
        triggerSubmit();
      }
    }
  };

  const promptChangedSincePreview =
    aiState.status === 'preview' &&
    aiState.prompt.trim() !== lastSubmittedPromptRef.current;

  const showModeSelector = Boolean(aiState.selection) || hasExistingCode;

  const acceptLabel = !hasExistingCode
    ? 'Aceitar'
    : aiState.applyMode === 'append_cell'
      ? 'Adicionar no final'
      : aiState.applyMode === 'replace_selection'
        ? 'Substituir seleção'
        : 'Substituir';

  const acceptAndRunLabel = !hasExistingCode
    ? 'Aceitar e Rodar'
    : aiState.applyMode === 'append_cell'
      ? 'Adicionar e Rodar'
      : 'Substituir e Rodar';

  const renderModeSwitcher = () => {
    if (!showModeSelector) {
      return (
        <span className="text-[11.5px] font-mono" style={{ color: 'var(--sat-text-muted)' }}>
          inserir na célula
        </span>
      );
    }

    const options: Array<{
      id: 'replace_selection' | 'replace_cell' | 'append_cell';
      label: string;
    }> = aiState.selection
      ? [
          { id: 'replace_selection', label: 'Seleção' },
          { id: 'replace_cell', label: 'Substituir' },
          { id: 'append_cell', label: '+ Final' },
        ]
      : [
          { id: 'replace_cell', label: 'Substituir' },
          { id: 'append_cell', label: '+ No final' },
        ];

    return (
      <div className="flex items-center gap-1.5">
        <div
          className="inline-flex items-center p-0.5 rounded-[3px] border"
          style={{
            backgroundColor: 'var(--sat-bg-canvas)',
            borderColor: 'var(--sat-border)',
          }}
        >
          {options.map((opt) => {
            const active = aiState.applyMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setInlineAIApplyMode(cellId, opt.id)}
                className="px-2 py-0.5 rounded-[2px] text-[11.5px] font-medium transition-colors cursor-pointer"
                style={{
                  backgroundColor: active ? 'var(--sat-bg-hover)' : 'transparent',
                  color: active
                    ? 'var(--sat-text-primary)'
                    : 'var(--sat-text-muted)',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <kbd
          title="Shift+Tab no campo de instrução alterna o modo de aplicação"
          className="text-[10px] font-mono px-1 py-0.5 rounded-[2px] border opacity-70 select-none"
          style={{
            borderColor: 'var(--sat-border)',
            color: 'var(--sat-text-muted)',
          }}
        >
          ⇧Tab
        </kbd>
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      data-inline-ai
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      className="border-b transition-colors"
      style={{
        backgroundColor: 'var(--sat-ai-bg)',
        borderColor: 'var(--sat-ai-border)',
      }}
    >
      {/* Sober Single-Line Command Input */}
      <div className="px-3 h-10 flex items-center gap-2">
        {aiState.status === 'streaming' ? (
          <Loader2
            size={15}
            className="animate-spin shrink-0"
            style={{ color: 'var(--sat-accent)' }}
          />
        ) : (
          <Sparkles
            size={15}
            className="shrink-0"
            style={{ color: 'var(--sat-accent)' }}
          />
        )}

        <input
          ref={inputRef}
          type="text"
          aria-label="Instrução para a IA"
          value={aiState.prompt}
          readOnly={aiState.status === 'streaming'}
          onChange={(e) => setInlineAIPrompt(cellId, e.target.value)}
          placeholder={
            aiState.selection
              ? 'Instrução para o trecho selecionado...'
              : 'Instrução para gerar código... (Enter envia · Esc fecha)'
          }
          className="flex-1 min-w-0 bg-transparent text-[13.5px] focus:outline-none placeholder:opacity-55"
          style={{ color: 'var(--sat-text-primary)' }}
        />

        {aiState.status === 'idle' && showModeSelector && (
          <div className="hidden sm:flex shrink-0">{renderModeSwitcher()}</div>
        )}

        {aiState.status === 'streaming' ? (
          <button
            type="button"
            onClick={() => cancelInlineAI(cellId)}
            className="h-6.5 px-2.5 rounded-[3px] border text-xs font-medium cursor-pointer shrink-0 transition-colors"
            style={{
              backgroundColor: 'var(--sat-error-bg)',
              borderColor: 'var(--sat-error-border)',
              color: 'var(--sat-error-text)',
            }}
          >
            Parar
          </button>
        ) : aiState.status === 'preview' && !promptChangedSincePreview ? (
          <button
            type="button"
            onClick={triggerSubmit}
            title="Gerar novamente"
            className="h-6.5 px-2 rounded-[3px] border text-xs font-medium flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] cursor-pointer shrink-0 transition-colors"
            style={{
              backgroundColor: 'var(--sat-bg-surface)',
              borderColor: 'var(--sat-border)',
              color: 'var(--sat-text-secondary)',
            }}
          >
            <RotateCw size={12} />
            <span className="hidden sm:inline">Refazer</span>
          </button>
        ) : (
          <button
            type="button"
            disabled={!aiState.prompt.trim()}
            onClick={triggerSubmit}
            title="Enviar (Enter)"
            className="h-6.5 w-6.5 rounded-[3px] flex items-center justify-center disabled:opacity-30 cursor-pointer shrink-0 transition-opacity"
            style={{
              backgroundColor: 'var(--sat-btn-primary-bg)',
              color: 'var(--sat-btn-primary-text)',
            }}
          >
            <CornerDownLeft size={13} />
          </button>
        )}

        <button
          type="button"
          onClick={dismiss}
          title="Fechar (Esc)"
          aria-label="Fechar IA"
          className="h-6.5 w-6.5 rounded-[3px] flex items-center justify-center opacity-60 hover:opacity-100 hover:bg-[var(--sat-bg-hover)] cursor-pointer shrink-0"
        >
          <X size={14} />
        </button>
      </div>

      {/* Error Banner */}
      {aiState.status === 'error' && (
        <div
          className="mx-3 mb-2.5 px-3 py-2 rounded-[3px] border text-xs flex items-center justify-between gap-3"
          style={{
            backgroundColor: 'var(--sat-error-bg)',
            borderColor: 'var(--sat-error-border)',
            color: 'var(--sat-error-text)',
          }}
        >
          <span className="leading-relaxed">{aiState.errorMessage}</span>
          <button
            type="button"
            onClick={() => openSettings('ai')}
            className="h-6.5 px-2.5 rounded-[3px] border text-xs font-medium shrink-0 cursor-pointer"
          >
            Configurar Modelo
          </button>
        </div>
      )}

      {/* Preview Container + Sober Technical Action Footer */}
      {(aiState.status === 'streaming' || aiState.status === 'preview') && (
        <div className="px-3 pb-2.5">
          <div
            className="rounded-[3px] border overflow-hidden"
            style={{
              backgroundColor: 'var(--sat-bg-canvas)',
              borderColor: 'var(--sat-border)',
            }}
          >
            <pre
              className="p-3 font-mono text-[13px] overflow-x-auto max-h-72 leading-relaxed m-0"
              style={{ color: 'var(--sat-text-primary)' }}
            >
              {aiState.streamedCode || 'Gerando...'}
            </pre>

            {aiState.status === 'preview' && aiState.streamedCode.trim() && (
              <div
                className="px-2.5 py-1.5 border-t flex items-center justify-between gap-2 flex-wrap"
                style={{
                  backgroundColor: 'var(--sat-bg-surface)',
                  borderColor: 'var(--sat-border)',
                }}
              >
                {renderModeSwitcher()}

                <div className="flex items-center gap-1.5 ml-auto">
                  <button
                    type="button"
                    onClick={dismiss}
                    className="h-7 px-2.5 rounded-[3px] text-xs font-medium flex items-center gap-1.5 hover:bg-[var(--sat-bg-hover)] transition-colors cursor-pointer"
                    style={{ color: 'var(--sat-text-muted)' }}
                  >
                    <span>Descartar</span>
                    <kbd
                      className="font-mono text-[10px] px-1 rounded-[2px] border opacity-75"
                      style={{ borderColor: 'var(--sat-border)' }}
                    >
                      Esc
                    </kbd>
                  </button>

                  <button
                    type="button"
                    onClick={() => accept(false)}
                    className="h-7 px-2.5 rounded-[3px] border text-xs font-medium flex items-center gap-1.5 hover:opacity-90 transition-opacity cursor-pointer"
                    style={{
                      backgroundColor: 'var(--sat-bg-subtle)',
                      borderColor: 'var(--sat-border)',
                      color: 'var(--sat-text-primary)',
                    }}
                  >
                    <Check size={12} style={{ color: 'var(--sat-green)' }} />
                    <span>{acceptLabel}</span>
                    <kbd
                      className="font-mono text-[10px] px-1 rounded-[2px] border opacity-80"
                      style={{ borderColor: 'var(--sat-border)' }}
                    >
                      Tab
                    </kbd>
                  </button>

                  <button
                    type="button"
                    onClick={() => accept(true)}
                    className="h-7 px-2.5 rounded-[3px] text-xs font-medium flex items-center gap-1.5 hover:opacity-90 transition-opacity cursor-pointer"
                    style={{
                      backgroundColor: 'var(--sat-btn-primary-bg)',
                      color: 'var(--sat-btn-primary-text)',
                    }}
                  >
                    <Play size={11} className="fill-current" />
                    <span>{acceptAndRunLabel}</span>
                    <kbd className="font-mono text-[10px] px-1 rounded-[2px] border border-current/25 opacity-80">
                      Ctrl+↵
                    </kbd>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
