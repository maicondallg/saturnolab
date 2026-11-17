import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsDownUp,
  ChevronsLeftRight,
  ChevronsUpDown,
  Columns3,
  Copy,
  Download,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Minimize2,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Table2,
  WrapText,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { TableOutputSettings } from '../types/notebook';
import {
  classifyCellValue,
  compareTableCellValues,
  extractTableDelimited,
  inspectAndEnhanceHtml,
  isEllipsisToken,
  TableMeta,
  VirtualExportSource,
  VirtualTableData,
  VirtualTableRow,
} from '../utils/htmlTableUtils';
import {
  copyTablePngToClipboard,
  downloadTableCsv,
  downloadTablePng,
  downloadTableXlsx,
  ensureReadableStylerContrast,
  ExportScope,
  getViewportVisibleRows,
} from '../utils/tableExportUtils';

interface Props {
  rawHtml: string;
  outputLimited?: boolean;
  onExpandTruncated?: () => void;
  isExpandingTruncated?: boolean;
  isExpandedTruncated?: boolean;
}

export interface InspectedCellData {
  colIndex: number;
  colLabel: string;
  rowLabel: string;
  text: string;
  isPandasCut: boolean;
}

interface SortState {
  col: number;
  dir: 'asc' | 'desc';
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below for non-secure origins
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

interface TableViewportProps {
  tableHtml: string;
  virtualData?: VirtualTableData;
  activeVirtualRows?: VirtualTableRow[];
  preservedStylesHtml?: string;
  meta: TableMeta;
  settings: TableOutputSettings;
  filterQuery: string;
  sortState: SortState | null;
  onSortChange: (next: SortState | null) => void;
  colOrder: number[];
  onColOrderChange: (next: number[]) => void;
  colWidths: Record<number, number>;
  onColWidthChange: (col: number, width: number | null) => void;
  hiddenCols: number[];
  onVisibleCountChange: (count: number) => void;
  onVerticalOverflowChange?: (overflows: boolean) => void;
  tableRefOut: React.MutableRefObject<HTMLTableElement | null>;
  viewportRefOut?: React.MutableRefObject<HTMLDivElement | null>;
  scrollRefOut?: React.MutableRefObject<HTMLDivElement | null>;
  isFullscreen?: boolean;
  modalExpanded?: boolean;
  outputLimited?: boolean;
  onInspectCell?: (cell: InspectedCellData) => void;
}

const VIRTUAL_OVERSCAN_ROWS = 18;
const PT_BR_COLLATOR = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

function estimateRowHeightPx(settings: TableOutputSettings): number {
  const lineH = Math.round(settings.font_size * 1.4);
  const padY =
    settings.density === 'compact' ? 6 : settings.density === 'comfortable' ? 14 : 10;
  return lineH + padY + 1;
}

function decorateSortValue(raw: string, isNumericCol: boolean): { missing: boolean; num: number; str: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { missing: true, num: NaN, str: '' };
  if (isNumericCol) {
    // Fast C++ path for plain numbers (99% of numeric cells)
    const direct = Number(trimmed);
    if (!Number.isNaN(direct)) {
      return { missing: false, num: direct, str: trimmed };
    }
  }
  const kind = classifyCellValue(trimmed);
  if (kind === 'empty' || kind === 'null') {
    return { missing: true, num: NaN, str: '' };
  }
  if (isNumericCol || kind === 'number') {
    const num = Number(trimmed.replace(/,/g, '').replace(/%$/, ''));
    if (!Number.isNaN(num)) {
      return { missing: false, num, str: trimmed };
    }
  }
  return { missing: false, num: NaN, str: trimmed };
}

const VirtualTableViewport: React.FC<
  Omit<TableViewportProps, 'tableHtml' | 'filterQuery' | 'onVisibleCountChange'> & {
    virtualData: VirtualTableData;
    rows: VirtualTableRow[];
  }
> = React.memo(({
  virtualData,
  rows,
  preservedStylesHtml = '',
  meta,
  settings,
  sortState,
  onSortChange,
  colOrder,
  onColOrderChange,
  colWidths,
  onColWidthChange,
  hiddenCols,
  onVerticalOverflowChange,
  tableRefOut,
  viewportRefOut,
  scrollRefOut,
  isFullscreen = false,
  modalExpanded = false,
  outputLimited = false,
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const theadRef = useRef<HTMLTableSectionElement>(null);
  const theadOrigCellsRef = useRef<Map<HTMLTableRowElement, HTMLTableCellElement[]>>(new Map());
  const suppressNextSortClickRef = useRef(false);

  const [scrollState, setScrollState] = useState({ left: false, right: false });
  const [viewportHeight, setViewportHeight] = useState(400);
  const [measuredRowH, setMeasuredRowH] = useState<number | null>(null);
  const [windowStart, setWindowStart] = useState(0);

  const rowH =
    settings.wrap === 'nowrap' && measuredRowH && measuredRowH > 14
      ? measuredRowH
      : estimateRowHeightPx(settings);

  useEffect(() => {
    setMeasuredRowH(null);
  }, [settings.density, settings.font_size, settings.wrap]);

  useLayoutEffect(() => {
    tableRefOut.current = tableRef.current;
    if (viewportRefOut) viewportRefOut.current = viewportRef.current;
    if (scrollRefOut) scrollRefOut.current = scrollRef.current;
    return () => {
      tableRefOut.current = null;
      if (viewportRefOut) viewportRefOut.current = null;
      if (scrollRefOut) scrollRefOut.current = null;
    };
  }, [tableRefOut, viewportRefOut, scrollRefOut]);

  // Clamp windowStart when filtered row count shrinks
  useEffect(() => {
    setWindowStart((prev) => {
      if (rows.length === 0) return 0;
      if (prev >= rows.length) {
        const clamped = Math.max(0, rows.length - 40);
        return Math.floor(clamped / 2) * 2;
      }
      return prev;
    });
  }, [rows.length]);

  const computeWindowStart = useCallback(
    (scrollTop: number, totalRows: number) => {
      if (totalRows <= 0 || scrollTop <= 4) return 0;
      const raw = Math.floor(scrollTop / Math.max(16, rowH)) - VIRTUAL_OVERSCAN_ROWS;
      if (raw <= 0) return 0;
      const clamped = Math.min(raw, Math.max(0, totalRows - 20));
      // Keep even alignment so zebra striping (:nth-child) never flickers on scroll
      return Math.floor(clamped / 2) * 2;
    },
    [rowH]
  );

  const measureScrollAndWindow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ch = el.clientHeight || 400;
    setViewportHeight((prev) => (Math.abs(prev - ch) > 4 ? ch : prev));

    const canLeft = el.scrollLeft > 2;
    const canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setScrollState((prev) =>
      prev.left === canLeft && prev.right === canRight
        ? prev
        : { left: canLeft, right: canRight }
    );
    if (onVerticalOverflowChange) {
      const overflows = el.scrollHeight > el.clientHeight + 2;
      onVerticalOverflowChange(overflows);
    }

    const targetStart = computeWindowStart(el.scrollTop, rows.length);
    setWindowStart((prev) => {
      if (targetStart === 0 && prev !== 0) return 0;
      if (Math.abs(targetStart - prev) >= 4 || targetStart + 24 >= rows.length) {
        return targetStart;
      }
      return prev;
    });
  }, [computeWindowStart, onVerticalOverflowChange, rows.length]);

  // Mount lightweight <thead> HTML once per virtualData change
  useLayoutEffect(() => {
    const theadEl = theadRef.current;
    if (!theadEl) return;
    if (virtualData.theadHtml) {
      const tempTable = document.createElement('table');
      tempTable.innerHTML = virtualData.theadHtml;
      const parsedThead = tempTable.tHead;
      theadEl.innerHTML = parsedThead ? parsedThead.innerHTML : '';
    } else {
      theadEl.innerHTML = '';
    }

    const map = new Map<HTMLTableRowElement, HTMLTableCellElement[]>();
    for (const tr of Array.from(theadEl.rows)) {
      map.set(tr, Array.from(tr.cells));
    }
    for (const hCell of Array.from(theadEl.querySelectorAll<HTMLElement>('[data-sat-resizable-col]'))) {
      const origCol = hCell.getAttribute('data-sat-resizable-col');
      if (origCol !== null && !hCell.querySelector('.sat-col-resize-handle')) {
        const handle = document.createElement('div');
        handle.className = 'sat-col-resize-handle';
        handle.setAttribute('data-sat-resize-col', origCol);
        handle.setAttribute(
          'title',
          'Arrastar para mudar largura da coluna • Duplo-clique para redefinir'
        );
        hCell.appendChild(handle);
      }
    }
    theadOrigCellsRef.current = map;
  }, [virtualData]);

  const hiddenSet = useMemo(() => new Set(hiddenCols), [hiddenCols]);
  const visibleCols = useMemo(
    () => colOrder.filter((c) => !hiddenSet.has(c)),
    [colOrder, hiddenSet]
  );
  const firstVisibleCol = visibleCols[0];

  // Sync <thead> column order, hidden columns, widths, and sort indicator
  useLayoutEffect(() => {
    const theadEl = theadRef.current;
    if (!theadEl) return;

    for (const tr of Array.from(theadEl.rows)) {
      const origCells = theadOrigCellsRef.current.get(tr);
      if (!origCells || origCells.length === 0) continue;

      if (meta.canReorderColumns && origCells.length === meta.totalCols && colOrder.length === meta.totalCols) {
        const frag = document.createDocumentFragment();
        for (const colIdx of colOrder) {
          const cell = origCells[colIdx];
          if (cell) frag.appendChild(cell);
        }
        tr.appendChild(frag);
      }

      for (let origIdx = 0; origIdx < origCells.length; origIdx++) {
        const cell = origCells[origIdx];
        if (!cell) continue;
        const isHidden = hiddenSet.has(origIdx);
        cell.hidden = isHidden;
        if (isHidden) {
          cell.setAttribute('data-sat-col-hidden', 'true');
        } else {
          cell.removeAttribute('data-sat-col-hidden');
        }

        if (meta.canStickyIndex && origIdx === 0) {
          if (firstVisibleCol === 0) {
            cell.setAttribute('data-sat-sticky-index', 'true');
          } else {
            cell.removeAttribute('data-sat-sticky-index');
          }
        }
      }
    }

    for (const cell of Array.from(theadEl.querySelectorAll('[data-sat-sortable-col]'))) {
      const colAttr = Number(cell.getAttribute('data-sat-sortable-col'));
      if (sortState && sortState.col === colAttr) {
        cell.setAttribute('data-sat-sort', sortState.dir);
      } else {
        cell.removeAttribute('data-sat-sort');
      }
    }

    const raf = window.requestAnimationFrame(measureScrollAndWindow);
    return () => window.cancelAnimationFrame(raf);
  }, [
    colOrder,
    hiddenSet,
    firstVisibleCol,
    sortState,
    meta.canReorderColumns,
    meta.canStickyIndex,
    meta.totalCols,
    measureScrollAndWindow,
  ]);

  const visibleWindowCount = Math.ceil(Math.max(240, viewportHeight) / Math.max(16, rowH));
  const startIdx = Math.min(windowStart, Math.max(0, rows.length));
  const endIdx = Math.min(
    rows.length,
    startIdx + visibleWindowCount + VIRTUAL_OVERSCAN_ROWS * 2
  );
  const renderedSlice = rows.slice(startIdx, endIdx);
  const topPad = startIdx * rowH;
  const bottomPad = Math.max(0, (rows.length - endIdx) * rowH);

  // Measure actual rendered row height once & apply Styler contrast ONLY to the ~50 mounted rows
  useLayoutEffect(() => {
    const tbl = tableRef.current;
    if (!tbl) return;
    if (settings.wrap === 'nowrap' && measuredRowH === null && renderedSlice.length > 0) {
      const sampleTr = tbl.tBodies[0]?.querySelector('tr:not([data-sat-spacer="true"])') as HTMLElement | null;
      if (sampleTr) {
        const h = sampleTr.getBoundingClientRect().height;
        if (h > 14 && Math.abs(h - rowH) >= 0.5) {
          setMeasuredRowH(h);
        }
      }
    }
    if (virtualData.hasCustomStyles || preservedStylesHtml) {
      ensureReadableStylerContrast(tbl);
    }
  }, [renderedSlice, settings.wrap, measuredRowH, rowH, virtualData.hasCustomStyles, preservedStylesHtml]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measureScrollAndWindow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureScrollAndWindow, settings]);

