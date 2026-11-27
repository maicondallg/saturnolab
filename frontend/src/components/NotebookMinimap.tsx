import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Table2, BarChart3, AlertTriangle, Terminal, ChevronRight } from 'lucide-react';
import { NotebookCellData } from '../types/notebook';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { setLazyMountPaused } from './CodeMirrorCellEditor';
import {
  CellHoverPreview,
  CellOutputSummary,
  MinimapMetrics,
  MinimapPalette,
  MinimapTokenSpan,
  clamp,
  classifyCellOutputs,
  computeFastWheelDelta,
  computeMinimapMetrics,
  drawRoundedRect,
  extractCellPreview,
  readMinimapPalette,
  scrollTopFromLensDrag,
  scrollTopFromPointerClick,
  tokenColorAndAlpha,
  tokenizeMinimapLine,
} from '../utils/minimapUtils';
import { formatCellDuration } from '../utils/executionTime';

interface Props {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  cells: NotebookCellData[];
  activeCellId: string;
  notebookMode: 'command' | 'edit';
  width: number;
  showOutputs: boolean;
  isVisible: boolean;
  onSelectCell: (cellId: string) => void;
  onResizeWidth: (width: number, persist?: boolean) => void;
}

interface MeasuredCellBox {
  id: string;
  index: number;
  top: number;
  height: number;
  outputTop: number;
  outputHeight: number;
}

interface CellRenderModel {
  source: string;
  cellType: 'code' | 'markdown';
  lines: MinimapTokenSpan[][];
  headingLevel: number;
}

const MAX_SAMPLED_LINES = 64;
const BASE_SCALE = 0.135;
const MIN_SCALE = 0.032;
const MIN_PANE_WIDTH_FOR_MINIMAP = 420;

const cellRenderCache = new WeakMap<NotebookCellData, CellRenderModel>();

