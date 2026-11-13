import { useShallow } from 'zustand/react/shallow';
import React, { useMemo, useCallback } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Eraser,
  Loader2,
  Play,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { NotebookCellData } from '../types/notebook';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { isThemeDark } from '../themes';
import { CodeMirrorCellEditor } from './CodeMirrorCellEditor';
import { InlineAIPopover } from './InlineAIPopover';
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
    addCellBelow,
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
    addCellBelow: s.addCellBelow,
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

  return (
    <div
      data-cell-id={cell.id}
      onClick={() => selectCell(cell.id, isActive ? notebookMode : 'command')}
      className="group relative pl-3 py-1"
    >
      {/* Sharp External Left Selection Rule */}
      <div
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
        className={`absolute left-0 top-1 bottom-1 w-[3px] rounded-[1px] cursor-pointer transition-colors ${
          !isActive ? 'group-hover:bg-neutral-500/25' : ''
        }`}
        style={isActive ? { backgroundColor: externalBarColor } : undefined}
      />

      {/* Top-right compact cell actions above card */}
      <div
        className={`${
          isActive && !aiState?.isOpen
            ? 'opacity-100'
            : aiState?.isOpen
              ? 'opacity-0 pointer-events-none'
              : 'opacity-0 group-hover:opacity-100'
        } transition-opacity flex items-center justify-end gap-0.5 pr-1 pb-0.5 select-none`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => {
            selectCell(cell.id, 'edit');
            openInlineAI(cell.id, null);
          }}
          title="IA Inline (Ctrl+I ou Ctrl+K)"
          className="px-1.5 py-0.5 rounded-[2px] text-[11.5px] font-medium flex items-center gap-1 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          style={{ color: 'var(--sat-text-secondary)' }}
        >
          <Sparkles size={12} style={{ color: 'var(--sat-accent)' }} />
          <span className="font-mono">Ctrl+I</span>
        </button>

        <button
          type="button"
          onClick={() =>
            changeCellType(cell.id, cell.cell_type === 'code' ? 'markdown' : 'code')
          }
          title="Alternar Code / Markdown (Ctrl+M)"
          className="px-1.5 py-0.5 rounded-[2px] text-[11.5px] font-mono hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
          style={{
            color:
              cell.cell_type === 'code'
                ? 'var(--sat-type-py)'
                : 'var(--sat-type-md)',
          }}
        >
          {cell.cell_type === 'code' ? 'py' : 'md'}
        </button>

        <button
          type="button"
          onClick={() => moveCell(cell.id, 'up')}
          title="Mover para cima (Alt+↑)"
          className="p-1 rounded-[2px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
          style={{ color: 'var(--sat-text-muted)' }}
        >
          <ArrowUp size={13} />
        </button>

        <button
          type="button"
          onClick={() => moveCell(cell.id, 'down')}
          title="Mover para baixo (Alt+↓)"
          className="p-1 rounded-[2px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
          style={{ color: 'var(--sat-text-muted)' }}
        >
          <ArrowDown size={13} />
        </button>

        <button
          type="button"
          onClick={() => addCellBelow(cell.id, 'code')}
          title="Inserir célula abaixo (B)"
          className="p-1 rounded-[2px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
          style={{ color: 'var(--sat-text-muted)' }}
        >
          <Plus size={13} />
        </button>

        {cell.cell_type === 'code' && cell.outputs.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => toggleCellOutputCollapse(cell.id)}
              title={
                cell.outputCollapsed
                  ? 'Expandir saída (O)'
                  : 'Recolher saída (O)'
              }
              className="p-1 rounded-[2px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
              style={{ color: 'var(--sat-text-muted)' }}
            >
              {cell.outputCollapsed ? (
                <ChevronRight size={13} />
              ) : (
                <ChevronDown size={13} />
              )}
            </button>
            <button
              type="button"
              onClick={() => clearCellOutputs(cell.id)}
              title="Limpar saída"
              className="p-1 rounded-[2px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
              style={{ color: 'var(--sat-text-muted)' }}
            >
              <Eraser size={13} />
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => deleteCell(cell.id)}
          title="Excluir célula (Ctrl+Shift+Backspace ou D, D)"
          className="p-1 rounded-[2px] hover:bg-red-500/15 text-red-400 cursor-pointer"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Main Row: Gutter + Sharp Technical Cell Box */}
      <div className="flex items-stretch gap-1.5">
        <div
          onClick={(e) => {
            e.stopPropagation();
            selectCell(cell.id, 'command');
          }}
          title="Selecionar célula (Command Mode)"
          className="w-12 shrink-0 pt-1.5 flex flex-col items-end pr-1 select-none cursor-pointer"
        >
          {cell.cell_type === 'code' && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                runCell(cell.id, 'none');
              }}
              title="Executar célula (Shift+Enter)"
              className="group/play h-6 px-1 rounded-[3px] flex items-center justify-center transition-colors hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
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
              className="jp-markdown-rendered px-3.5 py-1.5 rounded-[4px] border border-transparent hover:border-neutral-500/25 cursor-text transition-colors"
              dangerouslySetInnerHTML={{ __html: renderedMarkdownHtml }}
            />
          ) : (
            <div
              className="rounded-[4px] border transition-colors overflow-hidden"
              style={{
                backgroundColor: isEditing
                  ? 'var(--sat-cell-active-bg)'
                  : 'var(--sat-cell-bg)',
                borderColor: isEditing
                  ? 'var(--sat-border-strong)'
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

              {cell.cell_type === 'code' &&
                (cell.outputs.length > 0 || cell.isRunning) && (
                  <div data-cell-output-id={cell.id}>
                    {cell.outputCollapsed ? (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCellOutputCollapse(cell.id);
                        }}
                        className="px-3.5 py-1.5 border-t text-xs font-mono flex items-center gap-1.5 cursor-pointer hover:opacity-80"
                        style={{
                          backgroundColor: 'var(--sat-bg-canvas)',
                          borderColor: 'var(--sat-border)',
                          color: 'var(--sat-text-muted)',
                        }}
                      >
                        <ChevronRight size={13} />
                        <span>
                          Saída recolhida ({cell.outputs.length} bloco
                          {cell.outputs.length > 1 ? 's' : ''}) — clique ou pressione O
                          para mostrar
                        </span>
                      </div>
                    ) : (
                      <CellOutputView
                        outputs={cell.outputs}
                        onFixErrorWithAI={fixErrorWithAI}
                      />
                    )}
                  </div>
                )}
            </div>
          )}
        </div>
      </div>

      {/* Bottom anchor for scrolling to cell output/end */}
      <div data-cell-bottom-id={cell.id} />
    </div>
  );
});