  // Column widths & table total width for rock-solid horizontal stability during scroll
  const { effectiveColWidths, totalTableWidth } = useMemo(() => {
    const globalCap =
      settings.max_col_width > 0
        ? settings.max_col_width
        : settings.wrap === 'wrap'
          ? 340
          : 560;
    const widths: Record<number, number> = {};
    let sum = 0;
    for (const c of visibleCols) {
      const custom = colWidths[c];
      const est = virtualData.colEstimatedWidths[c] || 96;
      const w = custom && custom > 0 ? custom : Math.min(globalCap, est);
      widths[c] = w;
      sum += w;
    }
    return { effectiveColWidths: widths, totalTableWidth: Math.max(120, sum) };
  }, [visibleCols, colWidths, virtualData.colEstimatedWidths, settings.max_col_width, settings.wrap]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;

      const resizeHandle = target.closest('.sat-col-resize-handle') as HTMLElement | null;
      if (resizeHandle) {
        e.preventDefault();
        e.stopPropagation();
        const origCol = Number(resizeHandle.getAttribute('data-sat-resize-col'));
        const th = resizeHandle.parentElement as HTMLTableCellElement | null;
        if (Number.isNaN(origCol) || !th) return;

        const startX = e.clientX;
        const startWidth = th.getBoundingClientRect().width;
        resizeHandle.setAttribute('data-resizing', 'true');
        suppressNextSortClickRef.current = true;

        const onMove = (ev: PointerEvent) => {
          const delta = ev.clientX - startX;
          const nextW = Math.max(48, Math.min(1200, Math.round(startWidth + delta)));
          onColWidthChange(origCol, nextW);
        };

        const onUp = () => {
          resizeHandle.removeAttribute('data-resizing');
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          window.setTimeout(() => {
            suppressNextSortClickRef.current = false;
          }, 50);
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        return;
      }

      if (!meta.canReorderColumns) return;
      const th = target.closest('thead th[data-sat-orig-col]') as HTMLTableCellElement | null;
      if (!th) return;
      const sourceCol = Number(th.getAttribute('data-sat-orig-col'));
      if (Number.isNaN(sourceCol)) return;

      const startX = e.clientX;
      const startY = e.clientY;
      let isDragging = false;
      let dropTargetCol: number | null = null;
      let dropSide: 'left' | 'right' = 'right';

      const clearIndicators = () => {
        const theadEl = theadRef.current;
        if (!theadEl) return;
        for (const el of Array.from(theadEl.querySelectorAll('[data-sat-drop-side], [data-sat-dragging]'))) {
          el.removeAttribute('data-sat-drop-side');
          el.removeAttribute('data-sat-dragging');
        }
      };

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!isDragging) {
          if (Math.abs(dx) < 6 || Math.abs(dy) > Math.abs(dx) * 1.5) return;
          isDragging = true;
          suppressNextSortClickRef.current = true;
          th.setAttribute('data-sat-dragging', 'true');
        }

        const theadEl = theadRef.current;
        if (!theadEl) return;
        for (const el of Array.from(theadEl.querySelectorAll('[data-sat-drop-side]'))) {
          el.removeAttribute('data-sat-drop-side');
        }

        const elemBelow = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const hoverTh = elemBelow?.closest('thead th[data-sat-orig-col]') as HTMLTableCellElement | null;
        if (!hoverTh || !theadEl.contains(hoverTh)) {
          dropTargetCol = null;
          return;
        }
        const candCol = Number(hoverTh.getAttribute('data-sat-orig-col'));
        if (Number.isNaN(candCol) || candCol === sourceCol) {
          dropTargetCol = null;
          return;
        }

        const rect = hoverTh.getBoundingClientRect();
        dropSide = ev.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
        dropTargetCol = candCol;
        hoverTh.setAttribute('data-sat-drop-side', dropSide);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);

