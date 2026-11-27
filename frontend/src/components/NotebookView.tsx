import { useShallow } from 'zustand/react/shallow';
import React, { useEffect, useMemo, useRef } from 'react';
import {
  FastForward,
  Map as MapIcon,
  Plus,
  Save,
  Square,
} from 'lucide-react';
import { OpenNotebookTab } from '../types/notebook';
import { canAcceptInlineAIPreview, useSaturnoStore } from '../store/useSaturnoStore';
import { hiddenSectionCells } from '../utils/notebookOutline';
import { NotebookCell } from './NotebookCell';
import { NotebookMinimap } from './NotebookMinimap';

interface Props {
  tab: OpenNotebookTab;
  isActivePane?: boolean;
  isVisible?: boolean;
}

export const NotebookView: React.FC<Props> = React.memo(({ tab, isActivePane = true, isVisible = true }) => {
  const {
    notebookMode,
    notebookLayout,
    showMinimap,
    minimapWidth,
    minimapShowOutputs,
    toggleMinimap,
    setMinimapWidth,
    saveTabById,
    addCellAbove,
    addCellBelow,
    cutCell,
    copyCell,
    pasteCellBelow,
    deleteCell,
    undoDeleteCell,
    redoDeleteCell,
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
    showMinimap: s.showMinimap,
    minimapWidth: s.minimapWidth,
    minimapShowOutputs: s.minimapShowOutputs,
    toggleMinimap: s.toggleMinimap,
    setMinimapWidth: s.setMinimapWidth,
    saveTabById: s.saveTabById,
    addCellAbove: s.addCellAbove,
    addCellBelow: s.addCellBelow,
    cutCell: s.cutCell,
    copyCell: s.copyCell,
    pasteCellBelow: s.pasteCellBelow,
    deleteCell: s.deleteCell,
    undoDeleteCell: s.undoDeleteCell,
    redoDeleteCell: s.redoDeleteCell,
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
  const handledScrollRef = useRef(useSaturnoStore.getState().scrollSignal);
  const lastChordRef = useRef<{ key: string; time: number }>({ key: '', time: 0 });

  const visibleCells = useMemo(() => {
    const hiddenCells = hiddenSectionCells(tab.cells);
    return hiddenCells.size ? tab.cells.filter(c => !hiddenCells.has(c.id)) : tab.cells;
  }, [tab.cells]);
  const activeCell = tab.cells.find((c) => c.id === tab.activeCellId);

  // Auto-scroll to cell or cell result without triggering NotebookView re-renders
  useEffect(() => {
    if (!isVisible) return;
    let rafId: number | null = null;

    const applyScroll = (scrollSignal: ReturnType<typeof useSaturnoStore.getState>['scrollSignal']) => {
      if (handledScrollRef.current === scrollSignal) return;
      handledScrollRef.current = scrollSignal;
      if (!scrollSignal || scrollSignal.notebookPath !== tab.path) return;
      const container = scrollContainerRef.current;
      if (!container) return;

      if (rafId !== null) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const escapedId = CSS.escape(scrollSignal.cellId);
        const cellEl = container.querySelector(
          `[data-cell-id="${escapedId}"]`
        ) as HTMLElement | null;
        const outputEl = container.querySelector(
          `[data-cell-output-id="${escapedId}"]`
        ) as HTMLElement | null;
        const bottomEl = container.querySelector(
          `[data-cell-bottom-id="${escapedId}"]`
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
          if (targetRect.bottom > containerRect.bottom - bottomMargin) {
            const desiredDown = targetRect.bottom - (containerRect.bottom - bottomMargin);
            // Never scroll the top of a tall output off-screen (prevents up/down ping-pong).
            const maxDown = Math.max(0, targetRect.top - (containerRect.top + topMargin));
            const delta = Math.min(desiredDown, maxDown);
            if (delta > 1) {
              container.scrollBy({ top: delta, behavior: 'smooth' });
            }
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
    };

    applyScroll(useSaturnoStore.getState().scrollSignal);
    const unsub = useSaturnoStore.subscribe((state, prev) => {
      if (state.scrollSignal !== prev.scrollSignal) {
        applyScroll(state.scrollSignal);
      }
    });

    return () => {
      unsub();
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [tab.path, isVisible]);

  const keyStateRef = useRef({
    notebookMode,
    activeCell,
    visibleCells,
    tabId: tab.id,
  });
  keyStateRef.current = {
    notebookMode,
    activeCell,
    visibleCells,
    tabId: tab.id,
  };

  useEffect(() => {
    if (!isActivePane) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? (e.target as HTMLElement) : null;
      if (
        (target && target.closest('[data-modal-root="true"], .workspace-sidebar, .activity-rail, [data-app-menu]')) ||
        document.querySelector('[data-modal-root="true"], details[data-app-menu][open], .file-context-menu[data-app-menu]')
      ) {
        return;
      }

      const myPanel = scrollContainerRef.current?.closest('[data-tab-panel]');
      const targetPanel = target?.closest('[data-tab-panel]');
      if (targetPanel && myPanel && targetPanel !== myPanel) return;

      const {
        notebookMode: curMode,
        activeCell: curCell,
        visibleCells: curVisibleCells,
        tabId: curTabId,
      } = keyStateRef.current;

      const inInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.closest('.cm-editor') ||
          target.closest('[data-inline-ai]') ||
          target.closest('[data-app-menu]') ||
          target.tagName === 'BUTTON' ||
          target.tagName === 'SUMMARY');

      const isEnterKey = e.key === 'Enter' || e.key === '\n' || e.key === '\r';
      if (
        !e.defaultPrevented &&
        !e.isComposing &&
        isEnterKey &&
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        !target?.closest('[data-inline-ai]')
      ) {
        const targetCellEl = target?.closest<HTMLElement>('[data-cell-id]');
        if (
          !targetCellEl ||
          !scrollContainerRef.current ||
          scrollContainerRef.current.contains(targetCellEl)
        ) {
          const isUnrelatedEditable = Boolean(
            target &&
              (target.closest('.cm-search') ||
                (!target.closest('.cm-content') &&
                  (target.matches('input, textarea, select') ||
                    Boolean(target.closest('[contenteditable="true"]')))))
          );
          const targetCellId = targetCellEl ? targetCellEl.dataset.cellId : curCell?.id;
          if (targetCellId && !isUnrelatedEditable) {
            const store = useSaturnoStore.getState();
            if (canAcceptInlineAIPreview(store.inlineAI[targetCellId])) {
              e.preventDefault();
              e.stopPropagation();
              const editor = scrollContainerRef.current?.querySelector<HTMLElement>(
                `[data-cell-id="${CSS.escape(targetCellId)}"] .cm-content`
              );
              store.acceptInlineAI(targetCellId, true);
              window.requestAnimationFrame(() => {
                if (editor?.isConnected) editor.focus();
              });
              return;
            }
          }
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveTabById(curTabId);
        return;
      }

      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === 'i' || e.key.toLowerCase() === 'k') &&
        !inInput
      ) {
        e.preventDefault();
        if (curCell) {
          selectCell(curCell.id, 'edit');
          openInlineAI(curCell.id, null);
        }
        return;
      }

      if (inInput || curMode !== 'command' || !curCell) return;

      const idx = curVisibleCells.findIndex((c) => c.id === curCell.id);
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
            deleteCell(curCell.id);
            return;
          }
          lastChordRef.current = { key: 'd', time: now };
          return;
        }
      }

      lastChordRef.current = { key: '', time: 0 };

      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        runCell(curCell.id, 'next');
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runCell(curCell.id, 'none');
      } else if (e.key === 'Enter' && e.altKey) {
        e.preventDefault();
        runCell(curCell.id, 'insert');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (curCell.cell_type === 'markdown') {
          setMarkdownRendered(curCell.id, false);
        }
        selectCell(curCell.id, 'edit');
      } else if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        moveCell(curCell.id, 'up');
      } else if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        moveCell(curCell.id, 'down');
      } else if (e.key === 'ArrowUp' || lowerKey === 'k') {
        e.preventDefault();
        if (idx > 0) selectCell(curVisibleCells[idx - 1].id, 'command', true);
      } else if (e.key === 'ArrowDown' || lowerKey === 'j') {
        e.preventDefault();
        if (idx < curVisibleCells.length - 1) selectCell(curVisibleCells[idx + 1].id, 'command', true);
      } else if (lowerKey === 'a' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        addCellAbove(curCell.id, 'code');
      } else if (lowerKey === 'b' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        addCellBelow(curCell.id, 'code');
      } else if (
        (lowerKey === 'm' && !e.ctrlKey && !e.metaKey) ||
        ((e.ctrlKey || e.metaKey) && lowerKey === 'm')
      ) {
        e.preventDefault();
        changeCellType(
          curCell.id,
          curCell.cell_type === 'code' ? 'markdown' : 'code'
        );
      } else if (lowerKey === 'y' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        changeCellType(curCell.id, 'code');
      } else if (lowerKey === 'x' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        cutCell(curCell.id);
      } else if (lowerKey === 'c' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        copyCell(curCell.id);
      } else if (lowerKey === 'v' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        pasteCellBelow(curCell.id);
      } else if (lowerKey === 'z' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) redoDeleteCell();
        else undoDeleteCell();
      } else if (lowerKey === 'l' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleLineNumbers();
      } else if (lowerKey === 'o' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleCellOutputCollapse(curCell.id);
      } else if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key === 'Backspace'
      ) {
        e.preventDefault();
        deleteCell(curCell.id);
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [
    isActivePane,
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
    redoDeleteCell,
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

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => toggleMinimap()}
            aria-pressed={showMinimap}
            aria-label={showMinimap ? 'Ocultar minimapa' : 'Mostrar minimapa'}
            title={showMinimap ? 'Ocultar minimapa' : 'Mostrar minimapa'}
            className="h-7 px-2 rounded-[3px] text-xs flex items-center gap-1.5 hover:bg-[var(--sat-bg-hover)] hover:text-[var(--sat-text-primary)] transition-colors cursor-pointer"
            style={{
              backgroundColor: showMinimap ? 'var(--sat-accent-soft)' : 'transparent',
              color: showMinimap ? 'var(--sat-accent)' : 'var(--sat-text-secondary)',
            }}
          >
            <MapIcon size={13} />
            <span className="hidden md:inline">Minimapa</span>
          </button>
        </div>
      </div>

      {/* Scrollable Cells Canvas + Optional Minimap */}
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
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
        className="flex-1 min-w-0 overflow-y-auto px-3 md:px-5 py-3.5"
        style={{ backgroundColor: 'var(--sat-bg-canvas)' }}
      >
        <div
          className={`notebook-cells-list ${
            notebookLayout === 'expanded' ? 'w-full max-w-none' : 'max-w-6xl mx-auto'
          } pb-28 space-y-3`}
        >
          {visibleCells.map((cell, index) => (
            <NotebookCell
              previousId={visibleCells[index - 1]?.id}
              nextId={visibleCells[index + 1]?.id}
              key={cell.id}
              cell={cell}
              isActive={isActivePane && cell.id === tab.activeCellId}
            />
          ))}

          {/* Bottom Add Buttons */}
          <div className="pl-[70px] pt-3 flex items-center gap-2 opacity-55 hover:opacity-100 transition-opacity">
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

      {showMinimap && (
        <NotebookMinimap
          scrollContainerRef={scrollContainerRef}
          cells={visibleCells}
          activeCellId={tab.activeCellId}
          notebookMode={notebookMode}
          width={minimapWidth}
          showOutputs={minimapShowOutputs}
          isVisible={isVisible}
          onSelectCell={(cellId) => selectCell(cellId, 'command', true)}
          onResizeWidth={setMinimapWidth}
        />
      )}
      </div>
    </div>
  );
});
