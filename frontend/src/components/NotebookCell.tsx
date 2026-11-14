import { useShallow } from 'zustand/react/shallow';
import React, { useMemo, useCallback, useState, useEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eraser,
  Loader2,
  Play,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { NotebookCellData } from '../types/notebook';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { isThemeDark } from '../themes';
import { CodeMirrorCellEditor } from './CodeMirrorCellEditor';
import { InlineAIPopover } from './InlineAIPopover';
import { notebookOutline } from '../utils/notebookOutline';
import { CellOutputView } from './CellOutputView';

interface Props {
  cell: NotebookCellData;
  isActive: boolean;
}

export const NotebookCell: React.FC<Props> = React.memo(({ cell, isActive }) => {
  const {
    config,
    notebookMode,
    showLineNumbers,
    aiState,
    selectCell,
    updateCellSource,
    setMarkdownRendered,
    toggleCellOutputCollapse,
    changeCellType,
    runCell,
    deleteCell,
    moveCell,
    clearCellOutputs,
    saveActiveTab,
    openInlineAI,
  } = useSaturnoStore(useShallow((s) => ({
    config: s.config,
    notebookMode: isActive ? s.notebookMode : 'command',
    showLineNumbers: s.showLineNumbers,
    aiState: s.inlineAI[cell.id],
    selectCell: s.selectCell,
    updateCellSource: s.updateCellSource,
    setMarkdownRendered: s.setMarkdownRendered,
    toggleCellOutputCollapse: s.toggleCellOutputCollapse,
    changeCellType: s.changeCellType,
    runCell: s.runCell,
    deleteCell: s.deleteCell,
    moveCell: s.moveCell,
    clearCellOutputs: s.clearCellOutputs,
    saveActiveTab: s.saveActiveTab,
    openInlineAI: s.openInlineAI,
  })));

  const fixErrorWithAI = useCallback((errSummary: string) => {
    selectCell(cell.id, 'edit');
    openInlineAI(cell.id, null,
      'Corrija o erro desta célula mantendo o objetivo do código', errSummary);
  }, [cell.id, selectCell, openInlineAI]);

  const [outputLimited, setOutputLimited] = useState(config?.output_display === 'limited');

  useEffect(() => {
    if (cell.isRunning) setOutputLimited(config?.output_display === 'limited');
  }, [cell.isRunning, config?.output_display]);
  const heading = notebookOutline([cell])[0];
  const isEditing = isActive && notebookMode === 'edit';
  const darkTheme = isThemeDark(config?.theme);

  const renderedMarkdownHtml = useMemo(() => {
    if (cell.cell_type !== 'markdown') return '';
    const raw = cell.source.trim() || '*Duplo clique para editar Markdown*';
    const parsed = marked.parse(raw, { async: false }) as string;
    return DOMPurify.sanitize(parsed);
  }, [cell.cell_type, cell.source]);

  const externalBarColor = !isActive
    ? 'transparent'
    : notebookMode === 'edit'
      ? 'var(--sat-edit-bar)'
      : 'var(--sat-cmd-bar)';

  const hasOutput =
    cell.cell_type === 'code' && (cell.outputs.length > 0 || cell.isRunning);
  const isShortEditor = cell.source.split('\n').length <= 3;

  const outputControls = hasOutput ? (
    <div
      className={isShortEditor ? 'output-controls-inline' : 'output-controls'}
      aria-label="Controles da saída"
    >
      <button
        type="button"
        aria-label={cell.outputCollapsed ? 'Mostrar saída' : 'Ocultar saída'}
        title={cell.outputCollapsed ? 'Mostrar saída (O)' : 'Ocultar saída (O)'}
        aria-expanded={!cell.outputCollapsed}
        onClick={() => toggleCellOutputCollapse(cell.id)}
        className="cell-action-btn"
      >
        {cell.outputCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>
      {!cell.outputCollapsed && (
        <button
          type="button"
          title={outputLimited ? 'Expandir saída inteira' : 'Limitar altura da saída'}
          aria-label={outputLimited ? 'Expandir saída inteira' : 'Limitar altura da saída'}
          aria-pressed={outputLimited}
          onClick={() => setOutputLimited(!outputLimited)}
          className="cell-action-btn"
        >
          {outputLimited ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
        </button>
      )}
      {cell.outputs.length > 0 && (
        <button
          type="button"
          onClick={() => clearCellOutputs(cell.id)}
          title="Limpar saída"
          aria-label="Limpar saída"
          className="cell-action-btn"
        >
          <Eraser size={13} />
        </button>
      )}
    </div>
  ) : null;

  return (
    <div
      data-cell-id={cell.id}
      className={`notebook-cell-group group relative pl-2.5 py-0.5 ${
        isActive ? 'is-active' : ''
      } ${aiState?.isOpen ? 'is-ai-open' : ''}`}
    >
      {/* Sharp External Left Selection Rule */}
      <div
        data-cell-surface
        onClick={(e) => {
          e.stopPropagation();
          selectCell(cell.id, 'command');
        }}
        title={
          isActive
            ? notebookMode === 'edit'
              ? 'Edit Mode (Esc para Command Mode)'
              : 'Command Mode (Enter para editar)'
            : 'Selecionar célula'
        }
        className={`absolute left-0 top-1 bottom-1 w-[3px] rounded-[1px] cursor-pointer ${
          !isActive ? 'group-hover:bg-neutral-500/25' : ''
        }`}
        style={isActive ? { backgroundColor: externalBarColor } : undefined}
      />

      {/* Main Row: Left Gutter + Sharp Technical Cell Box + Right External Actions */}
      <div data-cell-surface className="flex items-start gap-1.5"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('.cm-editor, button, [data-cell-output-id]')) return;
          selectCell(cell.id, 'command');
        }}>
        <div
          onClick={(e) => {
            e.stopPropagation();
            selectCell(cell.id, 'command');
          }}
          title="Selecionar célula (Command Mode)"
          className="w-11 shrink-0 pt-1 flex flex-col items-end pr-0.5 select-none cursor-pointer"
        >
          {heading && (
            <button
              type="button"
              data-cell-surface
              className="section-toggle"
              aria-expanded={!cell.sectionCollapsed}
              title={cell.sectionCollapsed ? 'Expandir seção' : 'Recolher seção'}
              onClick={(e) => {
                e.stopPropagation();
                useSaturnoStore.getState().toggleSection(cell.id);
              }}
            >
              {cell.sectionCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
              {cell.sectionCollapsed && <span>Seção recolhida</span>}
            </button>
          )}
          {cell.cell_type === 'code' && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                runCell(cell.id, 'none');
              }}
              title="Executar célula (Shift+Enter)"
              className="group/play h-6 px-1 rounded-[3px] flex items-center justify-center hover:bg-[var(--sat-bg-hover)] hover:text-[var(--sat-text-primary)] cursor-pointer"
              style={{
                color: isActive ? 'var(--sat-text-secondary)' : 'var(--sat-text-muted)',
              }}
            >
              {cell.isRunning ? (
                <Loader2
                  size={14}
                  className="animate-spin"
                  style={{ color: 'var(--sat-accent)' }}
                />
              ) : (
                <>
                  <span className="group-hover/play:hidden font-mono text-xs">
                    {cell.execution_count !== null && cell.execution_count !== undefined
                      ? `[${cell.execution_count}]:`
                      : '[ ]:'}
                  </span>
                  <Play size={13} className="hidden group-hover/play:block fill-current" />
                </>
              )}
            </button>
          )}
        </div>

        {/* Cell Box */}
        <div className="flex-1 min-w-0">
          {cell.cell_type === 'markdown' && cell.markdownRendered && !isEditing ? (
            <div
              onDoubleClick={() => {
                setMarkdownRendered(cell.id, false);
                selectCell(cell.id, 'edit');
              }}
              className="jp-markdown-rendered px-3 py-1.5 rounded-[4px] border border-transparent hover:border-neutral-500/25 cursor-text"
              style={isActive ? { borderColor: externalBarColor } : undefined}
              dangerouslySetInnerHTML={{ __html: renderedMarkdownHtml }}
            />
          ) : (
            <div
              className="rounded-[4px] border"
              style={{
                backgroundColor: isEditing
                  ? 'var(--sat-cell-active-bg)'
                  : 'var(--sat-cell-bg)',
                borderColor: isActive
                  ? externalBarColor
                  : 'var(--sat-border)',
              }}
            >
              {aiState?.isOpen && (
                <InlineAIPopover
                  cellId={cell.id}
                  aiState={aiState}
                  hasExistingCode={Boolean(cell.source.trim())}
                />
              )}

              <CodeMirrorCellEditor
                value={cell.source}
                language={cell.cell_type === 'code' ? 'python' : 'markdown'}
                theme={darkTheme ? 'dark' : 'light'}
                showLineNumbers={showLineNumbers && cell.cell_type === 'code'}
                autoFocus={isEditing && !aiState?.isOpen}
                placeholder={
                  cell.cell_type === 'code'
                    ? 'Código Python (Ctrl+I para IA)'
                    : 'Markdown (Shift+Enter para renderizar)'
                }
                onChange={(val) => updateCellSource(cell.id, val)}
                onFocus={() => selectCell(cell.id, 'edit')}
                onShiftEnter={() => runCell(cell.id, 'next')}
                onCtrlEnter={() => runCell(cell.id, 'none')}
                onAltEnter={() => runCell(cell.id, 'insert')}
                onMoveUp={() => moveCell(cell.id, 'up')}
                onMoveDown={() => moveCell(cell.id, 'down')}
                onToggleType={() =>
                  changeCellType(
                    cell.id,
                    cell.cell_type === 'code' ? 'markdown' : 'code'
                  )
                }
                onDeleteCell={() => deleteCell(cell.id)}
                onEscape={() => selectCell(cell.id, 'command')}
                onSave={() => saveActiveTab()}
                onTriggerAI={(selection) => openInlineAI(cell.id, selection)}
              />

              {hasOutput && (
                <div data-cell-output-id={cell.id} className="cell-output relative rounded-b-[3px]">
                  {!isShortEditor && outputControls}
                  {cell.outputCollapsed && (
                    <button
                      type="button"
                      className="output-placeholder rounded-b-[3px]"
                      onClick={() => toggleCellOutputCollapse(cell.id)}
                      title="Mostrar saída"
                    >
                      •••
                    </button>
                  )}
                  {!cell.outputCollapsed && (
                    <div
                      id={`output-${cell.id}`}
                      className={`${outputLimited ? 'max-h-64 overflow-auto' : 'overflow-hidden'} rounded-b-[3px]`}
                      tabIndex={outputLimited ? 0 : undefined}
                      aria-label="Conteúdo da saída"
                    >
                      <CellOutputView outputs={cell.outputs} onFixErrorWithAI={fixErrorWithAI} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right External Stacked Actions (outside cell box) */}
        <div
          data-cell-surface
          className="cell-right-rail relative w-7 self-stretch shrink-0 select-none"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="cell-actions">
            <button
              type="button"
              onClick={() => {
                selectCell(cell.id, 'edit');
                openInlineAI(cell.id, null);
              }}
              title="IA Inline (Ctrl+I)"
              aria-label="IA Inline (Ctrl+I)"
              className="cell-action-btn"
            >
              <Sparkles size={13} style={{ color: 'var(--sat-accent)' }} />
            </button>

            <button
              type="button"
              onClick={() => moveCell(cell.id, 'up')}
              title="Mover para cima (Alt+↑)"
              aria-label="Mover para cima"
              className="cell-action-btn"
            >
              <ArrowUp size={13} />
            </button>

            <button
              type="button"
              onClick={() => moveCell(cell.id, 'down')}
              title="Mover para baixo (Alt+↓)"
              aria-label="Mover para baixo"
              className="cell-action-btn"
            >
              <ArrowDown size={13} />
            </button>

            <button
              type="button"
              onClick={() => deleteCell(cell.id)}
              title="Excluir célula (D, D)"
              aria-label="Excluir célula"
              className="cell-action-btn is-danger"
            >
              <Trash2 size={13} />
            </button>

            {isShortEditor && hasOutput && (
              <>
                <div
                  className="w-3.5 h-px my-0.5"
                  style={{ backgroundColor: 'var(--sat-border)' }}
                />
                {outputControls}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Bottom anchor for scrolling to cell output/end */}
      <div data-cell-bottom-id={cell.id} />
    </div>
  );
});
