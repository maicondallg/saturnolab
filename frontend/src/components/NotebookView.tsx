import React, { useEffect, useRef } from 'react';
import {
  Eraser,
  FastForward,
  Plus,
  RotateCw,
  Save,
  Sparkles,
  Square,
} from 'lucide-react';
import { OpenNotebookTab } from '../types/notebook';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { NotebookCell } from './NotebookCell';

interface Props {
  tab: OpenNotebookTab;
}

export const NotebookView: React.FC<Props> = ({ tab }) => {
  const {
    notebookMode,
    saveActiveTab,
    addCellAbove,
    addCellBelow,
    cutCell,
    copyCell,
    pasteCellBelow,
    deleteCell,
    moveCell,
    changeCellType,
    clearAllOutputs,
    selectCell,
    setMarkdownRendered,
    runCell,
    runAllCells,
    interruptKernel,
    restartKernel,
    openInlineAI,
  } = useSaturnoStore();

  const lastDTimeRef = useRef<number>(0);

  const activeCell = tab.cells.find((c) => c.id === tab.activeCellId) || tab.cells[0];

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.closest('.cm-editor'));

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveActiveTab();
        return;
      }

      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === 'i' || e.key.toLowerCase() === 'k') &&
        !inInput
      ) {
        e.preventDefault();
        if (activeCell) {
          selectCell(activeCell.id, 'edit');
          openInlineAI(activeCell.id, null);
        }
        return;
      }

      if (inInput || notebookMode !== 'command' || !activeCell) return;

      const idx = tab.cells.findIndex((c) => c.id === activeCell.id);

      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        runCell(activeCell.id, 'next');
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runCell(activeCell.id, 'none');
      } else if (e.key === 'Enter' && e.altKey) {
        e.preventDefault();
        runCell(activeCell.id, 'insert');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeCell.cell_type === 'markdown') {
          setMarkdownRendered(activeCell.id, false);
        }
        selectCell(activeCell.id, 'edit');
      } else if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        moveCell(activeCell.id, 'up');
      } else if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        moveCell(activeCell.id, 'down');
      } else if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (idx > 0) selectCell(tab.cells[idx - 1].id, 'command');
      } else if (e.key === 'ArrowDown' || e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (idx < tab.cells.length - 1) selectCell(tab.cells[idx + 1].id, 'command');
      } else if (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        addCellAbove(activeCell.id, 'code');
      } else if (e.key.toLowerCase() === 'b' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        addCellBelow(activeCell.id, 'code');
      } else if (
        (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey) ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm')
      ) {
        e.preventDefault();
        changeCellType(
          activeCell.id,
          activeCell.cell_type === 'code' ? 'markdown' : 'code'
        );
      } else if (e.key.toLowerCase() === 'y' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        changeCellType(activeCell.id, 'code');
      } else if (e.key.toLowerCase() === 'x' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        cutCell(activeCell.id);
      } else if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        copyCell(activeCell.id);
      } else if (e.key.toLowerCase() === 'v' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        pasteCellBelow(activeCell.id);
      } else if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key === 'Backspace'
      ) {
        e.preventDefault();
        deleteCell(activeCell.id);
      } else if (e.key.toLowerCase() === 'd' && !e.ctrlKey && !e.metaKey) {
        const now = Date.now();
        if (now - lastDTimeRef.current < 500) {
          e.preventDefault();
          deleteCell(activeCell.id);
          lastDTimeRef.current = 0;
        } else {
          lastDTimeRef.current = now;
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [
    notebookMode,
    activeCell,
    tab.cells,
    saveActiveTab,
    selectCell,
    openInlineAI,
    runCell,
    setMarkdownRendered,
    addCellAbove,
    addCellBelow,
    moveCell,
    changeCellType,
    cutCell,
    copyCell,
    pasteCellBelow,
    deleteCell,
  ]);

  const statusColor =
    tab.kernelStatus === 'busy'
      ? 'var(--sat-orange)'
      : tab.kernelStatus === 'idle'
        ? 'var(--sat-green)'
        : 'var(--sat-text-muted)';

  const statusLabel =
    tab.kernelStatus === 'busy'
      ? 'Busy'
      : tab.kernelStatus === 'starting'
        ? 'Starting'
        : tab.kernelStatus === 'idle'
          ? 'Idle'
          : 'Stopped';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Sober Technical Notebook Toolbar */}
      <div
        className="h-9 px-3 flex items-center justify-between border-b shrink-0 select-none"
        style={{
          backgroundColor: 'var(--sat-bg-surface)',
          borderColor: 'var(--sat-border)',
        }}
      >
        <div className="flex items-center gap-1">
          <button
            onClick={() => saveActiveTab()}
            title="Salvar Notebook (Ctrl+S)"
            className="h-7 px-2 rounded-[3px] text-xs flex items-center gap-1.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
            style={{ color: 'var(--sat-text-secondary)' }}
          >
            <Save size={13} />
          </button>

          <div
            className="h-4 w-px mx-1"
            style={{ backgroundColor: 'var(--sat-border)' }}
          />

          <button
            onClick={() => {
              const id = addCellBelow(activeCell?.id, 'code');
              if (id) selectCell(id, 'edit');
            }}
            className="h-7 px-2 rounded-[3px] text-xs font-medium flex items-center gap-1 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          >
            <Plus size={13} />
            <span>Code</span>
          </button>

          <button
            onClick={() => {
              const id = addCellBelow(activeCell?.id, 'markdown');
              if (id) selectCell(id, 'edit');
            }}
            className="h-7 px-2 rounded-[3px] text-xs font-medium flex items-center gap-1 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
            style={{ color: 'var(--sat-text-secondary)' }}
          >
            <Plus size={13} />
            <span>Markdown</span>
          </button>

          <div
            className="h-4 w-px mx-1"
            style={{ backgroundColor: 'var(--sat-border)' }}
          />

          <button
            onClick={() => runAllCells()}
            title="Executar todas as células"
            className="h-7 px-2.5 rounded-[3px] text-xs font-medium flex items-center gap-1.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          >
            <FastForward size={13} />
            <span className="hidden md:inline">Run All</span>
          </button>

          {tab.kernelStatus === 'busy' && (
            <button
              onClick={() => interruptKernel()}
              title="Interromper execução"
              className="h-7 px-2 rounded-[3px] text-xs font-medium flex items-center gap-1 text-red-400 hover:bg-red-500/10 cursor-pointer"
            >
              <Square size={12} className="fill-current" />
              <span>Stop</span>
            </button>
          )}

          <button
            onClick={() => restartKernel()}
            title="Reiniciar Kernel"
            className="h-7 px-2 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
            style={{ color: 'var(--sat-text-secondary)' }}
          >
            <RotateCw size={13} />
          </button>

          <button
            onClick={() => clearAllOutputs()}
            title="Limpar todas as saídas"
            className="h-7 px-2 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
            style={{ color: 'var(--sat-text-secondary)' }}
          >
            <Eraser size={13} />
          </button>

          <div
            className="h-4 w-px mx-1"
            style={{ backgroundColor: 'var(--sat-border)' }}
          />

          <button
            onClick={() => {
              if (activeCell) {
                selectCell(activeCell.id, 'edit');
                openInlineAI(activeCell.id, null);
              }
            }}
            title="Abrir IA Inline na célula ativa (Ctrl+I ou Ctrl+K)"
            className="h-7 px-2.5 rounded-[3px] border text-xs font-medium flex items-center gap-1.5 hover:opacity-90 transition-opacity cursor-pointer"
            style={{
              backgroundColor: 'var(--sat-bg-subtle)',
              borderColor: 'var(--sat-border)',
              color: 'var(--sat-text-primary)',
            }}
          >
            <Sparkles size={12} style={{ color: 'var(--sat-accent)' }} />
            <span>IA Inline</span>
            <kbd
              className="text-[10.5px] font-mono opacity-70 ml-0.5"
              style={{ color: 'var(--sat-text-muted)' }}
            >
              Ctrl+I
            </kbd>
          </button>
        </div>

        {/* Right: Clean Technical Kernel Status */}
        <div
          className="flex items-center gap-2 text-xs font-mono"
          style={{ color: 'var(--sat-text-secondary)' }}
        >
          <span className="hidden sm:inline opacity-80">Python 3 (ipykernel)</span>
          <span className="hidden sm:inline opacity-35">|</span>
          <span
            className="w-2 h-2 rounded-full inline-block"
            style={{ backgroundColor: statusColor }}
          />
          <span>{statusLabel}</span>
        </div>
      </div>

      {/* Scrollable Cells Canvas */}
      <div
        className="flex-1 overflow-y-auto px-4 md:px-8 py-5"
        style={{ backgroundColor: 'var(--sat-bg-canvas)' }}
      >
        <div className="max-w-5xl mx-auto pb-28 space-y-1.5">
          {tab.cells.map((cell) => (
            <NotebookCell
              key={cell.id}
              cell={cell}
              isActive={cell.id === tab.activeCellId}
            />
          ))}

          {/* Bottom Add Buttons */}
          <div className="pl-14 pt-3 flex items-center gap-2 opacity-55 hover:opacity-100 transition-opacity">
            <button
              onClick={() => {
                const lastId = tab.cells[tab.cells.length - 1]?.id;
                const created = addCellBelow(lastId, 'code');
                if (created) selectCell(created, 'edit');
              }}
              className="h-7 px-3 rounded-[3px] border text-xs font-medium flex items-center gap-1 cursor-pointer"
              style={{
                backgroundColor: 'var(--sat-bg-surface)',
                borderColor: 'var(--sat-border)',
              }}
            >
              <Plus size={13} />
              <span>Code</span>
            </button>
            <button
              onClick={() => {
                const lastId = tab.cells[tab.cells.length - 1]?.id;
                const created = addCellBelow(lastId, 'markdown');
                if (created) selectCell(created, 'edit');
              }}
              className="h-7 px-3 rounded-[3px] border text-xs font-medium flex items-center gap-1 cursor-pointer"
              style={{
                backgroundColor: 'var(--sat-bg-surface)',
                borderColor: 'var(--sat-border)',
                color: 'var(--sat-text-secondary)',
              }}
            >
              <Plus size={13} />
              <span>Markdown</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