        if (isDragging) {
          clearIndicators();
          if (dropTargetCol !== null && dropTargetCol !== sourceCol) {
            const nextOrder = colOrder.filter((c) => c !== sourceCol);
            const targetIdx = nextOrder.indexOf(dropTargetCol);
            if (targetIdx !== -1) {
              const insertAt = dropSide === 'left' ? targetIdx : targetIdx + 1;
              nextOrder.splice(insertAt, 0, sourceCol);
              onColOrderChange(nextOrder);
            }
          }
          window.setTimeout(() => {
            suppressNextSortClickRef.current = false;
          }, 50);
        }
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    },
    [meta.canReorderColumns, colOrder, onColOrderChange, onColWidthChange]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const resizeHandle = target.closest('.sat-col-resize-handle') as HTMLElement | null;
      if (!resizeHandle) return;
      e.preventDefault();
      e.stopPropagation();
      const origCol = Number(resizeHandle.getAttribute('data-sat-resize-col'));
      if (Number.isNaN(origCol)) return;
      onColWidthChange(origCol, null);
    },
    [onColWidthChange]
  );

  const handleTableClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressNextSortClickRef.current) {
      suppressNextSortClickRef.current = false;
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('.sat-col-resize-handle')) return;
    if (!meta.canSort) return;
    const sel = window.getSelection()?.toString();
    if (sel) return;
    const th = target.closest('thead [data-sat-sortable-col]') as HTMLElement | null;
    if (!th) return;
    const col = Number(th.getAttribute('data-sat-sortable-col'));
    if (Number.isNaN(col)) return;
    if (!sortState || sortState.col !== col) {
      onSortChange({ col, dir: 'asc' });
    } else if (sortState.dir === 'asc') {
      onSortChange({ col, dir: 'desc' });
    } else {
      onSortChange(null);
    }
  };

  // Even when settings.height === 'full', bound huge virtualized tables to 76vh so they never
  // force the browser to render tens of thousands of unvirtualized rows on the page.
  const maxH = isFullscreen
    ? modalExpanded
      ? 'calc(90vh - 44px)'
      : 'calc(84vh - 44px)'
    : settings.height === 'full'
      ? '76vh'
      : outputLimited
        ? '210px'
        : '400px';

  const maxColW =
    settings.max_col_width > 0
      ? `${settings.max_col_width}px`
      : settings.wrap === 'wrap'
        ? '340px'
        : 'none';

  const topPadHalf1 = Math.floor(topPad / 2);
  const topPadHalf2 = topPad - topPadHalf1;

  return (
    <div
      ref={viewportRef}
      className={`sat-table-viewport relative min-w-0 ${isFullscreen ? 'flex-1 min-h-0 flex flex-col' : ''} ${
        scrollState.left ? 'is-scrolled-x' : ''
      }`}
      data-wrap={settings.wrap}
      data-density={settings.density}
      data-align={settings.align}
      data-sticky={String(settings.sticky_headers)}
      data-highlight={String(settings.highlight_types)}
      data-grid={String(settings.show_grid)}
      style={{
        ['--sat-table-font-size' as any]: `${settings.font_size}px`,
        ['--sat-table-max-col-w' as any]: maxColW,
      }}
    >
      <div
        ref={scrollRef}
        onScroll={measureScrollAndWindow}
        className={`sat-table-scroll overflow-auto ${isFullscreen ? 'flex-1 min-h-0' : ''}`}
        style={{ maxHeight: maxH }}
      >
        <div
          onPointerDown={handlePointerDown}
          onDoubleClick={handleDoubleClick}
          onClick={handleTableClick}
          className="sat-table-host min-w-full"
        >
          {preservedStylesHtml && (
            <div
              aria-hidden="true"
              className="hidden"
              dangerouslySetInnerHTML={{ __html: preservedStylesHtml }}
            />
          )}
          <table
            ref={tableRef}
            id={virtualData.tableId}
            className={virtualData.tableClass || 'sat-table'}
            style={{
              tableLayout: 'fixed',
              width: `${totalTableWidth}px`,
              minWidth: '100%',
            }}
          >
            <colgroup>
              {visibleCols.map((colIdx) => (
                <col
                  key={colIdx}
                  style={{
                    width: `${effectiveColWidths[colIdx]}px`,
                  }}
                />
              ))}
            </colgroup>
            <thead ref={theadRef} />
            <tbody>
              {/* Two spacer rows preserve exact :nth-child(even) zebra parity during scroll */}
              {topPad > 0 && (
                <>
                  <tr data-sat-spacer="true" aria-hidden="true" style={{ height: `${topPadHalf1}px` }}>
                    <td colSpan={Math.max(1, visibleCols.length)} style={{ padding: 0, border: 0 }} />
                  </tr>
                  <tr data-sat-spacer="true" aria-hidden="true" style={{ height: `${topPadHalf2}px` }}>
                    <td colSpan={Math.max(1, visibleCols.length)} style={{ padding: 0, border: 0 }} />
                  </tr>
                </>
              )}
              {renderedSlice.map((vRow, localIdx) => {
                const absIdx = startIdx + localIdx;
                const isEllipsis = Boolean(vRow.isEllipsis);
                return (
                  <tr
                    key={absIdx}
                    id={vRow.rowId}
                    className={vRow.rowClass}
                    data-sat-ellipsis-row={isEllipsis ? 'true' : undefined}
                    ref={(el) => {
                      if (el && vRow.rowStyle) el.setAttribute('style', vRow.rowStyle);
                    }}
                  >
                    {visibleCols.map((colIdx) => {
                      const isIndexCell = meta.canStickyIndex && colIdx === 0;
                      const isStickyNow = isIndexCell && firstVisibleCol === 0;
                      const txt = vRow.cells[colIdx] ?? '';
                      const colType = virtualData.colTypes[colIdx] || 'text';
                      const isEllipsisCol = virtualData.ellipsisCols[colIdx];
                      const cellKind =
                        isEllipsis || isEllipsisCol || isEllipsisToken(txt)
                          ? 'null'
                          : isIndexCell
                            ? undefined
                            : classifyCellValue(txt);
                      const cs = vRow.cellStyles?.[colIdx];
                      const CellTag = isIndexCell ? 'th' : 'td';

                      return (
                        <CellTag
                          key={colIdx}
                          id={cs?.id}
                          className={cs?.className}
                          title={txt || undefined}
                          data-sat-orig-col={colIdx}
                          data-sat-col-type={isIndexCell ? undefined : colType}
                          data-sat-type={cellKind}
                          data-sat-index-cell={isIndexCell ? 'true' : undefined}
                          data-sat-sticky-index={isStickyNow ? 'true' : undefined}
                          data-sat-ellipsis-col={isEllipsisCol ? 'true' : undefined}
                          ref={(el) => {
                            if (el && cs?.style) el.setAttribute('style', cs.style);
                          }}
                        >
                          {txt}
                        </CellTag>
                      );
                    })}
                  </tr>
                );
              })}
              {bottomPad > 0 && (
                <tr data-sat-spacer="true" aria-hidden="true" style={{ height: `${bottomPad}px` }}>
                  <td colSpan={Math.max(1, visibleCols.length)} style={{ padding: 0, border: 0 }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {scrollState.right && (
        <div
          aria-hidden="true"
          className="sat-table-fade-right pointer-events-none absolute top-0 right-0 bottom-0 w-6"
        />
      )}
    </div>
  );
});

const DomTableViewport: React.FC<TableViewportProps> = React.memo(({
  tableHtml,
  preservedStylesHtml = '',
  meta,
  settings,
  filterQuery,
  sortState,
  onSortChange,
  colOrder,
  onColOrderChange,
  colWidths,
  onColWidthChange,
  hiddenCols,
  onVisibleCountChange,
  onVerticalOverflowChange,
  tableRefOut,
  viewportRefOut,
  scrollRefOut,
  isFullscreen = false,
  modalExpanded = false,
  outputLimited = false,
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const originalRowsRef = useRef<HTMLTableRowElement[]>([]);
  const rowOrigCellsRef = useRef<WeakMap<HTMLTableRowElement, HTMLTableCellElement[]>>(new WeakMap());
  const hadCustomColsAppliedRef = useRef(false);
  const hadSortAppliedRef = useRef(false);
  const suppressNextSortClickRef = useRef(false);
  const [scrollState, setScrollState] = useState({ left: false, right: false });

  useLayoutEffect(() => {
    if (viewportRefOut) viewportRefOut.current = viewportRef.current;
    if (scrollRefOut) scrollRefOut.current = scrollRef.current;
    return () => {
      if (viewportRefOut) viewportRefOut.current = null;
      if (scrollRefOut) scrollRefOut.current = null;
    };
  }, [viewportRefOut, scrollRefOut]);

  const measureScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const canLeft = el.scrollLeft > 2;
    const canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setScrollState((prev) =>
      prev.left === canLeft && prev.right === canRight
        ? prev
        : { left: canLeft, right: canRight }
    );
    if (onVerticalOverflowChange) {
      const overflows = el.scrollHeight > el.clientHeight + 2;
      onVerticalOverflowChange(overflows);
    }
  }, [onVerticalOverflowChange]);

  // Mount enhanced table HTML + preserved <style> once per tableHtml change
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = preservedStylesHtml ? `${preservedStylesHtml}${tableHtml}` : tableHtml;
    const table = host.querySelector('table') as HTMLTableElement | null;
    tableRefOut.current = table;
    const tbody = table?.tBodies[0] || null;
    originalRowsRef.current = tbody ? Array.from(tbody.rows) : [];

    const map = new WeakMap<HTMLTableRowElement, HTMLTableCellElement[]>();
    if (table) {
      if (table.tHead) {
        for (const tr of Array.from(table.tHead.rows)) {
          map.set(tr, Array.from(tr.cells));
        }
        // Attach resize handles to resizable header cells
        for (const hCell of Array.from(table.tHead.querySelectorAll<HTMLElement>('[data-sat-resizable-col]'))) {
          const origCol = hCell.getAttribute('data-sat-resizable-col');
          if (origCol !== null && !hCell.querySelector('.sat-col-resize-handle')) {
            const handle = document.createElement('div');
            handle.className = 'sat-col-resize-handle';
            handle.setAttribute('data-sat-resize-col', origCol);
            handle.setAttribute(
              'title',
              'Arrastar para mudar largura da coluna • Duplo-clique para redefinir'
            );
            hCell.appendChild(handle);
          }
        }
      }
      for (const tb of Array.from(table.tBodies)) {
        for (const tr of Array.from(tb.rows)) {
          map.set(tr, Array.from(tr.cells));
        }
      }
      if (preservedStylesHtml || meta.hasCustomStyles) {
        ensureReadableStylerContrast(table);
      }
    }
    rowOrigCellsRef.current = map;
    hadCustomColsAppliedRef.current = false;
    hadSortAppliedRef.current = false;

    const raf = window.requestAnimationFrame(measureScroll);
    return () => {
      window.cancelAnimationFrame(raf);
      originalRowsRef.current = [];
      tableRefOut.current = null;
      host.innerHTML = '';
    };
  }, [tableHtml, preservedStylesHtml, meta.hasCustomStyles, tableRefOut, measureScroll]);

  // Apply column order, custom column widths, and hidden columns to DOM
  useLayoutEffect(() => {
    const host = hostRef.current;
    const table = host?.querySelector('table') as HTMLTableElement | null;
    if (!table) return;

    const isDefaultOrder =
      colOrder.length === meta.totalCols && colOrder.every((c, idx) => c === idx);
    const hasCustomWidths = Object.keys(colWidths).length > 0;
    const hasHidden = hiddenCols.length > 0;

    if (isDefaultOrder && !hasCustomWidths && !hasHidden && !hadCustomColsAppliedRef.current) {
      return;
    }
    hadCustomColsAppliedRef.current = !isDefaultOrder || hasCustomWidths || hasHidden;

    const hiddenSet = new Set(hiddenCols);
    const map = rowOrigCellsRef.current;

    const applyRowColumns = (tr: HTMLTableRowElement) => {
      const origCells = map.get(tr);
      if (!origCells || origCells.length === 0) return;

      const canReorderThisRow =
        meta.canReorderColumns &&
        origCells.length === meta.totalCols &&
        colOrder.length === meta.totalCols;

      if (canReorderThisRow) {
        const frag = document.createDocumentFragment();
        for (const colIdx of colOrder) {
          const cell = origCells[colIdx];
          if (cell) frag.appendChild(cell);
        }
        tr.appendChild(frag);
      }

      const firstVisibleCol = colOrder.find((c) => !hiddenSet.has(c));

      for (let origIdx = 0; origIdx < origCells.length; origIdx++) {
        const cell = origCells[origIdx];
        if (!cell) continue;

        const isHidden = hiddenSet.has(origIdx);
        cell.hidden = isHidden;
        if (isHidden) {
          cell.setAttribute('data-sat-col-hidden', 'true');
        } else {
          cell.removeAttribute('data-sat-col-hidden');
        }

        // Only keep sticky-index on the index column if it is still the first visible column
        if (meta.canStickyIndex && origIdx === 0) {
          if (firstVisibleCol === 0) {
            cell.setAttribute('data-sat-sticky-index', 'true');
          } else {
            cell.removeAttribute('data-sat-sticky-index');
          }
        }

        const customW = colWidths[origIdx];
        if (customW && customW > 0) {
          cell.style.width = `${customW}px`;
          cell.style.minWidth = `${customW}px`;
          cell.style.maxWidth = `${customW}px`;
        } else {
          cell.style.removeProperty('width');
          cell.style.removeProperty('min-width');
          cell.style.removeProperty('max-width');
        }
      }
    };

    if (table.tHead) {
      for (const tr of Array.from(table.tHead.rows)) {
        applyRowColumns(tr);
      }
    }
    for (const tb of Array.from(table.tBodies)) {
      for (const tr of Array.from(tb.rows)) {
        applyRowColumns(tr);
      }
    }

    const raf = window.requestAnimationFrame(measureScroll);
    return () => window.cancelAnimationFrame(raf);
  }, [tableHtml, colOrder, colWidths, hiddenCols, meta.canReorderColumns, meta.canStickyIndex, meta.totalCols, measureScroll]);

  // Apply sorting & filtering directly onto mounted table rows without rebuilding DOM
  useLayoutEffect(() => {
    const host = hostRef.current;
    const table = host?.querySelector('table') as HTMLTableElement | null;
    if (!table) return;
    const tbody = table.tBodies[0];
    if (!tbody) return;

    // Update header sort indicators
    if (table.tHead) {
      for (const cell of Array.from(table.tHead.querySelectorAll('[data-sat-sortable-col]'))) {
        const colAttr = Number(cell.getAttribute('data-sat-sortable-col'));
        if (sortState && sortState.col === colAttr) {
          cell.setAttribute('data-sat-sort', sortState.dir);
        } else {
          cell.removeAttribute('data-sat-sort');
        }
      }
    }

    // Reorder tbody rows when sorting is supported
    if (meta.canSort && originalRowsRef.current.length > 0 && (sortState || hadSortAppliedRef.current)) {
      const map = rowOrigCellsRef.current;
      let orderedRows = originalRowsRef.current;
      if (sortState) {
        hadSortAppliedRef.current = true;
        const decorated = originalRowsRef.current.map((row, idx) => {
          const cell = map.get(row)?.[sortState.col] ?? row.cells[sortState.col];
          const text = cell?.textContent || '';
          return {
            row,
            idx,
            key: decorateSortValue(text, cell?.getAttribute('data-sat-col-type') === 'number'),
          };
        });
        decorated.sort((a, b) => {
          if (a.key.missing && b.key.missing) return a.idx - b.idx;
          if (a.key.missing) return 1;
          if (b.key.missing) return -1;
          let cmp = 0;
          if (!Number.isNaN(a.key.num) && !Number.isNaN(b.key.num)) {
            cmp = a.key.num - b.key.num;
          } else {
            cmp = PT_BR_COLLATOR.compare(a.key.str, b.key.str);
          }
          if (cmp === 0) return a.idx - b.idx;
          return sortState.dir === 'asc' ? cmp : -cmp;
        });
        orderedRows = decorated.map((d) => d.row);
      } else {
        hadSortAppliedRef.current = false;
      }
      const frag = document.createDocumentFragment();
      for (const r of orderedRows) {
        frag.appendChild(r);
      }
      tbody.appendChild(frag);
    }

    // Filter rows
    const needle = filterQuery.trim().toLowerCase();
    let visible = 0;
    for (const row of Array.from(tbody.rows)) {
      if (!needle || meta.hasRowSpanInBody) {
        row.hidden = false;
        if (row.getAttribute('data-sat-ellipsis-row') !== 'true') {
          visible += 1;
        }
      } else {
        const isEllipsis = row.getAttribute('data-sat-ellipsis-row') === 'true';
        if (isEllipsis) {
          row.hidden = true;
          continue;
        }
        const rowText = (row.textContent || '').toLowerCase();
        const matches = rowText.includes(needle);
        row.hidden = !matches;
        if (matches) visible += 1;
      }
    }
    onVisibleCountChange(visible);

    const raf = window.requestAnimationFrame(measureScroll);
    return () => window.cancelAnimationFrame(raf);
  }, [tableHtml, filterQuery, sortState, meta.canSort, meta.hasRowSpanInBody, onVisibleCountChange, measureScroll]);

  // Observe container resize to keep horizontal scroll cues accurate
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measureScroll());
    ro.observe(el);
    if (hostRef.current) ro.observe(hostRef.current);
    return () => ro.disconnect();
  }, [measureScroll, settings]);

  // Handle pointer interactions on thead: Column Resize & Column Drag-to-Reorder
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;

      // 1. Column Resize Handle
      const resizeHandle = target.closest('.sat-col-resize-handle') as HTMLElement | null;
      if (resizeHandle) {
        e.preventDefault();
        e.stopPropagation();
        const origCol = Number(resizeHandle.getAttribute('data-sat-resize-col'));
        const th = resizeHandle.parentElement as HTMLTableCellElement | null;
        if (Number.isNaN(origCol) || !th) return;

        const startX = e.clientX;
        const startWidth = th.getBoundingClientRect().width;
        resizeHandle.setAttribute('data-resizing', 'true');
        suppressNextSortClickRef.current = true;

        const onMove = (ev: PointerEvent) => {
          const delta = ev.clientX - startX;
          const nextW = Math.max(48, Math.min(1200, Math.round(startWidth + delta)));
          onColWidthChange(origCol, nextW);
        };

        const onUp = () => {
          resizeHandle.removeAttribute('data-resizing');
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          window.setTimeout(() => {
            suppressNextSortClickRef.current = false;
          }, 50);
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        return;
      }

      // 2. Column Drag-and-Drop Reorder on Header Cells
      if (!meta.canReorderColumns) return;
      const th = target.closest('thead th[data-sat-orig-col]') as HTMLTableCellElement | null;
      if (!th) return;
      const sourceCol = Number(th.getAttribute('data-sat-orig-col'));
      if (Number.isNaN(sourceCol)) return;

      const startX = e.clientX;
      const startY = e.clientY;
      let isDragging = false;
      let dropTargetCol: number | null = null;
      let dropSide: 'left' | 'right' = 'right';

      const clearIndicators = () => {
        const host = hostRef.current;
        if (!host) return;
        for (const el of Array.from(host.querySelectorAll('[data-sat-drop-side], [data-sat-dragging]'))) {
          el.removeAttribute('data-sat-drop-side');
          el.removeAttribute('data-sat-dragging');
        }
      };

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!isDragging) {
          if (Math.abs(dx) < 6 || Math.abs(dy) > Math.abs(dx) * 1.5) return;
          isDragging = true;
          suppressNextSortClickRef.current = true;
          th.setAttribute('data-sat-dragging', 'true');
        }

        const host = hostRef.current;
        if (!host) return;
        for (const el of Array.from(host.querySelectorAll('[data-sat-drop-side]'))) {
          el.removeAttribute('data-sat-drop-side');
        }

        const elemBelow = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const hoverTh = elemBelow?.closest('thead th[data-sat-orig-col]') as HTMLTableCellElement | null;
        if (!hoverTh || !host.contains(hoverTh)) {
          dropTargetCol = null;
          return;
        }
        const candCol = Number(hoverTh.getAttribute('data-sat-orig-col'));
        if (Number.isNaN(candCol) || candCol === sourceCol) {
          dropTargetCol = null;
          return;
        }

        const rect = hoverTh.getBoundingClientRect();
        dropSide = ev.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
        dropTargetCol = candCol;
        hoverTh.setAttribute('data-sat-drop-side', dropSide);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);

        if (isDragging) {
          clearIndicators();
          if (dropTargetCol !== null && dropTargetCol !== sourceCol) {
            const nextOrder = colOrder.filter((c) => c !== sourceCol);
            const targetIdx = nextOrder.indexOf(dropTargetCol);
            if (targetIdx !== -1) {
              const insertAt = dropSide === 'left' ? targetIdx : targetIdx + 1;
              nextOrder.splice(insertAt, 0, sourceCol);
              onColOrderChange(nextOrder);
            }
          }
          window.setTimeout(() => {
            suppressNextSortClickRef.current = false;
          }, 50);
        }
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    },
    [meta.canReorderColumns, colOrder, onColOrderChange, onColWidthChange]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const resizeHandle = target.closest('.sat-col-resize-handle') as HTMLElement | null;
      if (!resizeHandle) return;
      e.preventDefault();
      e.stopPropagation();
      const origCol = Number(resizeHandle.getAttribute('data-sat-resize-col'));
      if (Number.isNaN(origCol)) return;
      onColWidthChange(origCol, null);
    },
    [onColWidthChange]
  );

  const handleTableClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressNextSortClickRef.current) {
      suppressNextSortClickRef.current = false;
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('.sat-col-resize-handle')) return;
    if (!meta.canSort) return;
    const sel = window.getSelection()?.toString();
    if (sel) return;
    const th = target.closest('thead [data-sat-sortable-col]') as HTMLElement | null;
    if (!th) return;
    const col = Number(th.getAttribute('data-sat-sortable-col'));
    if (Number.isNaN(col)) return;
    if (!sortState || sortState.col !== col) {
      onSortChange({ col, dir: 'asc' });
    } else if (sortState.dir === 'asc') {
      onSortChange({ col, dir: 'desc' });
    } else {
      onSortChange(null);
    }
  };

  const maxH = isFullscreen
    ? modalExpanded
      ? 'calc(90vh - 44px)'
      : 'calc(84vh - 44px)'
    : settings.height === 'full'
      ? 'none'
      : outputLimited
        ? '210px'
        : '400px';

  const maxColW =
    settings.max_col_width > 0
      ? `${settings.max_col_width}px`
      : settings.wrap === 'wrap'
        ? '340px'
        : 'none';

  return (
    <div
      ref={viewportRef}
      className={`sat-table-viewport relative min-w-0 ${isFullscreen ? 'flex-1 min-h-0 flex flex-col' : ''} ${
        scrollState.left ? 'is-scrolled-x' : ''
      }`}
      data-wrap={settings.wrap}
      data-density={settings.density}
      data-align={settings.align}
      data-sticky={String(settings.sticky_headers)}
      data-highlight={String(settings.highlight_types)}
      data-grid={String(settings.show_grid)}
      style={{
        ['--sat-table-font-size' as any]: `${settings.font_size}px`,
        ['--sat-table-max-col-w' as any]: maxColW,
      }}
    >
      <div
        ref={scrollRef}
        onScroll={measureScroll}
        className={`sat-table-scroll overflow-auto ${isFullscreen ? 'flex-1 min-h-0' : ''}`}
        style={{ maxHeight: maxH }}
      >
        <div
          ref={hostRef}
          onPointerDown={handlePointerDown}
          onDoubleClick={handleDoubleClick}
          onClick={handleTableClick}
          className="sat-table-host min-w-full"
        />
      </div>

      {scrollState.right && (
        <div
          aria-hidden="true"
          className="sat-table-fade-right pointer-events-none absolute top-0 right-0 bottom-0 w-6"
        />
      )}
    </div>
  );
});