function getCellRenderModel(cell: NotebookCellData): CellRenderModel {
  const cached = cellRenderCache.get(cell);
  if (cached && cached.source === cell.source && cached.cellType === cell.cell_type) {
    return cached;
  }

  const rawLines = cell.source.replace(/\r\n/g, '\n').split('\n');
  const lang = cell.cell_type === 'markdown' ? 'markdown' : 'python';
  let headingLevel = 0;

  if (lang === 'markdown') {
    for (const l of rawLines) {
      const m = l.trim().match(/^(#{1,6})\s+/);
      if (m) {
        headingLevel = m[1].length;
        break;
      }
      if (l.trim()) break;
    }
  }

  const sampled: MinimapTokenSpan[][] = [];
  if (rawLines.length <= MAX_SAMPLED_LINES) {
    for (const line of rawLines) {
      sampled.push(tokenizeMinimapLine(line, lang));
    }
  } else {
    const step = rawLines.length / MAX_SAMPLED_LINES;
    for (let i = 0; i < MAX_SAMPLED_LINES; i++) {
      const idx = Math.min(rawLines.length - 1, Math.floor(i * step));
      sampled.push(tokenizeMinimapLine(rawLines[idx], lang));
    }
  }

  const model: CellRenderModel = {
    source: cell.source,
    cellType: cell.cell_type,
    lines: sampled,
    headingLevel,
  };
  cellRenderCache.set(cell, model);
  return model;
}

function drawOutputMiniature(
  ctx: CanvasRenderingContext2D,
  summary: CellOutputSummary,
  x: number,
  y: number,
  w: number,
  h: number,
  palette: MinimapPalette,
  showOutputs: boolean
): void {
  if (h < 2 || w < 6) return;

  // Subtle divider between code and output
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = palette.border;
  ctx.fillRect(x, Math.round(y), w, 1);
  ctx.restore();

  const innerX = x + 3;
  const innerY = y + 2;
  const innerW = Math.max(4, w - 6);
  const innerH = Math.max(1, h - 4);

  if (!showOutputs) {
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = summary.hasError ? palette.errorText : palette.textMuted;
    const barY = innerY + Math.min(innerH / 2, 3);
    ctx.fillRect(innerX, barY, Math.min(innerW * 0.45, 28), 1.5);
    ctx.restore();
    return;
  }

  if (summary.hasError) {
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = palette.errorBg;
    drawRoundedRect(ctx, x + 1, y + 1, Math.max(2, w - 2), Math.max(2, h - 2), 1.5);
    ctx.fill();
    ctx.globalAlpha = 0.78;
    ctx.fillStyle = palette.errorText;
    const rows = Math.max(1, Math.min(5, Math.floor(innerH / 3)));
    for (let i = 0; i < rows; i++) {
      const frac = i === 0 ? 0.85 : i === rows - 1 ? 0.6 : 0.45 + ((i * 19) % 35) / 100;
      ctx.fillRect(innerX, innerY + i * 3, innerW * frac, 1.5);
    }
    ctx.restore();
    return;
  }

  if (summary.hasPlot) {
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = palette.typePy;
    drawRoundedRect(ctx, innerX, innerY, innerW, innerH, 2);
    ctx.fill();

    if (innerH >= 7 && innerW >= 16) {
      // Stylized miniature sparkline/bar chart silhouette
      const baseLine = innerY + innerH - 2;
      const topLine = innerY + 2;
      const chartH = Math.max(3, baseLine - topLine);
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = palette.typePy;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      const pts = [0.75, 0.42, 0.58, 0.22, 0.48, 0.16, 0.36];
      pts.forEach((p, idx) => {
        const px = innerX + 2 + (idx / (pts.length - 1)) * (innerW - 4);
        const py = topLine + p * chartH;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      // Subtle axis line
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = palette.borderStrong;
      ctx.fillRect(innerX + 2, baseLine, innerW - 4, 1);
    }
    ctx.restore();
    return;
  }

  if (summary.hasTable) {
    ctx.save();
    // Header strip
    const headerH = Math.min(3.5, Math.max(1.5, innerH * 0.25));
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = palette.typeData;
    ctx.fillRect(innerX, innerY, innerW, headerH);

    // Subtle table rows
    const rowStep = 3;
    const startY = innerY + headerH + 1.5;
    const maxRows = Math.min(10, Math.floor((innerY + innerH - startY) / rowStep));
    ctx.fillStyle = palette.textMuted;
    for (let r = 0; r < maxRows; r++) {
      ctx.globalAlpha = r % 2 === 0 ? 0.28 : 0.16;
      ctx.fillRect(innerX, startY + r * rowStep, innerW, 1.3);
    }

    // Subtle vertical column separators
    if (innerH >= 8 && innerW >= 24) {
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = palette.borderStrong;
      const cols = Math.min(4, Math.max(2, Math.floor(innerW / 18)));
      for (let c = 1; c < cols; c++) {
        const cx = Math.round(innerX + (c / cols) * innerW);
        ctx.fillRect(cx, innerY, 1, innerH);
      }
    }
    ctx.restore();
    return;
  }

  // Generic text/stream output
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = palette.textMuted;
  const maxLines = Math.max(1, Math.min(8, Math.floor(innerH / 2.6)));
  for (let i = 0; i < maxLines; i++) {
    const frac = 0.35 + (((i * 29 + 17) % 55) / 100);
    ctx.fillRect(innerX, innerY + i * 2.6, innerW * frac, 1.2);
  }
  ctx.restore();
}

export const NotebookMinimap: React.FC<Props> = React.memo(
  ({
    scrollContainerRef,
    cells,
    activeCellId,
    notebookMode,
    width,
    showOutputs,
    isVisible,
    onSelectCell,
    onResizeWidth,
  }) => {
    const theme = useSaturnoStore((s) => s.config?.theme || 'graphite');

    const asideRef = useRef<HTMLElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const lensRef = useRef<HTMLDivElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);

    const paletteRef = useRef<MinimapPalette>(readMinimapPalette());
    const boxesRef = useRef<MeasuredCellBox[]>([]);
    const metricsRef = useRef<MinimapMetrics>(
      computeMinimapMetrics({
        contentHeight: 1,
        viewportHeight: 1,
        mapHeight: 1,
        scrollTop: 0,
        baseScale: BASE_SCALE,
        minScale: MIN_SCALE,
      })
    );
    const prevMapOffsetRef = useRef(0);
    const hoveredCellIdRef = useRef<string | null>(null);
    const dragStateRef = useRef<{
      active: boolean;
      pointerId: number;
      grabOffset: number;
      startY: number;
      trackTop: number;
      contentHeight: number;
      viewportHeight: number;
      mapHeight: number;
    }>({
      active: false,
      pointerId: -1,
      grabOffset: 0,
      startY: 0,
      trackTop: 0,
      contentHeight: 1,
      viewportHeight: 1,
      mapHeight: 1,
    });
    const dragScrollRafRef = useRef<number | null>(null);
    const pendingDragScrollTopRef = useRef<number | null>(null);
    const idleResumeTimerRef = useRef<number | null>(null);
    const isWheelingRef = useRef(false);
    const wheelPendingDeltaRef = useRef(0);
    const wheelRafRef = useRef<number | null>(null);
    const wheelSettleTimerRef = useRef<number | null>(null);
    const needsRemeasureAfterDragRef = useRef(false);
    const lastTapRef = useRef<{ cellId: string | null; time: number; y: number } | null>(null);

    const [isDragging, setIsDragging] = useState(false);
    const [isNarrowPane, setIsNarrowPane] = useState(false);
    const [hoverCard, setHoverCard] = useState<{
      preview: CellHoverPreview;
      top: number;
    } | null>(null);

    const outputSummaries = useMemo(
      () => cells.map((cell) => classifyCellOutputs(cell.outputs)),
      [cells]
    );

    const propsRef = useRef({
      cells,
      outputSummaries,
      activeCellId,
      notebookMode,
      width,
      showOutputs,
      isVisible,
    });
    propsRef.current = {
      cells,
      outputSummaries,
      activeCellId,
      notebookMode,
      width,
      showOutputs,
      isVisible,
    };

    const syncLensDom = useCallback((metrics: MinimapMetrics) => {
      const lens = lensRef.current;
      if (!lens) return;
      lens.style.transform = `translate3d(0, ${metrics.lensTop}px, 0)`;
      lens.style.height = `${metrics.lensHeight}px`;
      lens.dataset.scrollable = metrics.hasOverflow ? 'true' : 'false';
    }, []);

    const drawCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      const aside = asideRef.current;
      if (!canvas || !aside || !propsRef.current.isVisible) return;

      const mapW = aside.clientWidth;
      const mapH = aside.clientHeight;
      if (mapW <= 0 || mapH <= 0) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const targetW = Math.max(1, Math.round(mapW * dpr));
      const targetH = Math.max(1, Math.round(mapH * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, mapW, mapH);

      const {
        cells: curCells,
        outputSummaries: curSummaries,
        activeCellId: curActiveId,
        notebookMode: curMode,
        showOutputs: curShowOutputs,
      } = propsRef.current;

      const palette = paletteRef.current;
      const metrics = metricsRef.current;
      const boxes = boxesRef.current;
      const hoveredId = hoveredCellIdRef.current;

      const padX = 6;
      const cardW = Math.max(20, mapW - padX * 2);

      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        const cell = curCells[box.index];
        if (!cell) continue;

        const y = box.top * metrics.scale - metrics.mapScrollOffset;
        const h = Math.max(3, box.height * metrics.scale);

        if (y + h < -2) continue;
        if (y > mapH + 2) break;

        const isActive = cell.id === curActiveId;
        const isHovered = cell.id === hoveredId;
        const summary = curSummaries[box.index] || classifyCellOutputs(cell.outputs);
        const renderModel = getCellRenderModel(cell);
        const isHeading = renderModel.headingLevel > 0;

        // Cell card surface
        ctx.save();
        if (isActive) {
          ctx.fillStyle = palette.cellActiveBg;
          ctx.globalAlpha = 0.96;
        } else if (isHovered) {
          ctx.fillStyle = palette.bgSubtle;
          ctx.globalAlpha = 0.92;
        } else if (cell.cell_type === 'markdown') {
          ctx.fillStyle = palette.bgSubtle;
          ctx.globalAlpha = isHeading ? 0.58 : 0.34;
        } else {
          ctx.fillStyle = palette.cellBg;
          ctx.globalAlpha = 0.88;
        }
        drawRoundedRect(ctx, padX, y, cardW, h, 2);
        ctx.fill();

        // Card border
        if (h >= 4) {
          ctx.lineWidth = isActive || isHovered ? 1 : 0.75;
          if (isActive) {
            ctx.strokeStyle = curMode === 'edit' ? palette.editBar : palette.cmdBar;
            ctx.globalAlpha = 0.85;
          } else if (isHovered) {
            ctx.strokeStyle = palette.borderStrong;
            ctx.globalAlpha = 0.9;
          } else if (summary.hasError) {
            ctx.strokeStyle = palette.errorBorder;
            ctx.globalAlpha = 0.85;
          } else {
            ctx.strokeStyle = palette.border;
            ctx.globalAlpha = 0.65;
          }
          drawRoundedRect(ctx, padX + 0.5, y + 0.5, cardW - 1, Math.max(2, h - 1), 2);
          ctx.stroke();
        }
        ctx.restore();

        // Left status rail
        let railColor: string | null = null;
        let railAlpha = 0.95;
        if (cell.isRunning) {
          railColor = palette.accent;
        } else if (summary.hasError) {
          railColor = palette.errorText;
        } else if (isActive) {
          railColor = curMode === 'edit' ? palette.editBar : palette.cmdBar;
        } else if (isHeading) {
          railColor = palette.typeMd;
          railAlpha = 0.75;
        } else if (cell.cell_type === 'code' && cell.execution_count !== null) {
          railColor = palette.green;
          railAlpha = 0.55;
        }

        if (railColor) {
          ctx.save();
          ctx.globalAlpha = railAlpha;
          ctx.fillStyle = railColor;
          ctx.fillRect(padX, y + 0.5, 2.5, Math.max(2, h - 1));
          ctx.restore();
        }

        // Source content area
        const hasVisibleOutput =
          box.outputHeight > 0 && !cell.outputCollapsed && cell.outputs.length > 0;
        const sourceH = hasVisibleOutput
          ? Math.max(2, (box.outputTop - box.top) * metrics.scale)
          : h;

        const innerX = padX + 5;
        const innerW = Math.max(8, cardW - 9);
        const innerTop = y + 2;
        const innerH = Math.max(1, sourceH - 4);
        const lineCount = Math.max(1, renderModel.lines.length);

        const maxLineStep = isHeading ? 3.6 : 2.8;
        const lineStep = clamp(innerH / lineCount, 1.15, maxLineStep);
        const maxDrawableLines = Math.min(
          renderModel.lines.length,
          Math.max(1, Math.floor(innerH / lineStep))
        );
        const charW = innerW / 74;

        ctx.save();
        for (let li = 0; li < maxDrawableLines; li++) {
          const spans = renderModel.lines[li];
          if (!spans || spans.length === 0) continue;
          const ly = innerTop + li * lineStep;
          if (ly + 1 > y + sourceH - 1) break;

          for (let si = 0; si < spans.length; si++) {
            const span = spans[si];
            const sx = innerX + span.col * charW;
            if (sx >= innerX + innerW) break;
            const sw = Math.min(innerX + innerW - sx, Math.max(1.8, span.len * charW));
            const { color, alpha } = tokenColorAndAlpha(span.role, palette);
            const strokeH =
              span.role === 'heading1'
                ? Math.min(2.6, Math.max(1.6, lineStep * 0.78))
                : span.role === 'heading2'
                  ? Math.min(2.1, Math.max(1.4, lineStep * 0.7))
                  : Math.max(1, Math.min(1.8, lineStep * 0.58));

            ctx.globalAlpha = alpha;
            ctx.fillStyle = color;
            ctx.fillRect(sx, ly, sw, strokeH);
          }
        }
        ctx.restore();

        // Collapsed section indicator badge on right edge
        if (cell.sectionCollapsed && h >= 5) {
          ctx.save();
          ctx.fillStyle = palette.accent;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(padX + cardW - 5, y + 2, 3, Math.min(3, h - 3));
          ctx.restore();
        }

        // Output miniature block
        if (hasVisibleOutput) {
          const outY = box.outputTop * metrics.scale - metrics.mapScrollOffset;
          const outH = Math.max(2, box.outputHeight * metrics.scale);
          drawOutputMiniature(
            ctx,
            summary,
            padX + 1,
            outY,
            Math.max(4, cardW - 2),
            outH,
            palette,
            curShowOutputs
          );
        }
      }

      prevMapOffsetRef.current = metrics.mapScrollOffset;
    }, []);

    const measureAndRender = useCallback(() => {
      const container = scrollContainerRef.current;
      const aside = asideRef.current;
      if (!container || !aside || !propsRef.current.isVisible) return;

      const parentW = aside.parentElement?.clientWidth ?? 9999;
      const narrow = parentW > 0 && parentW < MIN_PANE_WIDTH_FOR_MINIMAP;
      setIsNarrowPane((prev) => (prev === narrow ? prev : narrow));
      if (narrow) return;

      const viewportHeight = container.clientHeight;
      const contentHeight = container.scrollHeight;
      const mapHeight = aside.clientHeight;
      if (viewportHeight <= 0 || mapHeight <= 0) return;

      const containerRect = container.getBoundingClientRect();
      const scrollTop = container.scrollTop;
      const curCells = propsRef.current.cells;

      const indexById = new Map<string, number>();
      for (let i = 0; i < curCells.length; i++) {
        indexById.set(curCells[i].id, i);
      }

      const cellEls = container.querySelectorAll<HTMLElement>('[data-cell-id]');
      const measured: MeasuredCellBox[] = [];
      for (let i = 0; i < cellEls.length; i++) {
        const el = cellEls[i];
        const id = el.dataset.cellId;
        if (!id) continue;
        const cellIdx = indexById.get(id);
        if (cellIdx === undefined) continue;
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0) continue;

        let outputTop = 0;
        let outputHeight = 0;
        const outEl = el.querySelector<HTMLElement>('[data-cell-output-id]');
        if (outEl) {
          const outRect = outEl.getBoundingClientRect();
          if (outRect.height > 0) {
            outputTop = outRect.top - containerRect.top + scrollTop;
            outputHeight = outRect.height;
          }
        }

        measured.push({
          id,
          index: cellIdx,
          top: rect.top - containerRect.top + scrollTop,
          height: rect.height,
          outputTop,
          outputHeight,
        });
      }

      boxesRef.current = measured;
      const metrics = computeMinimapMetrics({
        contentHeight,
        viewportHeight,
        mapHeight,
        scrollTop,
        baseScale: BASE_SCALE,
        minScale: MIN_SCALE,
      });
      metricsRef.current = metrics;
      syncLensDom(metrics);
      drawCanvas();
    }, [scrollContainerRef, syncLensDom, drawCanvas]);

    // Refresh theme palette when theme changes
    useEffect(() => {
      const raf = window.requestAnimationFrame(() => {
        paletteRef.current = readMinimapPalette();
        drawCanvas();
      });
      return () => window.cancelAnimationFrame(raf);
    }, [theme, drawCanvas]);

    // Re-measure when cells, active cell, mode, width, outputs toggle, or tab visibility changes
    useEffect(() => {
      if (!isVisible || isNarrowPane) return;
      const raf = window.requestAnimationFrame(() => {
        paletteRef.current = readMinimapPalette();
        measureAndRender();
      });
      return () => window.cancelAnimationFrame(raf);
    }, [cells, activeCellId, notebookMode, width, showOutputs, isVisible, isNarrowPane, measureAndRender]);

    // Observe scroll + resize changes cleanly via RAF throttling
    useEffect(() => {
      if (!isVisible) return;
      const container = scrollContainerRef.current;
      const aside = asideRef.current;
      if (!container || !aside) return;

      let scrollRaf: number | null = null;
      let resizeRaf: number | null = null;

      const onScroll = () => {
        if (dragStateRef.current.active || isWheelingRef.current) return;
        if (scrollRaf !== null) return;
        scrollRaf = window.requestAnimationFrame(() => {
          scrollRaf = null;
          if (dragStateRef.current.active || isWheelingRef.current) return;
          const prevOffset = prevMapOffsetRef.current;
          const nextMetrics = computeMinimapMetrics({
            contentHeight: container.scrollHeight,
            viewportHeight: container.clientHeight,
            mapHeight: aside.clientHeight,
            scrollTop: container.scrollTop,
            baseScale: BASE_SCALE,
            minScale: MIN_SCALE,
          });
          metricsRef.current = nextMetrics;
          syncLensDom(nextMetrics);
          if (Math.abs(nextMetrics.mapScrollOffset - prevOffset) > 0.25) {
            drawCanvas();
          }
        });
      };

      const scheduleResizeMeasure = () => {
        if (dragStateRef.current.active || isWheelingRef.current) {
          needsRemeasureAfterDragRef.current = true;
          return;
        }
        if (resizeRaf !== null) return;
        resizeRaf = window.requestAnimationFrame(() => {
          resizeRaf = null;
          if (dragStateRef.current.active || isWheelingRef.current) {
            needsRemeasureAfterDragRef.current = true;
            return;
          }
          measureAndRender();
        });
      };

      const trackEl = trackRef.current;
      const onWheel = (e: WheelEvent) => {
        if (e.ctrlKey || dragStateRef.current.active) return;
        const curMetrics = metricsRef.current;
        if (!curMetrics.hasOverflow) return;
        const delta = computeFastWheelDelta(e.deltaY, e.deltaMode, curMetrics);
        if (!delta) return;

        e.preventDefault();
        wheelPendingDeltaRef.current += delta;

        if (!isWheelingRef.current) {
          isWheelingRef.current = true;
          lensRef.current?.classList.add('is-wheeling');
          setLazyMountPaused(container, true);
          if (hoveredCellIdRef.current !== null) {
            hoveredCellIdRef.current = null;
            drawCanvas();
          }
          setHoverCard(null);
        }

        if (wheelSettleTimerRef.current !== null) {
          window.clearTimeout(wheelSettleTimerRef.current);
        }
        wheelSettleTimerRef.current = window.setTimeout(() => {
          wheelSettleTimerRef.current = null;
          isWheelingRef.current = false;
          lensRef.current?.classList.remove('is-wheeling');
          setLazyMountPaused(container, false);
          if (needsRemeasureAfterDragRef.current) {
            needsRemeasureAfterDragRef.current = false;
            window.requestAnimationFrame(() => measureAndRender());
          }
        }, 160);

        if (wheelRafRef.current === null) {
          wheelRafRef.current = window.requestAnimationFrame(() => {
            wheelRafRef.current = null;
            const step = wheelPendingDeltaRef.current;
            wheelPendingDeltaRef.current = 0;
            if (!step) return;
            const m = metricsRef.current;
            const nextScrollTop = clamp(container.scrollTop + step, 0, m.maxScrollTop);
            container.scrollTop = nextScrollTop;
            const nextMetrics = computeMinimapMetrics({
              contentHeight: m.contentHeight,
              viewportHeight: m.viewportHeight,
              mapHeight: m.mapHeight,
              scrollTop: nextScrollTop,
              baseScale: BASE_SCALE,
              minScale: MIN_SCALE,
            });
            metricsRef.current = nextMetrics;
            syncLensDom(nextMetrics);
            if (Math.abs(nextMetrics.mapScrollOffset - prevMapOffsetRef.current) > 0.25) {
              drawCanvas();
            }
          });
        }
      };

      container.addEventListener('scroll', onScroll, { passive: true });
      trackEl?.addEventListener('wheel', onWheel, { passive: false });

      const ro = new ResizeObserver(scheduleResizeMeasure);
      ro.observe(container);
      ro.observe(aside);
      if (aside.parentElement) ro.observe(aside.parentElement);
      const listEl = container.querySelector('.notebook-cells-list');
      if (listEl) ro.observe(listEl);

      scheduleResizeMeasure();

      return () => {
        container.removeEventListener('scroll', onScroll);
        trackEl?.removeEventListener('wheel', onWheel);
        ro.disconnect();
        if (scrollRaf !== null) window.cancelAnimationFrame(scrollRaf);
        if (resizeRaf !== null) window.cancelAnimationFrame(resizeRaf);
        if (dragScrollRafRef.current !== null) {
          window.cancelAnimationFrame(dragScrollRafRef.current);
          dragScrollRafRef.current = null;
        }
        if (idleResumeTimerRef.current !== null) {
          window.clearTimeout(idleResumeTimerRef.current);
          idleResumeTimerRef.current = null;
        }
        if (wheelRafRef.current !== null) {
          window.cancelAnimationFrame(wheelRafRef.current);
          wheelRafRef.current = null;
        }
        if (wheelSettleTimerRef.current !== null) {
          window.clearTimeout(wheelSettleTimerRef.current);
          wheelSettleTimerRef.current = null;
        }
        wheelPendingDeltaRef.current = 0;
        isWheelingRef.current = false;
        lensRef.current?.classList.remove('is-wheeling');
        setLazyMountPaused(container, false);
      };
    }, [isVisible, scrollContainerRef, syncLensDom, drawCanvas, measureAndRender]);

    const findCellBoxAtLocalY = useCallback((localY: number): MeasuredCellBox | null => {
      const metrics = metricsRef.current;
      if (localY < 0 || localY > metrics.trackSpan + 4) return null;
      const docY = (localY + metrics.mapScrollOffset) / Math.max(1e-6, metrics.scale);
      const boxes = boxesRef.current;
      if (boxes.length === 0) return null;

      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (docY >= b.top - 6 && docY <= b.top + b.height + 6) {
          return b;
        }
      }
      // Fallback to nearest cell if within small gap
      let best: MeasuredCellBox | null = null;
      let bestDist = 40;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const dist = docY < b.top ? b.top - docY : docY > b.top + b.height ? docY - (b.top + b.height) : 0;
        if (dist < bestDist) {
          bestDist = dist;
          best = b;
        }
      }
      return best;
    }, []);

    const updateHoverAtClientY = useCallback(
      (clientY: number) => {
        const aside = asideRef.current;
        if (!aside) return;
        const rect = aside.getBoundingClientRect();
        const localY = clientY - rect.top;
        const box = findCellBoxAtLocalY(localY);

        if (!box) {
          if (hoveredCellIdRef.current !== null) {
            hoveredCellIdRef.current = null;
            drawCanvas();
          }
          setHoverCard(null);
          return;
        }

        const cell = propsRef.current.cells[box.index];
        if (!cell) {
          setHoverCard(null);
          return;
        }

        if (hoveredCellIdRef.current !== cell.id) {
          hoveredCellIdRef.current = cell.id;
          drawCanvas();
        }

        const desiredTop = Math.max(8, localY - 26);
        setHoverCard((prev) => {
          if (prev && prev.preview.cellId === cell.id && Math.abs(prev.top - desiredTop) < 3) {
            return prev;
          }
          return {
            preview: extractCellPreview(cell, box.index, propsRef.current.cells.length),
            top: desiredTop,
          };
        });
      },
      [findCellBoxAtLocalY, drawCanvas]
    );

    useLayoutEffect(() => {
      const tip = tooltipRef.current;
      const aside = asideRef.current;
      if (!tip || !aside || !hoverCard) return;
      const maxTop = Math.max(8, aside.clientHeight - tip.offsetHeight - 8);
      tip.style.top = `${clamp(hoverCard.top, 8, maxTop)}px`;
    }, [hoverCard]);

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const container = scrollContainerRef.current;
      const aside = asideRef.current;
      if (!container || !aside) return;

      e.preventDefault();
      e.stopPropagation();

      const rect = aside.getBoundingClientRect();
      const localY = e.clientY - rect.top;
      const metrics = metricsRef.current;

      // Handle reliable double-click cell selection even with preventDefault() on pointerdown
      const now = Date.now();
      const prevTap = lastTapRef.current;
      const hitBox = findCellBoxAtLocalY(localY);
      if (
        prevTap &&
        prevTap.cellId &&
        now - prevTap.time < 380 &&
        Math.abs(localY - prevTap.y) < 10
      ) {
        lastTapRef.current = null;
        onSelectCell(prevTap.cellId);
        return;
      }
      lastTapRef.current = { cellId: hitBox?.id ?? null, time: now, y: localY };

      if (!metrics.hasOverflow) return;

      // Cancel any pending wheel-settle timer so it cannot resume lazy mounting mid-drag
      if (wheelSettleTimerRef.current !== null) {
        window.clearTimeout(wheelSettleTimerRef.current);
        wheelSettleTimerRef.current = null;
      }
      if (wheelRafRef.current !== null) {
        window.cancelAnimationFrame(wheelRafRef.current);
        wheelRafRef.current = null;
      }
      wheelPendingDeltaRef.current = 0;
      isWheelingRef.current = false;
      lensRef.current?.classList.remove('is-wheeling');

      // Defer lazy CodeMirror mounting while scrubbing so swept-past cells do not freeze drag
      setLazyMountPaused(container, true);

      const contentHeight = container.scrollHeight;
      const viewportHeight = container.clientHeight;
      const mapHeight = aside.clientHeight;

      const hitLens =
        localY >= metrics.lensTop && localY <= metrics.lensTop + metrics.lensHeight;

      let grabOffset: number;
      if (hitLens) {
        grabOffset = localY - metrics.lensTop;
      } else {
        const nextScrollTop = scrollTopFromPointerClick(localY, metrics);
        container.scrollTop = nextScrollTop;
        const updatedMetrics = computeMinimapMetrics({
          contentHeight,
          viewportHeight,
          mapHeight,
          scrollTop: nextScrollTop,
          baseScale: BASE_SCALE,
          minScale: MIN_SCALE,
        });
        metricsRef.current = updatedMetrics;
        syncLensDom(updatedMetrics);
        if (Math.abs(updatedMetrics.mapScrollOffset - prevMapOffsetRef.current) > 0.25) {
          drawCanvas();
        }
        grabOffset = updatedMetrics.lensHeight / 2;
      }

      dragStateRef.current = {
        active: true,
        pointerId: e.pointerId,
        grabOffset,
        startY: localY,
        trackTop: rect.top,
        contentHeight,
        viewportHeight,
        mapHeight,
      };
      needsRemeasureAfterDragRef.current = false;
      setIsDragging(true);
      setHoverCard(null);
      e.currentTarget.setPointerCapture(e.pointerId);
    };

    const applyDragScroll = useCallback(
      (nextScrollTop: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;
        const ds = dragStateRef.current;
        container.scrollTop = nextScrollTop;
        const nextMetrics = computeMinimapMetrics({
          contentHeight: ds.contentHeight,
          viewportHeight: ds.viewportHeight,
          mapHeight: ds.mapHeight,
          scrollTop: nextScrollTop,
          baseScale: BASE_SCALE,
          minScale: MIN_SCALE,
        });
        metricsRef.current = nextMetrics;
        syncLensDom(nextMetrics);
        if (Math.abs(nextMetrics.mapScrollOffset - prevMapOffsetRef.current) > 0.25) {
          drawCanvas();
        }
      },
      [scrollContainerRef, syncLensDom, drawCanvas]
    );

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const container = scrollContainerRef.current;
      const aside = asideRef.current;
      if (!container || !aside) return;

      if (dragStateRef.current.active) {
        const ds = dragStateRef.current;
        const moveLocalY = e.clientY - ds.trackTop;
        if (Math.abs(moveLocalY - ds.startY) > 4) {
          lastTapRef.current = null;
        }

        // Keep lazy mounting paused while moving; gently resume if user pauses in place
        setLazyMountPaused(container, true);
        if (idleResumeTimerRef.current !== null) {
          window.clearTimeout(idleResumeTimerRef.current);
        }
        idleResumeTimerRef.current = window.setTimeout(() => {
          idleResumeTimerRef.current = null;
          if (dragStateRef.current.active) {
            setLazyMountPaused(container, false);
          }
        }, 180);

        const nextScrollTop = scrollTopFromLensDrag(
          moveLocalY,
          ds.grabOffset,
          metricsRef.current
        );
        pendingDragScrollTopRef.current = nextScrollTop;

        // Move lens immediately for 0ms latency while coalescing scrollTop writes to 1 per frame
        const instantMetrics = computeMinimapMetrics({
          contentHeight: ds.contentHeight,
          viewportHeight: ds.viewportHeight,
          mapHeight: ds.mapHeight,
          scrollTop: nextScrollTop,
          baseScale: BASE_SCALE,
          minScale: MIN_SCALE,
        });
        metricsRef.current = instantMetrics;
        syncLensDom(instantMetrics);

        if (dragScrollRafRef.current === null) {
          dragScrollRafRef.current = window.requestAnimationFrame(() => {
            dragScrollRafRef.current = null;
            const target = pendingDragScrollTopRef.current;
            pendingDragScrollTopRef.current = null;
            if (target !== null) {
              applyDragScroll(target);
            }
          });
        }
        return;
      }

      if (isWheelingRef.current) return;
      updateHoverAtClientY(e.clientY);
    };

    const stopDragging = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRef.current.active) return;
      if (e.currentTarget.hasPointerCapture(dragStateRef.current.pointerId)) {
        e.currentTarget.releasePointerCapture(dragStateRef.current.pointerId);
      }

      if (dragScrollRafRef.current !== null) {
        window.cancelAnimationFrame(dragScrollRafRef.current);
        dragScrollRafRef.current = null;
      }
      if (pendingDragScrollTopRef.current !== null) {
        const finalTop = pendingDragScrollTopRef.current;
        pendingDragScrollTopRef.current = null;
        applyDragScroll(finalTop);
      }
      if (idleResumeTimerRef.current !== null) {
        window.clearTimeout(idleResumeTimerRef.current);
        idleResumeTimerRef.current = null;
      }

      dragStateRef.current = {
        active: false,
        pointerId: -1,
        grabOffset: 0,
        startY: 0,
        trackTop: 0,
        contentHeight: 1,
        viewportHeight: 1,
        mapHeight: 1,
      };
      setIsDragging(false);

      const container = scrollContainerRef.current;
      if (container) {
        setLazyMountPaused(container, false);
      }
      if (needsRemeasureAfterDragRef.current) {
        needsRemeasureAfterDragRef.current = false;
        window.requestAnimationFrame(() => measureAndRender());
      }
    };

    const handlePointerLeave = () => {
      if (dragStateRef.current.active) return;
      if (hoveredCellIdRef.current !== null) {
        hoveredCellIdRef.current = null;
        drawCanvas();
      }
      setHoverCard(null);
    };

    const startResize = (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = width;

      const onMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX;
        onResizeWidth(startWidth + delta, false);
      };
      const onUp = () => {
        onResizeWidth(useSaturnoStore.getState().minimapWidth, true);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };

    return (
      <aside
        ref={asideRef}
        role="navigation"
        aria-label="Minimapa do notebook"
        data-sat-minimap="notebook"
        style={{
          width: isNarrowPane ? 0 : width,
          display: isNarrowPane ? 'none' : undefined,
        }}
        className="sat-minimap relative shrink-0 select-none h-full border-l"
      >
        {/* Left-edge drag handle to resize minimap width */}
        <div
          onMouseDown={startResize}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onResizeWidth(116, true);
          }}
          title="Arraste para redimensionar o minimapa (duplo clique para padrão)"
          className="sat-minimap-resize"
        />

        {/* Interactive Track + High-DPI Miniview Canvas + Viewport Lens */}
        <div
          ref={trackRef}
          data-sat-minimap-track
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onPointerLeave={handlePointerLeave}
          className={`relative w-full h-full overflow-hidden ${
            isDragging ? 'cursor-grabbing' : 'cursor-pointer'
          }`}
        >
          <canvas
            ref={canvasRef}
            className="block w-full h-full pointer-events-none"
          />

          <div
            ref={lensRef}
            data-sat-minimap-lens
            className={`sat-minimap-lens ${isDragging ? 'is-dragging' : ''}`}
          />
        </div>

        {/* Floating Miniview Hover Card */}
        {hoverCard && !isDragging && (
          <div
            ref={tooltipRef}
            data-sat-minimap-tooltip
            className="sat-minimap-tooltip pointer-events-none"
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className="text-[10.5px] font-mono px-1.5 py-0.5 rounded-[2px] font-medium shrink-0"
                  style={{
                    backgroundColor:
                      hoverCard.preview.cellType === 'markdown'
                        ? 'var(--sat-bg-subtle)'
                        : 'var(--sat-accent-soft)',
                    color:
                      hoverCard.preview.cellType === 'markdown'
                        ? 'var(--sat-type-md)'
                        : 'var(--sat-accent)',
                  }}
                >
                  {hoverCard.preview.cellType === 'markdown'
                    ? 'MD'
                    : hoverCard.preview.executionCount !== null
                      ? `In [${hoverCard.preview.executionCount}]`
                      : 'Code'}
                </span>
                {hoverCard.preview.isRunning &&
                  (hoverCard.preview.executionQueued ? (
                    <span
                      className="text-[10px] font-mono shrink-0"
                      style={{ color: 'var(--sat-text-muted)' }}
                    >
                      fila
                    </span>
                  ) : (
                    <Loader2
                      size={11}
                      className="animate-spin shrink-0"
                      style={{ color: 'var(--sat-accent)' }}
                    />
                  ))}
                {!hoverCard.preview.isRunning &&
                  typeof hoverCard.preview.executionDurationMs === 'number' && (
                    <span
                      className="text-[10px] font-mono shrink-0"
                      style={{
                        color:
                          hoverCard.preview.executionStatus === 'error'
                            ? 'var(--sat-error-text)'
                            : 'var(--sat-text-muted)',
                      }}
                    >
                      {formatCellDuration(hoverCard.preview.executionDurationMs)}
                    </span>
                  )}
                {hoverCard.preview.sectionCollapsed && (
                  <span
                    className="inline-flex items-center text-[10px]"
                    style={{ color: 'var(--sat-text-muted)' }}
                  >
                    <ChevronRight size={11} />
                    recolhida
                  </span>
                )}
              </div>
              <span
                className="text-[10.5px] font-mono shrink-0"
                style={{ color: 'var(--sat-text-muted)' }}
              >
                #{hoverCard.preview.cellNumber}/{hoverCard.preview.totalCells}
              </span>
            </div>

            {hoverCard.preview.heading && (
              <div
                className="text-xs font-semibold truncate mb-1"
                style={{ color: 'var(--sat-text-primary)' }}
              >
                {hoverCard.preview.heading}
              </div>
            )}

            {hoverCard.preview.lines.length > 0 ? (
              <div
                className="font-mono text-[10.5px] leading-[1.45] space-y-0.5 overflow-hidden"
                style={{ color: 'var(--sat-text-secondary)' }}
              >
                {hoverCard.preview.lines.map((line, i) => (
                  <div key={i} className="truncate whitespace-pre">
                    {line}
                  </div>
                ))}
              </div>
            ) : !hoverCard.preview.heading ? (
              <div
                className="text-[11px] italic"
                style={{ color: 'var(--sat-text-muted)' }}
              >
                Célula vazia
              </div>
            ) : null}

            {hoverCard.preview.outputSummary.badges.length > 0 && (
              <div
                className="mt-1.5 pt-1.5 border-t flex flex-wrap items-center gap-1"
                style={{ borderColor: 'var(--sat-border-subtle)' }}
              >
                {hoverCard.preview.outputSummary.hasError && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-[2px]"
                    style={{
                      backgroundColor: 'var(--sat-error-bg)',
                      color: 'var(--sat-error-text)',
                    }}
                  >
                    <AlertTriangle size={10} />
                    Erro
                  </span>
                )}
                {hoverCard.preview.outputSummary.hasPlot && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-[2px]"
                    style={{
                      backgroundColor: 'var(--sat-bg-subtle)',
                      color: 'var(--sat-type-py)',
                    }}
                  >
                    <BarChart3 size={10} />
                    Gráfico
                  </span>
                )}
                {hoverCard.preview.outputSummary.hasTable && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-[2px]"
                    style={{
                      backgroundColor: 'var(--sat-bg-subtle)',
                      color: 'var(--sat-type-data)',
                    }}
                  >
                    <Table2 size={10} />
                    Tabela
                  </span>
                )}
                {hoverCard.preview.outputSummary.hasText &&
                  !hoverCard.preview.outputSummary.hasError &&
                  !hoverCard.preview.outputSummary.hasPlot &&
                  !hoverCard.preview.outputSummary.hasTable && (
                    <span
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-[2px]"
                      style={{
                        backgroundColor: 'var(--sat-bg-subtle)',
                        color: 'var(--sat-text-secondary)',
                      }}
                    >
                      <Terminal size={10} />
                      Saída
                    </span>
                  )}
                {hoverCard.preview.outputCollapsed && (
                  <span
                    className="text-[10px]"
                    style={{ color: 'var(--sat-text-muted)' }}
                  >
                    (oculta)
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </aside>
    );
  }
);
