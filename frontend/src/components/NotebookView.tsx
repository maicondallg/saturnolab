import { useShallow } from 'zustand/react/shallow';
import React, { useEffect, useMemo, useRef } from 'react';
import {
  FastForward,
  Plus,
  Save,
  Square,
} from 'lucide-react';
import { OpenNotebookTab } from '../types/notebook';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { hiddenSectionCells } from '../utils/notebookOutline';
import { NotebookCell } from './NotebookCell';

interface Props {
  tab: OpenNotebookTab;
  isActivePane?: boolean;
  isVisible?: boolean;
}

export const NotebookView: React.FC<Props> = React.memo(({ tab, isActivePane = true, isVisible = true }) => {
  const {
    notebookMode,
    notebookLayout,
    scrollSignal,
    saveTabById,
    addCellAbove,
    addCellBelow,
    cutCell,
    copyCell,
    pasteCellBelow,
    deleteCell,
    undoDeleteCell,
    moveCell,
    changeCellType,
    selectCell,
    setMarkdownRendered,
    toggleCellOutputCollapse,
    toggleLineNumbers,
    runCell,
    runAllCells,
    interruptKernel,
    restartKernel,
    openInlineAI,
  } = useSaturnoStore(useShallow((s) => ({
    notebookMode: isActivePane ? s.notebookMode : 'command',
    notebookLayout: s.notebookLayout,
    scrollSignal: s.scrollSignal,
    saveTabById: s.saveTabById,
    addCellAbove: s.addCellAbove,
    addCellBelow: s.addCellBelow,
    cutCell: s.cutCell,
    copyCell: s.copyCell,
    pasteCellBelow: s.pasteCellBelow,
    deleteCell: s.deleteCell,
    undoDeleteCell: s.undoDeleteCell,
    moveCell: s.moveCell,
    changeCellType: s.changeCellType,
    selectCell: s.selectCell,
    setMarkdownRendered: s.setMarkdownRendered,
    toggleCellOutputCollapse: s.toggleCellOutputCollapse,
    toggleLineNumbers: s.toggleLineNumbers,
    runCell: s.runCell,
    runAllCells: s.runAllCells,
    interruptKernel: s.interruptKernel,
    restartKernel: s.restartKernel,
    openInlineAI: s.openInlineAI,
  })));

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const handledScrollRef = useRef(scrollSignal);
  const lastChordRef = useRef<{ key: string; time: number }>({ key: '', time: 0 });

  const visibleCells = useMemo(() => {
    const hiddenCells = hiddenSectionCells(tab.cells);
    return hiddenCells.size ? tab.cells.filter(c => !hiddenCells.has(c.id)) : tab.cells;
  }, [tab.cells]);
  const activeCell = tab.cells.find((c) => c.id === tab.activeCellId);

  // Auto-scroll to cell or cell result when executed / navigated
  useEffect(() => {
    if (handledScrollRef.current === scrollSignal) return;
    handledScrollRef.current = scrollSignal;
    if (!isVisible || !scrollSignal || scrollSignal.notebookPath !== tab.path) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const timer = window.requestAnimationFrame(() => {
      const cellEl = container.querySelector(
        `[data-cell-id="${scrollSignal.cellId}"]`
      ) as HTMLElement | null;
      const outputEl = container.querySelector(
        `[data-cell-output-id="${scrollSignal.cellId}"]`
      ) as HTMLElement | null;
      const bottomEl = container.querySelector(
        `[data-cell-bottom-id="${scrollSignal.cellId}"]`
      ) as HTMLElement | null;

      const targetEl =
        scrollSignal.kind === 'output'
          ? outputEl || bottomEl || cellEl
          : cellEl;

      if (!targetEl) return;

      const containerRect = container.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();

      const topMargin = 24;
      const bottomMargin = 64;

      if (scrollSignal.kind === 'output') {
        // Ensure the bottom of the output/result is visible without cutting off the cell if it fits
        if (targetRect.bottom > containerRect.bottom - bottomMargin) {
          const delta = targetRect.bottom - (containerRect.bottom - bottomMargin);
          container.scrollBy({ top: delta, behavior: 'smooth' });
        } else if (targetRect.top < containerRect.top + topMargin) {
          const delta = targetRect.top - (containerRect.top + topMargin);
          container.scrollBy({ top: delta, behavior: 'smooth' });
        }
      } else {
        if (targetRect.top < containerRect.top + topMargin) {
          const delta = targetRect.top - (containerRect.top + topMargin);
          container.scrollBy({ top: delta, behavior: 'smooth' });
        } else if (targetRect.bottom > containerRect.bottom - bottomMargin) {
          const delta = targetRect.bottom - (containerRect.bottom - bottomMargin);
          container.scrollBy({ top: delta, behavior: 'smooth' });
        }
      }
    });

    return () => window.cancelAnimationFrame(timer);
  }, [scrollSignal, tab.path, isVisible]);

  useEffect(() => {
    if (!isActivePane) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-modal-root="true"], .workspace-sidebar, .activity-rail, [data-app-menu]')) return;

      const inInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.closest('.cm-editor') || target.closest('[data-app-menu]') || target.tagName === 'BUTTON' || target.tagName === 'SUMMARY');

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveTabById(tab.id);
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

      const idx = visibleCells.findIndex((c) => c.id === activeCell.id);
      const lowerKey = e.key.toLowerCase();
      const now = Date.now();

      // Jupyter Two-Key Chords in Command Mode: 0,0 (Restart Kernel), I,I (Interrupt), D,D (Delete Cell)
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === '0') {
          if (lastChordRef.current.key === '0' && now - lastChordRef.current.time < 600) {
            e.preventDefault();
            lastChordRef.current = { key: '', time: 0 };
            restartKernel(true);
            return;
          }
          lastChordRef.current = { key: '0', time: now };
          return;
        }

        if (lowerKey === 'i') {
          if (lastChordRef.current.key === 'i' && now - lastChordRef.current.time < 600) {
            e.preventDefault();
            lastChordRef.current = { key: '', time: 0 };
            interruptKernel();
            return;
          }
          lastChordRef.current = { key: 'i', time: now };
          return;
        }

        if (lowerKey === 'd') {
          if (lastChordRef.current.key === 'd' && now - lastChordRef.current.time < 600) {
            e.preventDefault();
            lastChordRef.current = { key: '', time: 0 };
            deleteCell(activeCell.id);
            return;
          }
          lastChordRef.current = { key: 'd', time: now };
          return;
        }
      }

      lastChordRef.current = { key: '', time: 0 };

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
      } else if (e.key === 'ArrowUp' || lowerKey === 'k') {
        e.preventDefault();
        if (idx > 0) selectCell(visibleCells[idx - 1].id, 'command', true);
      } else if (e.key === 'ArrowDown' || lowerKey === 'j') {
        e.preventDefault();
        if (idx < visibleCells.length - 1) selectCell(visibleCells[idx + 1].id, 'command', true);
      } else if (lowerKey === 'a' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        addCellAbove(activeCell.id, 'code');
      } else if (lowerKey === 'b' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        addCellBelow(activeCell.id, 'code');
      } else if (
        (lowerKey === 'm' && !e.ctrlKey && !e.metaKey) ||
        ((e.ctrlKey || e.metaKey) && lowerKey === 'm')
      ) {
        e.preventDefault();
        changeCellType(
          activeCell.id,
          activeCell.cell_type === 'code' ? 'markdown' : 'code'
        );
      } else if (lowerKey === 'y' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        changeCellType(activeCell.id, 'code');
      } else if (lowerKey === 'x' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        cutCell(activeCell.id);
      } else if (lowerKey === 'c' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        copyCell(activeCell.id);
      } else if (lowerKey === 'v' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        pasteCellBelow(activeCell.id);
      } else if (lowerKey === 'z' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        undoDeleteCell();
      } else if (lowerKey === 'l' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleLineNumbers();
      } else if (lowerKey === 'o' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleCellOutputCollapse(activeCell.id);
      } else if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key === 'Backspace'
      ) {
        e.preventDefault();
        deleteCell(activeCell.id);
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [
    isActivePane,
    notebookMode,
    activeCell,
    tab.id,
    tab.cells,
    saveTabById,
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
    undoDeleteCell,
    toggleLineNumbers,
    toggleCellOutputCollapse,
    restartKernel,
    interruptKernel,
  ]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Sober Technical Notebook Toolbar */}
      <div
        onWheel={(e) => {
          if (e.deltaY !== 0) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
        className="h-9 px-3 flex items-center justify-between border-b shrink-0 select-none gap-2 overflow-x-auto overflow-y-hidden no-scrollbar"
        style={{
          backgroundColor: 'var(--sat-bg-surface)',
          borderColor: 'var(--sat-border)',
        }}
      >
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => saveTabById(tab.id)}
            title="Salvar Notebook (Ctrl+S)"
            className="h-7 px-2 rounded-[3px] text-xs flex items-center gap-1.5 hover:bg-[var(--sat-bg-hover)] hover:text-[var(--sat-text-primary)] transition-colors cursor-pointer"
            style={{ color: 'var(--sat-text-secondary)' }}
          >
            <Save size={13} /><span>Salvar</span>
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
            className="h-7 px-2 rounded-[3px] text-xs font-medium flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] transition-colors cursor-pointer"
          >
            <Plus size={13} />
            <span>Code</span>
          </button>

          <button
            onClick={() => {
              const id = addCellBelow(activeCell?.id, 'markdown');
              if (id) selectCell(id, 'edit');
            }}
            className="h-7 px-2 rounded-[3px] text-xs font-medium flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] hover:text-[var(--sat-text-primary)] transition-colors cursor-pointer"
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
            className="h-7 px-2.5 rounded-[3px] text-xs font-medium flex items-center gap-1.5 hover:bg-[var(--sat-bg-hover)] transition-colors cursor-pointer"
          >
            <FastForward size={13} />
            <span className="hidden md:inline">Run All</span>
          </button>

          {tab.kernelStatus === 'busy' && (
            <button
              onClick={() => interruptKernel()}
              title="Interromper execução (I, I)"
              className="h-7 px-2 rounded-[3px] text-xs font-medium flex items-center gap-1 text-red-400 hover:bg-red-500/10 cursor-pointer"
            >
              <Square size={12} className="fill-current" />
              <span>Stop</span>
            </button>
          )}

        </div>
      </div>

      {/* Scrollable Cells Canvas */}
      <div
        data-notebook-scroll
        ref={scrollContainerRef}
        onMouseDownCapture={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest('[data-cell-surface], button, input, textarea, select')) return;
          // Stop CodeMirror's document mouse handler from projecting margin clicks
          // back into a line of the previously focused editor.
          e.preventDefault();
          e.stopPropagation();
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          selectCell('', 'command');
        }}
        className="flex-1 overflow-y-auto px-3 md:px-5 py-3"
        style={{ backgroundColor: 'var(--sat-bg-canvas)' }}
      >
        <div
          className={`notebook-cells-list ${
            notebookLayout === 'expanded' ? 'w-full max-w-none' : 'max-w-6xl mx-auto'
          } pb-28 space-y-2.5`}
        >
          {visibleCells.map((cell) => (
            <NotebookCell
              key={cell.id}
              cell={cell}
              isActive={isActivePane && cell.id === tab.activeCellId}
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
              className="h-7 px-3 rounded-[3px] border text-xs font-medium flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] transition-colors cursor-pointer"
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
              className="h-7 px-3 rounded-[3px] border text-xs font-medium flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] hover:text-[var(--sat-text-primary)] transition-colors cursor-pointer"
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
});
