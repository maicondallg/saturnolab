import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Maximize2,
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
  compareTableCellValues,
  extractTableDelimited,
  inspectAndEnhanceHtml,
  TableMeta,
} from '../utils/htmlTableUtils';

interface Props {
  rawHtml: string;
  outputLimited?: boolean;
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
  meta: TableMeta;
  settings: TableOutputSettings;
  filterQuery: string;
  sortState: SortState | null;
  onSortChange: (next: SortState | null) => void;
  onVisibleCountChange: (count: number) => void;
  onVerticalOverflowChange?: (overflows: boolean) => void;
  tableRefOut: React.MutableRefObject<HTMLTableElement | null>;
  isFullscreen?: boolean;
  outputLimited?: boolean;
}

const TableViewport: React.FC<TableViewportProps> = React.memo(({
  tableHtml,
  meta,
  settings,
  filterQuery,
  sortState,
  onSortChange,
  onVisibleCountChange,
  onVerticalOverflowChange,
  tableRefOut,
  isFullscreen = false,
  outputLimited = false,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const originalRowsRef = useRef<HTMLTableRowElement[]>([]);
  const [scrollState, setScrollState] = useState({ left: false, right: false });

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

  // Mount enhanced table HTML once per tableHtml change
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = tableHtml;
    const table = host.querySelector('table') as HTMLTableElement | null;
    tableRefOut.current = table;
    const tbody = table?.tBodies[0] || null;
    originalRowsRef.current = tbody ? Array.from(tbody.rows) : [];
    const raf = window.requestAnimationFrame(measureScroll);
    return () => {
      window.cancelAnimationFrame(raf);
      originalRowsRef.current = [];
      tableRefOut.current = null;
      host.innerHTML = '';
    };
  }, [tableHtml, tableRefOut, measureScroll]);

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
    if (meta.canSort && originalRowsRef.current.length > 0) {
      let orderedRows = originalRowsRef.current;
      if (sortState) {
        orderedRows = [...originalRowsRef.current].sort((rowA, rowB) => {
          const textA = rowA.cells[sortState.col]?.textContent || '';
          const textB = rowB.cells[sortState.col]?.textContent || '';
          const cmp = compareTableCellValues(textA, textB);
          return sortState.dir === 'asc' ? cmp : -cmp;
        });
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

  const handleTableClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!meta.canSort) return;
    const sel = window.getSelection()?.toString();
    if (sel) return;
    const th = (e.target as HTMLElement).closest('thead [data-sat-sortable-col]') as HTMLElement | null;
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
    ? 'calc(88vh - 42px)'
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

interface ConfigPopoverProps {
  anchorEl: HTMLElement;
  settings: TableOutputSettings;
  hasLocalOverride: boolean;
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
  settings,
  hasLocalOverride,
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

  useLayoutEffect(() => {
    const updatePos = () => {
      const rect = anchorEl.getBoundingClientRect();
      const popW = 288;
      const popH = popRef.current?.offsetHeight || 390;
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

  return createPortal(
    <div
      ref={popRef}
      data-modal-root="true"
      data-table-popover="true"
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[120] w-72 max-h-[calc(100vh-16px)] overflow-y-auto rounded-[4px] border shadow-2xl p-3 space-y-2.5 text-xs select-none"
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
        {hasLocalOverride && (
          <button
            type="button"
            onClick={onResetOverride}
            className="text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] hover:bg-[var(--sat-bg-hover)] cursor-pointer"
            style={{ color: 'var(--sat-text-muted)' }}
            title="Voltar para o padrão global"
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
  meta: TableMeta;
  preservedStylesHtml?: string;
  outputLimited?: boolean;
}

const InteractiveTableCard: React.FC<InteractiveTableCardProps> = React.memo(({
  tableHtml,
  meta,
  preservedStylesHtml = '',
  outputLimited = false,
}) => {
  const { globalSettings, setGlobalSettings } = useSaturnoStore(
    useShallow((s) => ({
      globalSettings: s.tableOutputSettings,
      setGlobalSettings: s.setTableOutputSettings,
    }))
  );

  const [localOverride, setLocalOverride] = useState<Partial<TableOutputSettings> | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(meta.visibleRows);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [verticalOverflow, setVerticalOverflow] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copiedFormat, setCopiedFormat] = useState<string | null>(null);
  const [savedDefaultToast, setSavedDefaultToast] = useState(false);

  const tableRef = useRef<HTMLTableElement | null>(null);
  const fullscreenTableRef = useRef<HTMLTableElement | null>(null);
  const configBtnRef = useRef<HTMLButtonElement>(null);
  const fullscreenConfigBtnRef = useRef<HTMLButtonElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const effectiveSettings = useMemo<TableOutputSettings>(
    () => (localOverride ? { ...globalSettings, ...localOverride } : globalSettings),
    [globalSettings, localOverride]
  );

  // Reset per-table transient filter/sort when underlying table HTML changes
  useEffect(() => {
    setSortState(null);
    setFilterQuery('');
    setFilterOpen(false);
    setVisibleCount(meta.visibleRows);
  }, [tableHtml, meta.visibleRows]);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !configOpen) {
        e.preventDefault();
        e.stopPropagation();
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isFullscreen, configOpen]);

  const updateLocal = useCallback((patch: Partial<TableOutputSettings>) => {
    setLocalOverride((prev) => ({ ...(prev || {}), ...patch }));
  }, []);

  const handleCopy = useCallback(async (format: 'tsv' | 'csv' | 'markdown') => {
    const tbl = (isFullscreen ? fullscreenTableRef.current : tableRef.current) || tableRef.current;
    if (!tbl) return;
    const text = extractTableDelimited(tbl, format);
    if (!text) return;
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedFormat(format);
      window.setTimeout(() => setCopiedFormat((cur) => (cur === format ? null : cur)), 1500);
    }
  }, [isFullscreen]);

  const handleSaveAsDefault = useCallback(() => {
    setGlobalSettings(effectiveSettings);
    setLocalOverride(null);
    setSavedDefaultToast(true);
    window.setTimeout(() => setSavedDefaultToast(false), 1500);
  }, [effectiveSettings, setGlobalSettings]);

  const hasFilter = filterQuery.trim().length > 0;
  const activeConfigBtn = isFullscreen ? fullscreenConfigBtnRef.current : configBtnRef.current;

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
            type="button"
            onClick={() => setIsFullscreen(true)}
            className={toolbarBtnClass}
            style={{ color: 'var(--sat-text-muted)' }}
            title="Expandir tabela em tela cheia"
            aria-label="Expandir tabela em tela cheia"
          >
            <Maximize2 size={12} />
          </button>

          <button
            ref={configBtnRef}
            type="button"
            onClick={() => setConfigOpen((o) => !o)}
            className={`${toolbarBtnClass} relative`}
            style={{
              backgroundColor: configOpen ? 'var(--sat-bg-hover)' : undefined,
              color:
                configOpen || localOverride
                  ? 'var(--sat-text-primary)'
                  : 'var(--sat-text-muted)',
            }}
            title="Configurações da tabela"
            aria-label="Configurações da tabela"
            aria-expanded={configOpen}
          >
            <SlidersHorizontal size={12} />
            {localOverride && (
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
        meta={meta}
        settings={effectiveSettings}
        filterQuery={filterQuery}
        sortState={sortState}
        onSortChange={setSortState}
        onVisibleCountChange={setVisibleCount}
        onVerticalOverflowChange={setVerticalOverflow}
        tableRefOut={tableRef}
        outputLimited={outputLimited}
      />

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

      {configOpen && activeConfigBtn && (
        <TableConfigPopover
          anchorEl={activeConfigBtn}
          settings={effectiveSettings}
          hasLocalOverride={Boolean(localOverride)}
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
            onClick={() => setIsFullscreen(false)}
            className="fixed inset-0 z-[110] flex items-center justify-center bg-black/65 p-3 sm:p-6"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-[94vw] max-w-[1440px] max-h-[88vh] rounded-[5px] border shadow-2xl flex flex-col overflow-hidden"
              style={{
                backgroundColor: 'var(--sat-cell-bg)',
                borderColor: 'var(--sat-border)',
                color: 'var(--sat-text-primary)',
              }}
            >
              {preservedStylesHtml && (
                <div
                  aria-hidden="true"
                  className="hidden"
                  dangerouslySetInnerHTML={{ __html: preservedStylesHtml }}
                />
              )}
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
                        className="w-40 sm:w-56 bg-transparent text-xs outline-none"
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
                    <span>{effectiveSettings.wrap === 'wrap' ? 'Quebrando' : 'Linha única'}</span>
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
                    <span>{copiedFormat === 'tsv' ? 'Copiado' : 'Copiar'}</span>
                  </button>

                  <button
                    ref={fullscreenConfigBtnRef}
                    type="button"
                    onClick={() => setConfigOpen((o) => !o)}
                    className="h-6.5 px-2 rounded-[3px] border text-xs inline-flex items-center gap-1.5 cursor-pointer hover:bg-[var(--sat-bg-hover)]"
                    style={{
                      backgroundColor: configOpen ? 'var(--sat-bg-hover)' : 'var(--sat-bg-subtle)',
                      borderColor: 'var(--sat-border)',
                      color: 'var(--sat-text-secondary)',
                    }}
                  >
                    <SlidersHorizontal size={12} />
                    <span>Config</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setConfigOpen(false);
                      setIsFullscreen(false);
                    }}
                    className="sat-icon-btn p-1 ml-1"
                    title="Fechar (Esc)"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              <TableViewport
                tableHtml={tableHtml}
                meta={meta}
                settings={effectiveSettings}
                filterQuery={filterQuery}
                sortState={sortState}
                onSortChange={setSortState}
                onVisibleCountChange={setVisibleCount}
                tableRefOut={fullscreenTableRef}
                isFullscreen
              />
            </div>
          </div>,
          document.body
        )}
    </div>
  );
});

export const TableOutputView: React.FC<Props> = React.memo(({ rawHtml, outputLimited = false }) => {
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
      {parsed.preservedStylesHtml && (
        <div
          aria-hidden="true"
          className="hidden"
          dangerouslySetInnerHTML={{ __html: parsed.preservedStylesHtml }}
        />
      )}
      {parsed.blocks.map((block, idx) =>
        block.type === 'table' ? (
          <InteractiveTableCard
            key={idx}
            tableHtml={block.tableHtml}
            meta={block.meta}
            preservedStylesHtml={parsed.preservedStylesHtml}
            outputLimited={outputLimited}
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
});
