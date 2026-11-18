import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSaturnoStore } from '../store/useSaturnoStore';
import {
  MinimapLanguage,
  MinimapMetrics,
  MinimapPalette,
  clamp,
  computeFastWheelDelta,
  computeMinimapMetrics,
  readMinimapPalette,
  scrollTopFromLensDrag,
  scrollTopFromPointerClick,
  tokenColorAndAlpha,
  tokenizeMinimapLine,
} from '../utils/minimapUtils';

interface Props {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  content: string;
  language: MinimapLanguage;
  width: number;
  isVisible: boolean;
  onResizeWidth: (width: number, persist?: boolean) => void;
}

const BASE_SCALE = 0.135;
const MIN_SCALE = 0.045;
const MIN_PANE_WIDTH_FOR_MINIMAP = 420;

export const TextFileMinimap: React.FC<Props> = React.memo(
  ({ scrollContainerRef, content, language, width, isVisible, onResizeWidth }) => {
    const theme = useSaturnoStore((s) => s.config?.theme || 'graphite');

    const asideRef = useRef<HTMLElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const lensRef = useRef<HTMLDivElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);

    const paletteRef = useRef<MinimapPalette>(readMinimapPalette());
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
    const hoveredLineRef = useRef<number | null>(null);
    const dragStateRef = useRef<{
      active: boolean;
      pointerId: number;
      grabOffset: number;
      trackTop: number;
      contentHeight: number;
      viewportHeight: number;
      mapHeight: number;
    }>({
      active: false,
      pointerId: -1,
      grabOffset: 0,
      trackTop: 0,
      contentHeight: 1,
      viewportHeight: 1,
      mapHeight: 1,
    });
    const dragScrollRafRef = useRef<number | null>(null);
    const pendingDragScrollTopRef = useRef<number | null>(null);
    const isWheelingRef = useRef(false);
    const wheelPendingDeltaRef = useRef(0);
    const wheelRafRef = useRef<number | null>(null);
    const wheelSettleTimerRef = useRef<number | null>(null);
    const needsRemeasureAfterDragRef = useRef(false);

    const [isDragging, setIsDragging] = useState(false);
    const [isNarrowPane, setIsNarrowPane] = useState(false);
    const [hoverCard, setHoverCard] = useState<{
      lineNumber: number;
      totalLines: number;
      snippet: { num: number; text: string; isTarget: boolean }[];
      top: number;
    } | null>(null);

    const lines = useMemo(() => content.replace(/\r\n/g, '\n').split('\n'), [content]);

    const propsRef = useRef({
      lines,
      language,
      width,
      isVisible,
    });
    propsRef.current = {
      lines,
      language,
      width,
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

      const { lines: curLines, language: curLang } = propsRef.current;
      const palette = paletteRef.current;
      const metrics = metricsRef.current;
      const totalLines = Math.max(1, curLines.length);

      const padX = 8;
      const innerW = Math.max(12, mapW - padX * 2);
      const padTop = 8 * metrics.scale;
      const usableVirtualH = Math.max(1, metrics.virtualHeight - padTop * 2);
      const lineStep = usableVirtualH / totalLines;
      const charW = innerW / 84;
      const hoveredLine = hoveredLineRef.current;

      // Virtualize: compute only visible line index range
      const startLine = Math.max(
        0,
        Math.floor((metrics.mapScrollOffset - padTop) / Math.max(0.1, lineStep)) - 1
      );
      const endLine = Math.min(
        totalLines - 1,
        Math.ceil((metrics.mapScrollOffset + mapH - padTop) / Math.max(0.1, lineStep)) + 1
      );

      // Step stride when extremely compressed so we never overdraw 10,000 subpixel lines
      const stride = Math.max(1, Math.floor(1.1 / Math.max(0.05, lineStep)));

      ctx.save();
      for (let idx = startLine; idx <= endLine; idx += stride) {
        const y = padTop + idx * lineStep - metrics.mapScrollOffset;
        if (y < -3 || y > mapH + 3) continue;

        if (hoveredLine !== null && Math.abs(idx - hoveredLine) < Math.max(1, stride)) {
          ctx.globalAlpha = 0.25;
          ctx.fillStyle = palette.accent;
          ctx.fillRect(2, Math.max(0, y - 1), mapW - 4, Math.max(3, lineStep + 1));
        }

        const spans = tokenizeMinimapLine(curLines[idx] || '', curLang);
        if (spans.length === 0) continue;

        for (let s = 0; s < spans.length; s++) {
          const span = spans[s];
          const sx = padX + span.col * charW;
          if (sx >= padX + innerW) break;
          const sw = Math.min(padX + innerW - sx, Math.max(1.8, span.len * charW));
          const { color, alpha } = tokenColorAndAlpha(span.role, palette);
          const strokeH =
            span.role === 'heading1'
              ? Math.max(1.8, Math.min(2.8, lineStep * 0.85))
              : Math.max(1, Math.min(2, lineStep * 0.65));

          ctx.globalAlpha = alpha;
          ctx.fillStyle = color;
          ctx.fillRect(sx, y, sw, strokeH);
        }
      }
      ctx.restore();

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

      const metrics = computeMinimapMetrics({
        contentHeight,
        viewportHeight,
        mapHeight,
        scrollTop: container.scrollTop,
        baseScale: BASE_SCALE,
        minScale: MIN_SCALE,
      });
      metricsRef.current = metrics;
      syncLensDom(metrics);
      drawCanvas();
    }, [scrollContainerRef, syncLensDom, drawCanvas]);

    useEffect(() => {
      const raf = window.requestAnimationFrame(() => {
        paletteRef.current = readMinimapPalette();
        drawCanvas();
      });
      return () => window.cancelAnimationFrame(raf);
    }, [theme, drawCanvas]);

    useEffect(() => {
      if (!isVisible || isNarrowPane) return;
      const raf = window.requestAnimationFrame(() => {
        paletteRef.current = readMinimapPalette();
        measureAndRender();
      });
      return () => window.cancelAnimationFrame(raf);
    }, [lines, language, width, isVisible, isNarrowPane, measureAndRender]);

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
          if (hoveredLineRef.current !== null) {
            hoveredLineRef.current = null;
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
      const firstChild = container.firstElementChild;
      if (firstChild) ro.observe(firstChild);

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
      };
    }, [isVisible, scrollContainerRef, syncLensDom, drawCanvas, measureAndRender]);

    const updateHoverAtClientY = useCallback(
      (clientY: number) => {
        const aside = asideRef.current;
        if (!aside) return;
        const rect = aside.getBoundingClientRect();
        const localY = clientY - rect.top;
        const metrics = metricsRef.current;
        const curLines = propsRef.current.lines;

        if (localY < 0 || localY > metrics.trackSpan + 2 || curLines.length === 0) {
          if (hoveredLineRef.current !== null) {
            hoveredLineRef.current = null;
            drawCanvas();
          }
          setHoverCard(null);
          return;
        }

        const virtualY = localY + metrics.mapScrollOffset;
        const ratio = clamp(virtualY / Math.max(1, metrics.virtualHeight), 0, 0.999999);
        const lineIdx = Math.floor(ratio * curLines.length);

        if (hoveredLineRef.current !== lineIdx) {
          hoveredLineRef.current = lineIdx;
          drawCanvas();
        }

        const start = Math.max(0, lineIdx - 1);
        const end = Math.min(curLines.length - 1, start + 3);
        const snippet: { num: number; text: string; isTarget: boolean }[] = [];
        for (let i = start; i <= end; i++) {
          const text = curLines[i] || '';
          snippet.push({
            num: i + 1,
            text: text.length > 68 ? `${text.slice(0, 67)}…` : text,
            isTarget: i === lineIdx,
          });
        }

        const desiredTop = Math.max(8, localY - 24);
        setHoverCard({
          lineNumber: lineIdx + 1,
          totalLines: curLines.length,
          snippet,
          top: desiredTop,
        });
      },
      [drawCanvas]
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

      if (!metrics.hasOverflow) return;

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
        const nextScrollTop = scrollTopFromLensDrag(
          moveLocalY,
          ds.grabOffset,
          metricsRef.current
        );
        pendingDragScrollTopRef.current = nextScrollTop;

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
      dragStateRef.current = {
        active: false,
        pointerId: -1,
        grabOffset: 0,
        trackTop: 0,
        contentHeight: 1,
        viewportHeight: 1,
        mapHeight: 1,
      };
      setIsDragging(false);
      if (needsRemeasureAfterDragRef.current) {
        needsRemeasureAfterDragRef.current = false;
        window.requestAnimationFrame(() => measureAndRender());
      }
    };

    const handlePointerLeave = () => {
      if (dragStateRef.current.active) return;
      if (hoveredLineRef.current !== null) {
        hoveredLineRef.current = null;
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
        aria-label="Minimapa do arquivo"
        data-sat-minimap="file"
        style={{
          width: isNarrowPane ? 0 : width,
          display: isNarrowPane ? 'none' : undefined,
        }}
        className="sat-minimap relative shrink-0 select-none h-full border-l"
      >
        <div
          onMouseDown={startResize}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onResizeWidth(116, true);
          }}
          title="Arraste para redimensionar o minimapa (duplo clique para padrão)"
          className="sat-minimap-resize"
        />

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

        {hoverCard && !isDragging && (
          <div
            ref={tooltipRef}
            data-sat-minimap-tooltip
            className="sat-minimap-tooltip pointer-events-none"
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <span
                className="text-[10.5px] font-mono font-medium"
                style={{ color: 'var(--sat-accent)' }}
              >
                Linha {hoverCard.lineNumber}
              </span>
              <span
                className="text-[10.5px] font-mono"
                style={{ color: 'var(--sat-text-muted)' }}
              >
                {hoverCard.totalLines} linhas
              </span>
            </div>
            <div className="font-mono text-[10.5px] leading-[1.45] space-y-0.5">
              {hoverCard.snippet.map((row) => (
                <div
                  key={row.num}
                  className="flex items-baseline gap-2 px-1 rounded-[2px]"
                  style={{
                    backgroundColor: row.isTarget ? 'var(--sat-accent-soft)' : 'transparent',
                    color: row.isTarget ? 'var(--sat-text-primary)' : 'var(--sat-text-secondary)',
                  }}
                >
                  <span
                    className="w-7 text-right shrink-0 opacity-60 tabular-nums"
                    style={{ color: 'var(--sat-text-muted)' }}
                  >
                    {row.num}
                  </span>
                  <span className="truncate whitespace-pre">{row.text || ' '}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>
    );
  }
);