const TableViewport: React.FC<TableViewportProps> = React.memo((props) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hoveredTdRef = useRef<HTMLTableCellElement | null>(null);
  const [hoverBtn, setHoverBtn] = useState<{
    top: number;
    left: number;
    colIndex: number;
    colLabel: string;
    rowLabel: string;
    text: string;
    isPandasCut: boolean;
    isExpandedInline: boolean;
  } | null>(null);

  const inspectTd = useCallback(
    (td: HTMLTableCellElement) => {
      const txt = (td.textContent || '').trim();
      if (!txt) return null;
      const colAttr = td.getAttribute('data-sat-orig-col');
      const colIndex = colAttr !== null ? Number(colAttr) : td.cellIndex;
      const colInfo = props.meta.columns.find((c) => c.index === colIndex);
      const colLabel = colInfo?.label || `Coluna ${colIndex + 1}`;
      const tr = td.parentElement as HTMLTableRowElement | null;
      const rowTh = tr?.querySelector('th');
      const rowLabel = (rowTh?.textContent || '').trim();
      const isPandasCut =
        !isEllipsisToken(txt) && (txt.endsWith('...') || txt.endsWith('…'));
      return {
        colIndex,
        colLabel,
        rowLabel,
        text: txt,
        isPandasCut,
      };
    },
    [props.meta.columns]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-sat-cell-expand-trigger="true"]')) return;
      const td = target.closest('tbody td') as HTMLTableCellElement | null;
      if (!td || td.parentElement?.getAttribute('data-sat-spacer') === 'true') {
        if (hoverBtn) setHoverBtn(null);
        hoveredTdRef.current = null;
        return;
      }
      const txt = (td.textContent || '').trim();
      if (!txt || isEllipsisToken(txt)) {
        if (hoverBtn) setHoverBtn(null);
        hoveredTdRef.current = null;
        return;
      }
      const isPandasCut = txt.endsWith('...') || txt.endsWith('…');
      const isOverflowing =
        td.scrollWidth > td.clientWidth + 1 || td.scrollHeight > td.clientHeight + 1;
      const isLongText = txt.length > 36 || txt.includes('\n');
      const isExpandedInline = td.hasAttribute('data-sat-cell-expanded');

      if (!isOverflowing && !isPandasCut && !isLongText && !isExpandedInline) {
        if (hoverBtn) setHoverBtn(null);
        hoveredTdRef.current = null;
        return;
      }

      const wrapEl = wrapRef.current;
      if (!wrapEl) return;
      const wrapRect = wrapEl.getBoundingClientRect();
      const tdRect = td.getBoundingClientRect();
      const top = Math.max(2, Math.round(tdRect.top - wrapRect.top + 2));
      const left = Math.max(
        4,
        Math.min(wrapRect.width - 68, Math.round(tdRect.right - wrapRect.left - 64))
      );

      hoveredTdRef.current = td;
      const info = inspectTd(td);
      if (!info) return;
      setHoverBtn({
        top,
        left,
        ...info,
        isExpandedInline,
      });
    },
    [hoverBtn, inspectTd]
  );

  const handleMouseLeave = useCallback(() => {
    setHoverBtn(null);
    hoveredTdRef.current = null;
  }, []);

  const handleDoubleClickCapture = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest('.sat-col-resize-handle')) return;
      const td = target.closest('tbody td') as HTMLTableCellElement | null;
      if (!td || td.parentElement?.getAttribute('data-sat-spacer') === 'true') return;
      const info = inspectTd(td);
      if (!info || !info.text) return;
      td.toggleAttribute('data-sat-cell-expanded');
      props.onInspectCell?.(info);
    },
    [inspectTd, props.onInspectCell]
  );

  const handleTriggerExpand = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!hoverBtn) return;
      const td = hoveredTdRef.current;
      if (td) {
        td.toggleAttribute('data-sat-cell-expanded');
        setHoverBtn((prev) =>
          prev ? { ...prev, isExpandedInline: td.hasAttribute('data-sat-cell-expanded') } : null
        );
      }
      props.onInspectCell?.({
        colIndex: hoverBtn.colIndex,
        colLabel: hoverBtn.colLabel,
        rowLabel: hoverBtn.rowLabel,
        text: hoverBtn.text,
        isPandasCut: hoverBtn.isPandasCut,
      });
    },
    [hoverBtn, props.onInspectCell]
  );

  return (
    <div
      ref={wrapRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onDoubleClickCapture={handleDoubleClickCapture}
      className={`relative min-w-0 ${props.isFullscreen ? 'flex-1 min-h-0 flex flex-col' : ''}`}
    >
      {props.virtualData && props.activeVirtualRows ? (
        <VirtualTableViewport
          virtualData={props.virtualData}
          rows={props.activeVirtualRows}
          preservedStylesHtml={props.preservedStylesHtml}
          meta={props.meta}
          settings={props.settings}
          sortState={props.sortState}
          onSortChange={props.onSortChange}
          colOrder={props.colOrder}
          onColOrderChange={props.onColOrderChange}
          colWidths={props.colWidths}
          onColWidthChange={props.onColWidthChange}
          hiddenCols={props.hiddenCols}
          onVerticalOverflowChange={props.onVerticalOverflowChange}
          tableRefOut={props.tableRefOut}
          viewportRefOut={props.viewportRefOut}
          scrollRefOut={props.scrollRefOut}
          isFullscreen={props.isFullscreen}
          modalExpanded={props.modalExpanded}
          outputLimited={props.outputLimited}
        />
      ) : (
        <DomTableViewport {...props} />
      )}

      {hoverBtn && (
        <button
          type="button"
          data-sat-cell-expand-trigger="true"
          onClick={handleTriggerExpand}
          style={{
            top: `${hoverBtn.top}px`,
            left: `${hoverBtn.left}px`,
            backgroundColor: 'var(--sat-bg-surface)',
            borderColor: 'var(--sat-border-strong)',
            color: 'var(--sat-text-primary)',
          }}
          title="Expandir campo para ver descrição inteira (ou duplo-clique na célula)"
          aria-label="Expandir campo"
          className="absolute z-30 h-5 px-1.5 rounded-[3px] border shadow-md text-[10px] font-medium inline-flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] cursor-pointer transition-colors"
        >
          <Maximize2 size={9.5} style={{ color: 'var(--sat-accent)' }} />
          <span>Expandir</span>
        </button>
      )}
    </div>
  );
});

interface ExportPopoverProps {
  anchorEl: HTMLElement;
  meta: TableMeta;
  visibleCount: number;
  viewportRowCount: number;
  hasFilter: boolean;
  verticalOverflow: boolean;
  scope: ExportScope;
  onScopeChange: (scope: ExportScope) => void;
  onExportPng: (scope: ExportScope) => void;
  onCopyPng: (scope: ExportScope) => void;
  onExportCsv: (scope: ExportScope) => void;
  onExportXlsx: (scope: ExportScope) => void;
  exportStatus: string | null;
  onClose: () => void;
}

const TableExportPopover: React.FC<ExportPopoverProps> = ({
  anchorEl,
  meta,
  visibleCount,
  viewportRowCount,
  hasFilter,
  verticalOverflow,
  scope,
  onScopeChange,
  onExportPng,
  onCopyPng,
  onExportCsv,
  onExportXlsx,
  exportStatus,
  onClose,
}) => {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const updatePos = () => {
      const rect = anchorEl.getBoundingClientRect();
      const popW = 280;
      const popH = popRef.current?.offsetHeight || 290;
      let left = rect.right - popW;
      left = Math.max(8, Math.min(window.innerWidth - popW - 8, left));
      let top = rect.bottom + 6;
      if (top + popH > window.innerHeight - 8) {
        top = Math.max(8, rect.top - popH - 6);
      }
      setPos({ top, left });
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    return () => window.removeEventListener('resize', updatePos);
  }, [anchorEl]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || anchorEl.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [anchorEl, onClose]);

  const displayedHint = hasFilter
    ? `${visibleCount.toLocaleString('pt-BR')} de ${meta.visibleRows.toLocaleString('pt-BR')} linhas filtradas`
    : verticalOverflow
      ? `Recorte visível (${viewportRowCount.toLocaleString('pt-BR')} de ${meta.visibleRows.toLocaleString('pt-BR')} linhas)`
      : `Exibição atual (${visibleCount.toLocaleString('pt-BR')} linhas)`;

  const fullHint = `Todas as ${meta.visibleRows.toLocaleString('pt-BR')} linhas × ${meta.dataCols.toLocaleString('pt-BR')} colunas`;

  return createPortal(
    <div
      ref={popRef}
      data-modal-root="true"
      data-table-export-popover="true"
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[125] w-[280px] rounded-[4px] border shadow-2xl p-3 space-y-2.5 text-xs select-none"
      style={{
        top: pos.top,
        left: pos.left,
        backgroundColor: 'var(--sat-bg-surface)',
        borderColor: 'var(--sat-border)',
        color: 'var(--sat-text-primary)',
      }}
    >
      <div className="flex items-center justify-between pb-1.5 border-b" style={{ borderColor: 'var(--sat-border)' }}>
        <span className="font-semibold text-[11.5px]">Exportar / Baixar Tabela</span>
      </div>

      <div className="space-y-1.5">
        <div className="text-[11px]" style={{ color: 'var(--sat-text-muted)' }}>
          O que exportar
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={() => onScopeChange('displayed')}
            className="h-6.5 px-2 rounded-[3px] border text-[11px] font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor: scope === 'displayed' ? 'var(--sat-btn-primary-bg)' : 'var(--sat-bg-subtle)',
              color: scope === 'displayed' ? 'var(--sat-btn-primary-text)' : 'var(--sat-text-secondary)',
              borderColor: scope === 'displayed' ? 'var(--sat-btn-primary-bg)' : 'var(--sat-border)',
            }}
          >
            Apenas exibido
          </button>
          <button
            type="button"
            onClick={() => onScopeChange('full')}
            className="h-6.5 px-2 rounded-[3px] border text-[11px] font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor: scope === 'full' ? 'var(--sat-btn-primary-bg)' : 'var(--sat-bg-subtle)',
              color: scope === 'full' ? 'var(--sat-btn-primary-text)' : 'var(--sat-text-secondary)',
              borderColor: scope === 'full' ? 'var(--sat-btn-primary-bg)' : 'var(--sat-border)',
            }}
          >
            Tabela toda
          </button>
        </div>
        <div
          className="text-[10.5px] px-2 py-1 rounded-[3px]"
          style={{
            backgroundColor: 'var(--sat-bg-subtle)',
            color: 'var(--sat-text-muted)',
          }}
        >
          {scope === 'displayed' ? displayedHint : fullHint}
        </div>
      </div>

      <div className="space-y-1.5 pt-1 border-t" style={{ borderColor: 'var(--sat-border)' }}>
        <div className="text-[11px]" style={{ color: 'var(--sat-text-muted)' }}>
          Baixar arquivo
        </div>
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => onExportPng(scope)}
            className="w-full h-7.5 px-2.5 rounded-[3px] border text-[11.5px] font-medium flex items-center justify-between hover:bg-[var(--sat-bg-hover)] cursor-pointer transition-colors"
            style={{
              backgroundColor: 'var(--sat-bg-subtle)',
              borderColor: 'var(--sat-border)',
              color: exportStatus === 'png' ? 'var(--sat-green)' : 'var(--sat-text-primary)',
            }}
          >
            <span className="inline-flex items-center gap-2">
              {exportStatus === 'png' ? <Check size={13} /> : <ImageIcon size={13} style={{ color: 'var(--sat-accent)' }} />}
              <span>{exportStatus === 'png' ? 'Imagem PNG baixada' : 'Exportar Imagem (.png)'}</span>
            </span>
            <span className="font-mono text-[10px]" style={{ color: 'var(--sat-text-muted)' }}>
              PNG 2x
            </span>
          </button>

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => onExportXlsx(scope)}
              className="h-7.5 px-2.5 rounded-[3px] border text-[11.5px] font-medium flex items-center justify-center gap-1.5 hover:bg-[var(--sat-bg-hover)] cursor-pointer transition-colors"
              style={{
                backgroundColor: 'var(--sat-bg-subtle)',
                borderColor: 'var(--sat-border)',
                color: exportStatus === 'xlsx' ? 'var(--sat-green)' : 'var(--sat-text-primary)',
              }}
            >
              {exportStatus === 'xlsx' ? (
                <Check size={12.5} />
              ) : (
                <FileSpreadsheet size={12.5} style={{ color: 'var(--sat-green)' }} />
              )}
              <span>{exportStatus === 'xlsx' ? 'Baixado' : 'Excel (.xlsx)'}</span>
            </button>

            <button
              type="button"
              onClick={() => onExportCsv(scope)}
              className="h-7.5 px-2.5 rounded-[3px] border text-[11.5px] font-medium flex items-center justify-center gap-1.5 hover:bg-[var(--sat-bg-hover)] cursor-pointer transition-colors"
              style={{
                backgroundColor: 'var(--sat-bg-subtle)',
                borderColor: 'var(--sat-border)',
                color: exportStatus === 'csv' ? 'var(--sat-green)' : 'var(--sat-text-primary)',
              }}
            >
              {exportStatus === 'csv' ? (
                <Check size={12.5} />
              ) : (
                <FileText size={12.5} style={{ color: 'var(--sat-text-secondary)' }} />
              )}
              <span>{exportStatus === 'csv' ? 'Baixado' : 'CSV (.csv)'}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="pt-1 border-t" style={{ borderColor: 'var(--sat-border)' }}>
        <button
          type="button"
          onClick={() => onCopyPng(scope)}
          className="w-full h-7 px-2.5 rounded-[3px] border text-[11px] flex items-center justify-center gap-1.5 hover:bg-[var(--sat-bg-hover)] cursor-pointer transition-colors"
          style={{
            backgroundColor: 'var(--sat-bg-subtle)',
            borderColor: 'var(--sat-border)',
            color: exportStatus === 'copy-png' ? 'var(--sat-green)' : 'var(--sat-text-secondary)',
          }}
        >
          {exportStatus === 'copy-png' ? <Check size={12} /> : <Copy size={12} />}
          <span>{exportStatus === 'copy-png' ? 'Imagem copiada!' : 'Copiar imagem para área de transferência'}</span>
        </button>
      </div>
    </div>,
    document.body
  );
};

interface ConfigPopoverProps {
  anchorEl: HTMLElement;
  meta: TableMeta;
  settings: TableOutputSettings;
  hasLocalOverride: boolean;
  colOrder: number[];
  colWidths: Record<number, number>;
  hiddenCols: number[];
  hasCustomColumns: boolean;
  onMoveColumn: (col: number, dir: -1 | 1) => void;
  onToggleColumnHidden: (col: number) => void;
  onResetColumns: () => void;
  onUpdate: (patch: Partial<TableOutputSettings>) => void;
  onResetOverride: () => void;
  onSaveAsDefault: () => void;
  onCopy: (format: 'tsv' | 'csv' | 'markdown') => void;
  copiedFormat: string | null;
  savedDefaultToast: boolean;
  onClose: () => void;
}

const TableConfigPopover: React.FC<ConfigPopoverProps> = ({
  anchorEl,
  meta,
  settings,
  hasLocalOverride,
  colOrder,
  colWidths,
  hiddenCols,
  hasCustomColumns,
  onMoveColumn,
  onToggleColumnHidden,
  onResetColumns,
  onUpdate,
  onResetOverride,
  onSaveAsDefault,
  onCopy,
  copiedFormat,
  savedDefaultToast,
  onClose,
}) => {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [showColList, setShowColList] = useState(false);

  useLayoutEffect(() => {
    const updatePos = () => {
      const rect = anchorEl.getBoundingClientRect();
      const popW = 296;
      const popH = popRef.current?.offsetHeight || 420;
      let left = rect.right - popW;
      left = Math.max(8, Math.min(window.innerWidth - popW - 8, left));
      let top = rect.bottom + 6;
      if (top + popH > window.innerHeight - 8) {
        top = Math.max(8, rect.top - popH - 6);
      }
      setPos({ top, left });
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    return () => window.removeEventListener('resize', updatePos);
  }, [anchorEl, showColList]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || anchorEl.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [anchorEl, onClose]);

  const pillBtn = (active: boolean, label: string, onClick: () => void) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      className="flex-1 h-6 px-2 rounded-[3px] border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap"
      style={{
        backgroundColor: active ? 'var(--sat-btn-primary-bg)' : 'var(--sat-bg-subtle)',
        color: active ? 'var(--sat-btn-primary-text)' : 'var(--sat-text-secondary)',
        borderColor: active ? 'var(--sat-btn-primary-bg)' : 'var(--sat-border)',
      }}
    >
      {label}
    </button>
  );

  const colMap = useMemo(() => {
    const m = new Map<number, { label: string; isIndex: boolean }>();
    for (const c of meta.columns) {
      m.set(c.index, { label: c.label, isIndex: c.isIndex });
    }
    return m;
  }, [meta.columns]);

  return createPortal(
    <div
      ref={popRef}
      data-modal-root="true"
      data-table-popover="true"
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[120] w-[296px] max-h-[calc(100vh-16px)] overflow-y-auto rounded-[4px] border shadow-2xl p-3 space-y-2.5 text-xs select-none"
      style={{
        top: pos.top,
        left: pos.left,
        backgroundColor: 'var(--sat-bg-surface)',
        borderColor: 'var(--sat-border)',
        color: 'var(--sat-text-primary)',
      }}
    >
      <div className="flex items-center justify-between pb-1.5 border-b" style={{ borderColor: 'var(--sat-border)' }}>
        <span className="font-semibold text-[11.5px]">Visualização da Tabela</span>
        {(hasLocalOverride || hasCustomColumns) && (
          <button
            type="button"
            onClick={() => {
              onResetOverride();
              onResetColumns();
            }}
            className="text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] hover:bg-[var(--sat-bg-hover)] cursor-pointer"
            style={{ color: 'var(--sat-text-muted)' }}
            title="Voltar para o padrão global e restaurar colunas"
          >
            <RotateCcw size={11} />
            <span>Padrão</span>
          </button>
        )}
      </div>

      <div className="space-y-1">
        <div className="text-[11px]" style={{ color: 'var(--sat-text-muted)' }}>Quebra de texto</div>
        <div className="flex gap-1">
          {pillBtn(settings.wrap === 'nowrap', 'Linha única', () => onUpdate({ wrap: 'nowrap' }))}
          {pillBtn(settings.wrap === 'wrap', 'Quebrar texto', () => onUpdate({ wrap: 'wrap' }))}
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-[11px]" style={{ color: 'var(--sat-text-muted)' }}>Densidade</div>
        <div className="flex gap-1">
          {pillBtn(settings.density === 'compact', 'Compacta', () => onUpdate({ density: 'compact' }))}
          {pillBtn(settings.density === 'normal', 'Padrão', () => onUpdate({ density: 'normal' }))}
          {pillBtn(settings.density === 'comfortable', 'Confortável', () => onUpdate({ density: 'comfortable' }))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <div className="text-[11px]" style={{ color: 'var(--sat-text-muted)' }}>Fonte</div>
          <div className="flex gap-1">
            {[12, 13, 14].map((sz) =>
              pillBtn(settings.font_size === sz, `${sz}`, () => onUpdate({ font_size: sz }))
            )}
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-[11px]" style={{ color: 'var(--sat-text-muted)' }}>Alinhamento</div>
          <div className="flex gap-1">
            {pillBtn(settings.align === 'auto', 'Auto', () => onUpdate({ align: 'auto' }))}
            {pillBtn(settings.align === 'left', 'Esq', () => onUpdate({ align: 'left' }))}
            {pillBtn(settings.align === 'right', 'Dir', () => onUpdate({ align: 'right' }))}
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-[11px]" style={{ color: 'var(--sat-text-muted)' }}>Largura máx. da coluna</div>
        <div className="flex gap-1">
          {[
            { val: 180, label: '180px' },
            { val: 280, label: '280px' },
            { val: 420, label: '420px' },
            { val: 0, label: 'Livre' },
          ].map((opt) =>
            pillBtn(settings.max_col_width === opt.val, opt.label, () =>
              onUpdate({ max_col_width: opt.val })
            )
          )}
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-[11px]" style={{ color: 'var(--sat-text-muted)' }}>Altura do bloco</div>
        <div className="flex gap-1">
          {pillBtn(settings.height === 'limited', 'Limitada (400px)', () => onUpdate({ height: 'limited' }))}
          {pillBtn(settings.height === 'full', 'Completa', () => onUpdate({ height: 'full' }))}
        </div>
      </div>

      {meta.columns.length > 0 && (
        <div className="space-y-1.5 pt-1.5 border-t" style={{ borderColor: 'var(--sat-border)' }}>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShowColList((v) => !v)}
              className="inline-flex items-center gap-1.5 text-[11.5px] font-medium hover: opacity-90 cursor-pointer"
              style={{ color: 'var(--sat-text-primary)' }}
            >
              <Columns3 size={12} style={{ color: 'var(--sat-accent)' }} />
              <span>Colunas (mover / largura)</span>
              <span className="text-[10px]" style={{ color: 'var(--sat-text-muted)' }}>
                {showColList ? '▲' : '▼'}
              </span>
            </button>
            {hasCustomColumns && (
              <button
                type="button"
                onClick={onResetColumns}
                className="text-[10.5px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] hover:bg-[var(--sat-bg-hover)] cursor-pointer"
                style={{ color: 'var(--sat-accent)' }}
                title="Restaurar ordem e largura original das colunas"
              >
                <RotateCcw size={10} />
                <span>Restaurar</span>
              </button>
            )}
          </div>
          <div className="text-[10.5px]" style={{ color: 'var(--sat-text-muted)' }}>
            Dica: arraste o cabeçalho para mover colunas ou a borda direita para ajustar a largura.
          </div>

          {showColList && (
            <div
              className="max-h-36 overflow-y-auto rounded-[3px] border p-1 space-y-0.5"
              style={{
                backgroundColor: 'var(--sat-bg-subtle)',
                borderColor: 'var(--sat-border)',
              }}
            >
              {colOrder.map((colIdx, posIdx) => {
                const info = colMap.get(colIdx);
                if (!info) return null;
                const isHidden = hiddenCols.includes(colIdx);
                const customW = colWidths[colIdx];
                return (
                  <div
                    key={colIdx}
                    className="flex items-center justify-between gap-1 px-1.5 py-1 rounded-[2px] hover:bg-[var(--sat-bg-hover)]"
                  >
                    <label className="flex items-center gap-1.5 min-w-0 flex-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!isHidden}
                        onChange={() => onToggleColumnHidden(colIdx)}
                        className="cursor-pointer shrink-0"
                      />
                      <span
                        className={`truncate text-[11px] ${isHidden ? 'line-through opacity-50' : ''}`}
                        title={info.label}
                      >
                        {info.label}
                      </span>
                      {customW ? (
                        <span className="font-mono text-[9.5px] shrink-0" style={{ color: 'var(--sat-accent)' }}>
                          {customW}px
                        </span>
                      ) : null}
                    </label>
                    {meta.canReorderColumns && (
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          disabled={posIdx === 0}
                          onClick={() => onMoveColumn(colIdx, -1)}
                          className="p-0.5 rounded-[2px] hover:bg-[var(--sat-bg-surface)] disabled:opacity-30 cursor-pointer"
                          title="Mover coluna para esquerda"
                        >
                          <ArrowUp size={11} />
                        </button>
                        <button
                          type="button"
                          disabled={posIdx === colOrder.length - 1}
                          onClick={() => onMoveColumn(colIdx, 1)}
                          className="p-0.5 rounded-[2px] hover:bg-[var(--sat-bg-surface)] disabled:opacity-30 cursor-pointer"
                          title="Mover coluna para direita"
                        >
                          <ArrowDown size={11} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="space-y-1.5 pt-1 border-t" style={{ borderColor: 'var(--sat-border)' }}>
        <label className="flex items-center justify-between gap-2 cursor-pointer text-[11.5px]">
          <span>Fixar cabeçalho e índice</span>
          <input
            type="checkbox"
            checked={settings.sticky_headers}
            onChange={(e) => onUpdate({ sticky_headers: e.target.checked })}
            className="cursor-pointer"
          />
        </label>
        <label className="flex items-center justify-between gap-2 cursor-pointer text-[11.5px]">
          <span>Destacar nulos e números</span>
          <input
            type="checkbox"
            checked={settings.highlight_types}
            onChange={(e) => onUpdate({ highlight_types: e.target.checked })}
            className="cursor-pointer"
          />
        </label>
        <label className="flex items-center justify-between gap-2 cursor-pointer text-[11.5px]">
          <span>Divisórias entre colunas</span>
          <input
            type="checkbox"
            checked={settings.show_grid}
            onChange={(e) => onUpdate({ show_grid: e.target.checked })}
            className="cursor-pointer"
          />
        </label>
      </div>

      <div className="space-y-1 pt-1.5 border-t" style={{ borderColor: 'var(--sat-border)' }}>
        <div className="text-[11px]" style={{ color: 'var(--sat-text-muted)' }}>Copiar dados</div>
        <div className="flex gap-1">
          {(
            [
              { fmt: 'tsv', label: 'TSV (Excel)' },
              { fmt: 'csv', label: 'CSV' },
              { fmt: 'markdown', label: 'Markdown' },
            ] as const
          ).map(({ fmt, label }) => {
            const done = copiedFormat === fmt;
            return (
              <button
                key={fmt}
                type="button"
                onClick={() => onCopy(fmt)}
                className="flex-1 h-6 px-1.5 rounded-[3px] border text-[11px] flex items-center justify-center gap-1 hover:bg-[var(--sat-bg-hover)] cursor-pointer transition-colors"
                style={{
                  backgroundColor: 'var(--sat-bg-subtle)',
                  borderColor: 'var(--sat-border)',
                  color: done ? 'var(--sat-green)' : 'var(--sat-text-secondary)',
                }}
              >
                {done && <Check size={11} />}
                <span>{done ? 'Copiado' : label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="pt-1.5 border-t" style={{ borderColor: 'var(--sat-border)' }}>
        <button
          type="button"
          onClick={onSaveAsDefault}
          className="w-full h-7 px-2.5 rounded-[3px] border text-[11.5px] font-medium flex items-center justify-center gap-1.5 hover:opacity-90 cursor-pointer transition-opacity"
          style={{
            backgroundColor: savedDefaultToast ? 'var(--sat-green)' : 'var(--sat-bg-subtle)',
            borderColor: savedDefaultToast ? 'var(--sat-green)' : 'var(--sat-border)',
            color: savedDefaultToast ? '#fff' : 'var(--sat-text-primary)',
          }}
        >
          {savedDefaultToast ? <Check size={12} /> : null}
          <span>{savedDefaultToast ? 'Padrão global salvo' : 'Aplicar como padrão global'}</span>
        </button>
      </div>
    </div>,
    document.body
  );
};

interface InteractiveTableCardProps {
  tableHtml: string;
  virtualData?: VirtualTableData;
  meta: TableMeta;
  preservedStylesHtml?: string;
  outputLimited?: boolean;
  onExpandTruncated?: () => void;
  isExpandingTruncated?: boolean;
  isExpandedTruncated?: boolean;
}

const InteractiveTableCard: React.FC<InteractiveTableCardProps> = React.memo(({
  tableHtml,
  virtualData,
  meta,
  preservedStylesHtml = '',
  outputLimited = false,
  onExpandTruncated,
  isExpandingTruncated = false,
  isExpandedTruncated = false,
}) => {
  const { globalSettings, setGlobalSettings } = useSaturnoStore(
    useShallow((s) => ({
      globalSettings: s.tableOutputSettings,
      setGlobalSettings: s.setTableOutputSettings,
    }))
  );

  const defaultColOrder = useMemo(
    () => Array.from({ length: meta.totalCols }, (_, i) => i),
    [meta.totalCols]
  );

  const [localOverride, setLocalOverride] = useState<Partial<TableOutputSettings> | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(meta.visibleRows);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [colOrder, setColOrder] = useState<number[]>(defaultColOrder);
  const [colWidths, setColWidths] = useState<Record<number, number>>({});
  const [hiddenCols, setHiddenCols] = useState<number[]>([]);
  const [verticalOverflow, setVerticalOverflow] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<ExportScope>('full');
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [modalExpanded, setModalExpanded] = useState(false);
  const [modalCustomSize, setModalCustomSize] = useState<{ width: number; height: number } | null>(null);
  const [copiedFormat, setCopiedFormat] = useState<string | null>(null);
  const [savedDefaultToast, setSavedDefaultToast] = useState(false);
  const [inspectedCell, setInspectedCell] = useState<InspectedCellData | null>(null);
  const [copiedCellText, setCopiedCellText] = useState(false);

  useEffect(() => {
    if (!inspectedCell) return;
    if (virtualData) {
      const matchRow = virtualData.rows.find((r) => r.cells[0] === inspectedCell.rowLabel);
      const nextTxt = matchRow?.cells[inspectedCell.colIndex];
      if (nextTxt && nextTxt !== inspectedCell.text) {
        setInspectedCell((prev) =>
          prev ? { ...prev, text: nextTxt, isPandasCut: false } : null
        );
      }
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      const tbl = tableRef.current;
      if (!tbl || !tbl.tBodies[0]) return;
      for (const tr of Array.from(tbl.tBodies[0].rows)) {
        const rLabel = (tr.querySelector('th')?.textContent || '').trim();
        if (rLabel === inspectedCell.rowLabel) {
          const td = tr.querySelector(
            `td[data-sat-orig-col="${inspectedCell.colIndex}"]`
          ) as HTMLTableCellElement | null;
          const nextTxt = (td?.textContent || '').trim();
          if (nextTxt && nextTxt !== inspectedCell.text) {
            setInspectedCell((prev) =>
              prev ? { ...prev, text: nextTxt, isPandasCut: false } : null
            );
          }
          break;
        }
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [tableHtml, virtualData, inspectedCell]);

  const hasTruncatedFields = useMemo(() => {
    if (meta.isTruncated) return true;
    if (virtualData) {
      return virtualData.rows.some((r) =>
        r.cells.some((c) => c.length > 42 || c.endsWith('...') || c.endsWith('…'))
      );
    }
    return /(\.\.\.|…)\s*<\/td>/i.test(tableHtml) || /<td[^>]*>[^<]{42,}<\/td>/i.test(tableHtml);
  }, [meta.isTruncated, virtualData, tableHtml]);

  const tableRef = useRef<HTMLTableElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const fullscreenTableRef = useRef<HTMLTableElement | null>(null);
  const fullscreenViewportRef = useRef<HTMLDivElement | null>(null);
  const fullscreenScrollRef = useRef<HTMLDivElement | null>(null);
  const modalBoxRef = useRef<HTMLDivElement | null>(null);

  const configBtnRef = useRef<HTMLButtonElement>(null);
  const fullscreenConfigBtnRef = useRef<HTMLButtonElement>(null);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const fullscreenExportBtnRef = useRef<HTMLButtonElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const effectiveSettings = useMemo<TableOutputSettings>(
    () => (localOverride ? { ...globalSettings, ...localOverride } : globalSettings),
    [globalSettings, localOverride]
  );

  // Reset per-table transient filter/sort/columns when underlying table HTML changes
  useEffect(() => {
    setSortState(null);
    setFilterQuery('');
    setFilterOpen(false);
    setVisibleCount(meta.visibleRows);
    setColOrder(Array.from({ length: meta.totalCols }, (_, i) => i));
    setColWidths({});
    setHiddenCols([]);
  }, [tableHtml, virtualData, meta.visibleRows, meta.totalCols]);

  // Fast in-memory filter + O(N log N) pre-decorated sort for virtualized tables
  const activeVirtualRows = useMemo<VirtualTableRow[] | undefined>(() => {
    if (!virtualData) return undefined;
    const needle = filterQuery.trim().toLowerCase();
    let base: VirtualTableRow[];

    if (!needle) {
      base = virtualData.rows;
    } else {
      base = [];
      for (let i = 0; i < virtualData.rows.length; i++) {
        const r = virtualData.rows[i];
        if (r.isEllipsis) continue;
        if (r._searchCache === undefined) {
          r._searchCache = r.cells.join('\x1f').toLowerCase();
        }
        if (r._searchCache.includes(needle)) {
          base.push(r);
        }
      }
    }

    if (!sortState || !meta.canSort || base.length <= 1) {
      return base;
    }

    const col = sortState.col;
    const isNumCol = virtualData.colTypes[col] === 'number';
    const decorated = base.map((row, idx) => ({
      row,
      idx,
      key: decorateSortValue(row.cells[col] ?? '', isNumCol),
    }));

    decorated.sort((a, b) => {
      if (a.key.missing && b.key.missing) return a.idx - b.idx;
      if (a.key.missing) return 1;
      if (b.key.missing) return -1;
      let cmp = 0;
      if (!Number.isNaN(a.key.num) && !Number.isNaN(b.key.num)) {
        cmp = a.key.num - b.key.num;
      } else {
        cmp = a.key.str.localeCompare(b.key.str, 'pt-BR', { numeric: true, sensitivity: 'base' });
      }
      if (cmp === 0) return a.idx - b.idx;
      return sortState.dir === 'asc' ? cmp : -cmp;
    });

    return decorated.map((d) => d.row);
  }, [virtualData, filterQuery, sortState, meta.canSort]);

  useEffect(() => {
    if (!activeVirtualRows) return;
    let count = 0;
    for (let i = 0; i < activeVirtualRows.length; i++) {
      if (!activeVirtualRows[i].isEllipsis) count++;
    }
    setVisibleCount(count);
  }, [activeVirtualRows]);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !configOpen && !exportOpen) {
        e.preventDefault();
        e.stopPropagation();
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isFullscreen, configOpen, exportOpen]);

  const updateLocal = useCallback((patch: Partial<TableOutputSettings>) => {
    setLocalOverride((prev) => ({ ...(prev || {}), ...patch }));
  }, []);

  const handleColWidthChange = useCallback((col: number, width: number | null) => {
    setColWidths((prev) => {
      if (width === null) {
        const next = { ...prev };
        delete next[col];
        return next;
      }
      return { ...prev, [col]: width };
    });
  }, []);

  const handleMoveColumn = useCallback((col: number, dir: -1 | 1) => {
    setColOrder((prev) => {
      const idx = prev.indexOf(col);
      if (idx === -1) return prev;
      const targetIdx = idx + dir;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(targetIdx, 0, item);
      return next;
    });
  }, []);

  const handleToggleColumnHidden = useCallback(
    (col: number) => {
      setHiddenCols((prev) => {
        if (prev.includes(col)) {
          return prev.filter((c) => c !== col);
        }
        // Keep at least 1 column visible
        if (prev.length >= meta.totalCols - 1) return prev;
        return [...prev, col];
      });
    },
    [meta.totalCols]
  );

  const handleResetColumns = useCallback(() => {
    setColOrder(defaultColOrder);
    setColWidths({});
    setHiddenCols([]);
  }, [defaultColOrder]);

  const hasCustomColumns = useMemo(() => {
    const orderChanged =
      colOrder.length !== defaultColOrder.length ||
      colOrder.some((c, i) => c !== defaultColOrder[i]);
    const widthsChanged = Object.keys(colWidths).length > 0;
    const hiddenChanged = hiddenCols.length > 0;
    return orderChanged || widthsChanged || hiddenChanged;
  }, [colOrder, defaultColOrder, colWidths, hiddenCols]);

  const virtualExportSource = useMemo<VirtualExportSource | undefined>(() => {
    if (!virtualData || !activeVirtualRows) return undefined;
    return {
      headerRows: virtualData.headerTextRows,
      rows: activeVirtualRows,
      colOrder,
      hiddenCols: new Set(hiddenCols),
    };
  }, [virtualData, activeVirtualRows, colOrder, hiddenCols]);

  const virtualExportFullSource = useMemo<VirtualExportSource | undefined>(() => {
    if (!virtualData) return undefined;
    // Full scope exports all rows (ordered if sortState active, ignoring row filter)
    const baseRows =
      !filterQuery.trim() && activeVirtualRows ? activeVirtualRows : virtualData.rows;
    return {
      headerRows: virtualData.headerTextRows,
      rows: baseRows,
      colOrder,
      hiddenCols: new Set(hiddenCols),
    };
  }, [virtualData, activeVirtualRows, filterQuery, colOrder, hiddenCols]);

  const handleCopy = useCallback(async (format: 'tsv' | 'csv' | 'markdown') => {
    const tbl = (isFullscreen ? fullscreenTableRef.current : tableRef.current) || tableRef.current;
    if (!tbl) return;
    const text = extractTableDelimited(tbl, format, {
      virtualSource: virtualExportSource,
    });
    if (!text) return;
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedFormat(format);
      window.setTimeout(() => setCopiedFormat((cur) => (cur === format ? null : cur)), 1500);
    }
  }, [isFullscreen, virtualExportSource]);

  const flashExportStatus = useCallback((status: string) => {
    setExportStatus(status);
    window.setTimeout(() => {
      setExportStatus((cur) => (cur === status ? null : cur));
    }, 1600);
  }, []);

  const getActiveRefs = useCallback(() => {
    const tbl = (isFullscreen ? fullscreenTableRef.current : tableRef.current) || tableRef.current;
    const vp = (isFullscreen ? fullscreenViewportRef.current : viewportRef.current) || viewportRef.current;
    const sc = (isFullscreen ? fullscreenScrollRef.current : scrollRef.current) || scrollRef.current;
    return { tbl, vp, sc };
  }, [isFullscreen]);

  const hasFilter = filterQuery.trim().length > 0;

  const handleExportPng = useCallback(
    async (scope: ExportScope) => {
      const { tbl, vp, sc } = getActiveRefs();
      if (!tbl || !vp || !sc) return;
      const ok = await downloadTablePng(
        vp,
        sc,
        tbl,
        preservedStylesHtml,
        scope,
        scope === 'displayed' ? 'tabela-recorte.png' : 'tabela-completa.png',
        scope === 'full' ? virtualExportFullSource : virtualExportSource,
        meta.canStickyIndex,
        virtualData?.colTypes
      );
      if (ok) flashExportStatus('png');
    },
    [
      getActiveRefs,
      preservedStylesHtml,
      flashExportStatus,
      virtualExportFullSource,
      virtualExportSource,
      meta.canStickyIndex,
      virtualData?.colTypes,
    ]
  );

  const handleCopyPng = useCallback(
    async (scope: ExportScope) => {
      const { tbl, vp, sc } = getActiveRefs();
      if (!tbl || !vp || !sc) return;
      const ok = await copyTablePngToClipboard(
        vp,
        sc,
        tbl,
        preservedStylesHtml,
        scope,
        scope === 'full' ? virtualExportFullSource : virtualExportSource,
        meta.canStickyIndex,
        virtualData?.colTypes
      );
      if (ok) flashExportStatus('copy-png');
    },
    [
      getActiveRefs,
      preservedStylesHtml,
      flashExportStatus,
      virtualExportFullSource,
      virtualExportSource,
      meta.canStickyIndex,
      virtualData?.colTypes,
    ]
  );

  const handleExportCsv = useCallback(
    (scope: ExportScope) => {
      const { tbl, sc } = getActiveRefs();
      if (!tbl) return;
      downloadTableCsv(
        tbl,
        sc,
        scope,
        hasFilter,
        scope === 'displayed' ? 'tabela-exibida.csv' : 'tabela-completa.csv',
        scope === 'full' ? virtualExportFullSource : virtualExportSource
      );
      flashExportStatus('csv');
    },
    [getActiveRefs, hasFilter, flashExportStatus, virtualExportFullSource, virtualExportSource]
  );

  const handleExportXlsx = useCallback(
    (scope: ExportScope) => {
      const { tbl, sc } = getActiveRefs();
      if (!tbl) return;
      downloadTableXlsx(
        tbl,
        sc,
        scope,
        hasFilter,
        scope === 'displayed' ? 'tabela-exibida.xlsx' : 'tabela-completa.xlsx',
        scope === 'full' ? virtualExportFullSource : virtualExportSource
      );
      flashExportStatus('xlsx');
    },
    [getActiveRefs, hasFilter, flashExportStatus, virtualExportFullSource, virtualExportSource]
  );

  const handleSaveAsDefault = useCallback(() => {
    setGlobalSettings(effectiveSettings);
    setLocalOverride(null);
    setSavedDefaultToast(true);
    window.setTimeout(() => setSavedDefaultToast(false), 1500);
  }, [effectiveSettings, setGlobalSettings]);

  // Modal corner resize handler so user can freely resize the popup window
  const handleModalResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !modalBoxRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = modalBoxRef.current.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;

    const onMove = (ev: PointerEvent) => {
      const nextW = Math.max(420, Math.min(window.innerWidth - 24, Math.round(startW + (ev.clientX - startX) * 2)));
      const nextH = Math.max(240, Math.min(window.innerHeight - 24, Math.round(startH + (ev.clientY - startY) * 2)));
      setModalExpanded(false);
      setModalCustomSize({ width: nextW, height: nextH });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }, []);

  const activeConfigBtn = isFullscreen ? fullscreenConfigBtnRef.current : configBtnRef.current;
  const activeExportBtn = isFullscreen ? fullscreenExportBtnRef.current : exportBtnRef.current;

  const viewportRowCount = useMemo(() => {
    if (!exportOpen) return visibleCount;
    const { tbl, sc } = getActiveRefs();
    if (!tbl) return visibleCount;
    return getViewportVisibleRows(tbl, sc).size;
  }, [exportOpen, visibleCount, getActiveRefs]);

  const toolbarBtnClass =
    'h-5.5 min-w-[22px] px-1.5 rounded-[3px] inline-flex items-center justify-center gap-1 text-[11px] transition-colors cursor-pointer hover:bg-[var(--sat-bg-hover)]';

  return (
    <div
      className="sat-table-card w-full min-w-0 rounded-[4px] border overflow-hidden"
      style={{
        backgroundColor: 'var(--sat-cell-bg)',
        borderColor: 'var(--sat-border)',
      }}
    >
      {/* Compact Header & Corner Controls */}
      <div
        className="h-7 px-2 flex items-center justify-between gap-2 border-b select-none"
        style={{
          backgroundColor: 'var(--sat-bg-surface)',
          borderColor: 'var(--sat-border)',
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Table2 size={12} className="shrink-0" style={{ color: 'var(--sat-text-muted)' }} />
          <span
            className="font-mono text-[11px] font-medium shrink-0"
            style={{ color: 'var(--sat-text-secondary)' }}
            title={
              meta.isTruncated
                ? `Mostrando ${meta.visibleRows.toLocaleString('pt-BR')} linhas de ${meta.shapeLabel}`
                : `${meta.visibleRows.toLocaleString('pt-BR')} linhas × ${meta.dataCols} colunas`
            }
          >
            {meta.shapeLabel}
          </span>
          {meta.isTruncated && !hasFilter && (
            <span
              className="hidden sm:inline text-[10.5px] font-mono truncate"
              style={{ color: 'var(--sat-text-muted)' }}
            >
              ({meta.visibleRows.toLocaleString('pt-BR')} exibidas)
            </span>
          )}
          {hasFilter && (
            <span
              className="text-[10.5px] font-mono px-1.5 py-px rounded-[2px] shrink-0"
              style={{
                backgroundColor: 'var(--sat-accent-soft)',
                color: 'var(--sat-accent)',
              }}
            >
              {visibleCount}/{meta.visibleRows}
            </span>
          )}
          {sortState && (
            <button
              type="button"
              onClick={() => setSortState(null)}
              className="text-[10.5px] px-1.5 py-px rounded-[2px] inline-flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] cursor-pointer shrink-0"
              style={{ color: 'var(--sat-accent)' }}
              title="Limpar ordenação"
            >
              <span>{sortState.dir === 'asc' ? '▲' : '▼'}</span>
              <span className="hidden sm:inline">Ordenado</span>
              <X size={10} />
            </button>
          )}
          {hasCustomColumns && (
            <button
              type="button"
              onClick={handleResetColumns}
              className="text-[10.5px] px-1.5 py-px rounded-[2px] inline-flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] cursor-pointer shrink-0"
              style={{ color: 'var(--sat-accent)' }}
              title="Restaurar ordem e largura original das colunas"
            >
              <RotateCcw size={10} />
              <span className="hidden sm:inline">Colunas</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {!meta.hasRowSpanInBody && (
            filterOpen ? (
              <div
                className="flex items-center h-5.5 px-1.5 rounded-[3px] border gap-1 mr-0.5"
                style={{
                  backgroundColor: 'var(--sat-bg-canvas)',
                  borderColor: 'var(--sat-border-strong)',
                }}
              >
                <Search size={11} style={{ color: 'var(--sat-text-muted)' }} />
                <input
                  ref={filterInputRef}
                  autoFocus
                  type="text"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setFilterQuery('');
                      setFilterOpen(false);
                    }
                  }}
                  placeholder="Filtrar linhas..."
                  className="w-28 sm:w-36 bg-transparent text-[11px] outline-none"
                  style={{ color: 'var(--sat-text-primary)' }}
                />
                <button
                  type="button"
                  onClick={() => {
                    setFilterQuery('');
                    setFilterOpen(false);
                  }}
                  className="p-0.5 rounded-[2px] hover:bg-[var(--sat-bg-hover)] cursor-pointer"
                  style={{ color: 'var(--sat-text-muted)' }}
                  title="Limpar filtro (Esc)"
                >
                  <X size={10} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setFilterOpen(true);
                  window.setTimeout(() => filterInputRef.current?.focus(), 0);
                }}
                className={toolbarBtnClass}
                style={{ color: 'var(--sat-text-muted)' }}
                title="Filtrar linhas"
                aria-label="Filtrar linhas"
              >
                <Search size={12} />
              </button>
            )
          )}

          <button
            type="button"
            onClick={() =>
              updateLocal({
                wrap: effectiveSettings.wrap === 'nowrap' ? 'wrap' : 'nowrap',
              })
            }
            className={toolbarBtnClass}
            style={{
              backgroundColor:
                effectiveSettings.wrap === 'wrap' ? 'var(--sat-accent-soft)' : undefined,
              color:
                effectiveSettings.wrap === 'wrap'
                  ? 'var(--sat-accent)'
                  : 'var(--sat-text-muted)',
            }}
            title={
              effectiveSettings.wrap === 'nowrap'
                ? 'Quebrar texto nas células'
                : 'Manter células em linha única'
            }
            aria-label="Alternar quebra de texto na tabela"
            aria-pressed={effectiveSettings.wrap === 'wrap'}
          >
            <WrapText size={12.5} />
          </button>

          {(hasTruncatedFields || isExpandedTruncated) && (
            <button
              type="button"
              disabled={isExpandingTruncated}
              onClick={() => {
                const isAllFieldsExpanded =
                  effectiveSettings.wrap === 'wrap' && effectiveSettings.max_col_width === 0;
                if (isAllFieldsExpanded && !isExpandedTruncated) {
                  updateLocal({
                    wrap: 'nowrap',
                    max_col_width: globalSettings.max_col_width || 280,
                  });
                } else {
                  updateLocal({ wrap: 'wrap', max_col_width: 0 });
                  if (onExpandTruncated && (!isExpandedTruncated || meta.isTruncated)) {
                    onExpandTruncated();
                  }
                }
              }}
              className={toolbarBtnClass}
              style={{
                backgroundColor:
                  isExpandedTruncated ||
                  (effectiveSettings.wrap === 'wrap' && effectiveSettings.max_col_width === 0)
                    ? 'var(--sat-accent-soft)'
                    : undefined,
                color:
                  isExpandedTruncated ||
                  (effectiveSettings.wrap === 'wrap' && effectiveSettings.max_col_width === 0)
                    ? 'var(--sat-accent)'
                    : 'var(--sat-text-muted)',
              }}
              title="Expandir campos cortados com ... para ver descrições completas"
              aria-label="Expandir campos cortados"
            >
              {isExpandingTruncated ? (
                <Loader2 size={11.5} className="animate-spin" />
              ) : (
                <ChevronsLeftRight size={12.5} />
              )}
              <span className="hidden md:inline text-[10.5px]">
                {isExpandedTruncated ||
                (effectiveSettings.wrap === 'wrap' && effectiveSettings.max_col_width === 0)
                  ? 'Recolher (...)'
                  : 'Expandir (...)'}
              </span>
            </button>
          )}

          {(verticalOverflow || effectiveSettings.height === 'full') && (
            <button
              type="button"
              onClick={() =>
                updateLocal({
                  height: effectiveSettings.height === 'limited' ? 'full' : 'limited',
                })
              }
              className={toolbarBtnClass}
              style={{
                backgroundColor:
                  effectiveSettings.height === 'full' ? 'var(--sat-accent-soft)' : undefined,
                color:
                  effectiveSettings.height === 'full'
                    ? 'var(--sat-accent)'
                    : 'var(--sat-text-muted)',
              }}
              title={
                effectiveSettings.height === 'limited'
                  ? 'Expandir todas as linhas'
                  : 'Limitar altura da tabela'
              }
              aria-label="Alternar altura da tabela"
            >
              {effectiveSettings.height === 'limited' ? (
                <ChevronsUpDown size={12.5} />
              ) : (
                <ChevronsDownUp size={12.5} />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => handleCopy('tsv')}
            className={toolbarBtnClass}
            style={{
              color: copiedFormat === 'tsv' ? 'var(--sat-green)' : 'var(--sat-text-muted)',
            }}
            title="Copiar tabela (TSV para Excel/Planilhas)"
            aria-label="Copiar tabela"
          >
            {copiedFormat === 'tsv' ? <Check size={12} /> : <Copy size={12} />}
          </button>

          <button
            ref={exportBtnRef}
            type="button"
            onClick={() => {
              setConfigOpen(false);
              setExportOpen((o) => !o);
            }}
            className={toolbarBtnClass}
            style={{
              backgroundColor: exportOpen ? 'var(--sat-bg-hover)' : undefined,
              color: exportOpen ? 'var(--sat-text-primary)' : 'var(--sat-text-muted)',
            }}
            title="Exportar / Baixar tabela (PNG, Excel .xlsx, CSV)"
            aria-label="Exportar tabela"
            aria-expanded={exportOpen}
          >
            <Download size={12} />
          </button>

          <button
            type="button"
            onClick={() => setIsFullscreen(true)}
            className={toolbarBtnClass}
            style={{ color: 'var(--sat-text-muted)' }}
            title="Expandir tabela"
            aria-label="Expandir tabela"
          >
            <Maximize2 size={12} />
          </button>

          <button
            ref={configBtnRef}
            type="button"
            onClick={() => {
              setExportOpen(false);
              setConfigOpen((o) => !o);
            }}
            className={`${toolbarBtnClass} relative`}
            style={{
              backgroundColor: configOpen ? 'var(--sat-bg-hover)' : undefined,
              color:
                configOpen || localOverride || hasCustomColumns
                  ? 'var(--sat-text-primary)'
                  : 'var(--sat-text-muted)',
            }}
            title="Configurações e colunas da tabela"
            aria-label="Configurações da tabela"
            aria-expanded={configOpen}
          >
            <SlidersHorizontal size={12} />
            {(localOverride || hasCustomColumns) && (
              <span
                className="w-1.5 h-1.5 rounded-full absolute top-0.5 right-0.5"
                style={{ backgroundColor: 'var(--sat-accent)' }}
              />
            )}
          </button>
        </div>
      </div>

      {/* Scrollable Table Body */}
      <TableViewport
        tableHtml={tableHtml}
        virtualData={virtualData}
        activeVirtualRows={activeVirtualRows}
        preservedStylesHtml={preservedStylesHtml}
        meta={meta}
        settings={effectiveSettings}
        filterQuery={filterQuery}
        sortState={sortState}
        onSortChange={setSortState}
        colOrder={colOrder}
        onColOrderChange={setColOrder}
        colWidths={colWidths}
        onColWidthChange={handleColWidthChange}
        hiddenCols={hiddenCols}
        onVisibleCountChange={setVisibleCount}
        onVerticalOverflowChange={setVerticalOverflow}
        tableRefOut={tableRef}
        viewportRefOut={viewportRef}
        scrollRefOut={scrollRef}
        outputLimited={outputLimited}
        onInspectCell={(info) => {
          setInspectedCell(info);
          if (info.isPandasCut && onExpandTruncated && !isExpandedTruncated) {
            onExpandTruncated();
          }
        }}
      />

      {inspectedCell && (
        <div
          data-sat-field-inspector="true"
          className="px-3 py-2.5 border-t space-y-1.5 text-xs"
          style={{
            backgroundColor: 'var(--sat-bg-surface)',
            borderColor: 'var(--sat-border)',
            color: 'var(--sat-text-primary)',
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-semibold text-[11.5px] truncate">
                Campo: {inspectedCell.colLabel}
              </span>
              {inspectedCell.rowLabel && (
                <span
                  className="font-mono text-[10.5px] px-1.5 py-0.5 rounded-[2px]"
                  style={{
                    backgroundColor: 'var(--sat-bg-subtle)',
                    color: 'var(--sat-text-secondary)',
                  }}
                >
                  Linha {inspectedCell.rowLabel}
                </span>
              )}
              <span
                className="font-mono text-[10.5px]"
                style={{ color: 'var(--sat-text-muted)' }}
              >
                {inspectedCell.text.length} caracteres
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {inspectedCell.isPandasCut && onExpandTruncated && !isExpandedTruncated && (
                <button
                  type="button"
                  onClick={onExpandTruncated}
                  disabled={isExpandingTruncated}
                  className="h-6 px-2 rounded-[3px] border text-[11px] font-medium inline-flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] cursor-pointer"
                  style={{
                    backgroundColor: 'var(--sat-accent-soft)',
                    borderColor: 'var(--sat-accent)',
                    color: 'var(--sat-accent)',
                  }}
                >
                  {isExpandingTruncated ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <ChevronsLeftRight size={11} />
                  )}
                  <span>Ver texto sem corte (...)</span>
                </button>
              )}

              <button
                type="button"
                onClick={async () => {
                  const ok = await copyTextToClipboard(inspectedCell.text);
                  if (ok) {
                    setCopiedCellText(true);
                    window.setTimeout(() => setCopiedCellText(false), 1500);
                  }
                }}
                className="h-6 px-2 rounded-[3px] border text-[11px] inline-flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] cursor-pointer"
                style={{
                  backgroundColor: 'var(--sat-bg-subtle)',
                  borderColor: 'var(--sat-border)',
                  color: copiedCellText ? 'var(--sat-green)' : 'var(--sat-text-secondary)',
                }}
              >
                {copiedCellText ? <Check size={11} /> : <Copy size={11} />}
                <span>{copiedCellText ? 'Copiado' : 'Copiar'}</span>
              </button>

              <button
                type="button"
                onClick={() => setInspectedCell(null)}
                className="sat-icon-btn p-1"
                title="Fechar visualização do campo"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          <pre
            className="m-0 p-2.5 rounded-[3px] border font-mono text-xs leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto select-text"
            style={{
              backgroundColor: 'var(--sat-bg-canvas)',
              borderColor: 'var(--sat-border-subtle)',
              color: 'var(--sat-text-primary)',
            }}
          >
            {inspectedCell.text}
          </pre>
        </div>
      )}

      {hasFilter && visibleCount === 0 && (
        <div
          className="px-3 py-2 text-xs border-t text-center"
          style={{
            borderColor: 'var(--sat-border-subtle)',
            color: 'var(--sat-text-muted)',
          }}
        >
          Nenhuma linha encontrada para "{filterQuery}".
        </div>
      )}

      {exportOpen && activeExportBtn && (
        <TableExportPopover
          anchorEl={activeExportBtn}
          meta={meta}
          visibleCount={visibleCount}
          viewportRowCount={viewportRowCount}
          hasFilter={hasFilter}
          verticalOverflow={verticalOverflow}
          scope={exportScope}
          onScopeChange={setExportScope}
          onExportPng={handleExportPng}
          onCopyPng={handleCopyPng}
          onExportCsv={handleExportCsv}
          onExportXlsx={handleExportXlsx}
          exportStatus={exportStatus}
          onClose={() => setExportOpen(false)}
        />
      )}

      {configOpen && activeConfigBtn && (
        <TableConfigPopover
          anchorEl={activeConfigBtn}
          meta={meta}
          settings={effectiveSettings}
          hasLocalOverride={Boolean(localOverride)}
          colOrder={colOrder}
          colWidths={colWidths}
          hiddenCols={hiddenCols}
          hasCustomColumns={hasCustomColumns}
          onMoveColumn={handleMoveColumn}
          onToggleColumnHidden={handleToggleColumnHidden}
          onResetColumns={handleResetColumns}
          onUpdate={updateLocal}
          onResetOverride={() => setLocalOverride(null)}
          onSaveAsDefault={handleSaveAsDefault}
          onCopy={handleCopy}
          copiedFormat={copiedFormat}
          savedDefaultToast={savedDefaultToast}
          onClose={() => setConfigOpen(false)}
        />
      )}

      {isFullscreen &&
        createPortal(
          <div
            data-modal-root="true"
            onClick={() => {
              setConfigOpen(false);
              setExportOpen(false);
              setIsFullscreen(false);
            }}
            className="fixed inset-0 z-[110] flex items-center justify-center bg-black/65 p-3 sm:p-6"
          >
            <div
              ref={modalBoxRef}
              data-table-modal="true"
              data-modal-fit={modalExpanded ? 'expanded' : modalCustomSize ? 'custom' : 'auto'}
              onClick={(e) => e.stopPropagation()}
              className={`relative rounded-[6px] border shadow-2xl flex flex-col overflow-hidden ${
                modalExpanded
                  ? 'w-[95vw] max-w-[1600px] h-[90vh]'
                  : modalCustomSize
                    ? 'max-w-[96vw] max-h-[92vh]'
                    : 'w-fit min-w-[min(620px,94vw)] max-w-[95vw] max-h-[86vh]'
              }`}
              style={{
                width: !modalExpanded && modalCustomSize ? `${modalCustomSize.width}px` : undefined,
                height: !modalExpanded && modalCustomSize ? `${modalCustomSize.height}px` : undefined,
                backgroundColor: 'var(--sat-cell-bg)',
                borderColor: 'var(--sat-border)',
                color: 'var(--sat-text-primary)',
              }}
            >
              <div
                className="h-10 px-3 flex items-center justify-between gap-3 border-b shrink-0 select-none"
                style={{
                  backgroundColor: 'var(--sat-bg-surface)',
                  borderColor: 'var(--sat-border)',
                }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Table2 size={14} style={{ color: 'var(--sat-accent)' }} />
                  <span className="font-semibold text-xs">Tabela</span>
                  <span
                    className="font-mono text-[11px] px-1.5 py-0.5 rounded-[2px]"
                    style={{
                      backgroundColor: 'var(--sat-bg-subtle)',
                      color: 'var(--sat-text-secondary)',
                    }}
                  >
                    {meta.shapeLabel}
                  </span>
                  {hasFilter && (
                    <span
                      className="font-mono text-[11px] px-1.5 py-0.5 rounded-[2px]"
                      style={{
                        backgroundColor: 'var(--sat-accent-soft)',
                        color: 'var(--sat-accent)',
                      }}
                    >
                      {visibleCount}/{meta.visibleRows} linhas
                    </span>
                  )}
                  {hasCustomColumns && (
                    <button
                      type="button"
                      onClick={handleResetColumns}
                      className="text-[11px] px-1.5 py-0.5 rounded-[2px] inline-flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] cursor-pointer"
                      style={{ color: 'var(--sat-accent)' }}
                      title="Restaurar ordem e largura original das colunas"
                    >
                      <RotateCcw size={11} />
                      <span className="hidden md:inline">Restaurar colunas</span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {!meta.hasRowSpanInBody && (
                    <div
                      className="flex items-center h-6.5 px-2 rounded-[3px] border gap-1.5"
                      style={{
                        backgroundColor: 'var(--sat-bg-canvas)',
                        borderColor: 'var(--sat-border)',
                      }}
                    >
                      <Search size={12} style={{ color: 'var(--sat-text-muted)' }} />
                      <input
                        autoFocus
                        type="text"
                        value={filterQuery}
                        onChange={(e) => setFilterQuery(e.target.value)}
                        placeholder="Filtrar linhas..."
                        className="w-36 sm:w-48 bg-transparent text-xs outline-none"
                        style={{ color: 'var(--sat-text-primary)' }}
                      />
                      {hasFilter && (
                        <button
                          type="button"
                          onClick={() => setFilterQuery('')}
                          className="p-0.5 rounded-[2px] hover:bg-[var(--sat-bg-hover)] cursor-pointer"
                          style={{ color: 'var(--sat-text-muted)' }}
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() =>
                      updateLocal({
                        wrap: effectiveSettings.wrap === 'nowrap' ? 'wrap' : 'nowrap',
                      })
                    }
                    className="h-6.5 px-2 rounded-[3px] border text-xs inline-flex items-center gap-1.5 cursor-pointer hover:bg-[var(--sat-bg-hover)]"
                    style={{
                      backgroundColor:
                        effectiveSettings.wrap === 'wrap'
                          ? 'var(--sat-accent-soft)'
                          : 'var(--sat-bg-subtle)',
                      borderColor:
                        effectiveSettings.wrap === 'wrap'
                          ? 'var(--sat-accent)'
                          : 'var(--sat-border)',
                      color:
                        effectiveSettings.wrap === 'wrap'
                          ? 'var(--sat-accent)'
                          : 'var(--sat-text-secondary)',
                    }}
                  >
                    <WrapText size={13} />
                    <span className="hidden sm:inline">
                      {effectiveSettings.wrap === 'wrap' ? 'Quebrando' : 'Linha única'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleCopy('tsv')}
                    className="h-6.5 px-2 rounded-[3px] border text-xs inline-flex items-center gap-1.5 cursor-pointer hover:bg-[var(--sat-bg-hover)]"
                    style={{
                      backgroundColor: 'var(--sat-bg-subtle)',
                      borderColor: 'var(--sat-border)',
                      color: copiedFormat === 'tsv' ? 'var(--sat-green)' : 'var(--sat-text-secondary)',
                    }}
                  >
                    {copiedFormat === 'tsv' ? <Check size={12} /> : <Copy size={12} />}
                    <span className="hidden sm:inline">{copiedFormat === 'tsv' ? 'Copiado' : 'Copiar'}</span>
                  </button>

                  <button
                    ref={fullscreenExportBtnRef}
                    type="button"
                    onClick={() => {
                      setConfigOpen(false);
                      setExportOpen((o) => !o);
                    }}
                    className="h-6.5 px-2 rounded-[3px] border text-xs inline-flex items-center gap-1.5 cursor-pointer hover:bg-[var(--sat-bg-hover)]"
                    style={{
                      backgroundColor: exportOpen ? 'var(--sat-bg-hover)' : 'var(--sat-bg-subtle)',
                      borderColor: 'var(--sat-border)',
                      color: 'var(--sat-text-secondary)',
                    }}
                    title="Exportar em PNG, Excel (.xlsx) ou CSV"
                  >
                    <Download size={12} />
                    <span className="hidden sm:inline">Exportar</span>
                  </button>

                  <button
                    ref={fullscreenConfigBtnRef}
                    type="button"
                    onClick={() => {
                      setExportOpen(false);
                      setConfigOpen((o) => !o);
                    }}
                    className="h-6.5 px-2 rounded-[3px] border text-xs inline-flex items-center gap-1.5 cursor-pointer hover:bg-[var(--sat-bg-hover)]"
                    style={{
                      backgroundColor: configOpen ? 'var(--sat-bg-hover)' : 'var(--sat-bg-subtle)',
                      borderColor: 'var(--sat-border)',
                      color: 'var(--sat-text-secondary)',
                    }}
                  >
                    <SlidersHorizontal size={12} />
                    <span className="hidden sm:inline">Config</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setModalCustomSize(null);
                      setModalExpanded((v) => !v);
                    }}
                    className="sat-icon-btn p-1"
                    title={
                      modalExpanded
                        ? 'Ajustar janela ao tamanho da tabela'
                        : 'Maximizar janela da tabela'
                    }
                    aria-label="Alternar tamanho da janela"
                  >
                    {modalExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setConfigOpen(false);
                      setExportOpen(false);
                      setIsFullscreen(false);
                    }}
                    className="sat-icon-btn p-1"
                    title="Fechar (Esc)"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              <TableViewport
                tableHtml={tableHtml}
                virtualData={virtualData}
                activeVirtualRows={activeVirtualRows}
                preservedStylesHtml={preservedStylesHtml}
                meta={meta}
                settings={effectiveSettings}
                filterQuery={filterQuery}
                sortState={sortState}
                onSortChange={setSortState}
                colOrder={colOrder}
                onColOrderChange={setColOrder}
                colWidths={colWidths}
                onColWidthChange={handleColWidthChange}
                hiddenCols={hiddenCols}
                onVisibleCountChange={setVisibleCount}
                tableRefOut={fullscreenTableRef}
                viewportRefOut={fullscreenViewportRef}
                scrollRefOut={fullscreenScrollRef}
                isFullscreen
                modalExpanded={modalExpanded}
              />

              {/* Corner resize grip for manual modal sizing */}
              <div
                onPointerDown={handleModalResizePointerDown}
                onDoubleClick={() => {
                  setModalCustomSize(null);
                  setModalExpanded(false);
                }}
                title="Arrastar para redimensionar janela • Duplo-clique para ajustar à tabela"
                className="absolute right-0 bottom-0 w-3.5 h-3.5 cursor-nwse-resize z-40 opacity-50 hover:opacity-100"
                style={{
                  background:
                    'linear-gradient(135deg, transparent 50%, var(--sat-text-muted) 50%, var(--sat-text-muted) 65%, transparent 65%, transparent 80%, var(--sat-text-muted) 80%)',
                }}
              />
            </div>
          </div>,
          document.body
        )}
    </div>
  );
});

export const TableOutputView: React.FC<Props> = React.memo(
  ({
    rawHtml,
    outputLimited = false,
    onExpandTruncated,
    isExpandingTruncated = false,
    isExpandedTruncated = false,
  }) => {
    const parsed = useMemo(() => inspectAndEnhanceHtml(rawHtml), [rawHtml]);

    if (!parsed.hasTables) {
      return (
        <div
          className="jp-rendered-html"
          dangerouslySetInnerHTML={{ __html: parsed.sanitizedHtml }}
        />
      );
    }

    return (
      <div className="sat-html-output space-y-2 min-w-0">
        {parsed.blocks.map((block, idx) =>
          block.type === 'table' ? (
            <InteractiveTableCard
              key={idx}
              tableHtml={block.tableHtml}
              virtualData={block.virtualData}
              meta={block.meta}
              preservedStylesHtml={parsed.preservedStylesHtml}
              outputLimited={outputLimited}
              onExpandTruncated={onExpandTruncated}
              isExpandingTruncated={isExpandingTruncated}
              isExpandedTruncated={isExpandedTruncated}
            />
          ) : (
            <div
              key={idx}
              className="jp-rendered-html"
              dangerouslySetInnerHTML={{ __html: block.html }}
            />
          )
        )}
      </div>
    );
  }
);
