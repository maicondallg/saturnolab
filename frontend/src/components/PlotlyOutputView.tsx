import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, Check, Download, Loader2, Maximize2, Minimize2, RotateCcw, X } from 'lucide-react';

export interface PlotlySpec {
  data?: any[];
  layout?: Record<string, any>;
  config?: Record<string, any>;
  frames?: any[];
}

interface Props {
  spec: PlotlySpec | string;
  outputLimited?: boolean;
}

let plotlyModulePromise: Promise<any> | null = null;

function loadPlotly(): Promise<any> {
  if (!plotlyModulePromise) {
    plotlyModulePromise = import('plotly.js-dist-min')
      .then((mod) => mod.default || mod)
      .catch((err) => {
        plotlyModulePromise = null;
        throw err;
      });
  }
  return plotlyModulePromise;
}

/**
 * Returns true if the HTML output is the script-only RequireJS bundle emitted
 * as a separate display_data message by Plotly's legacy `notebook` renderer.
 */
export function isPlotlyLoaderOnlyHtml(rawHtml: string): boolean {
  if (!rawHtml) return false;
  const hasPlotlyInit =
    rawHtml.includes('window.PlotlyConfig') || rawHtml.includes("define('plotly'");
  const hasGraphDiv = rawHtml.includes('plotly-graph-div') || rawHtml.includes('Plotly.newPlot');
  return hasPlotlyInit && !hasGraphDiv;
}

/**
 * Extracts `{ data, layout, config, frames }` from HTML outputs produced by
 * `fig.show("notebook")`, `fig.to_html()`, or saved notebooks that only stored `text/html`.
 */
export function extractPlotlySpecFromHtml(rawHtml: string): PlotlySpec | null {
  if (!rawHtml || (!rawHtml.includes('Plotly.newPlot') && !rawHtml.includes('Plotly.react'))) {
    return null;
  }

  const callMatch = rawHtml.match(/Plotly\.(?:newPlot|react)\s*\(/);
  if (!callMatch || callMatch.index === undefined) return null;

  const startIdx = callMatch.index + callMatch[0].length;
  const args = extractBalancedArgs(rawHtml, startIdx, 4);
  if (args.length < 2) return null;

  try {
    // arg[0] is the DOM id string, arg[1] is data array, arg[2] is layout, arg[3] is config or frames
    const data = JSON.parse(args[1]);
    const layout = args[2] ? JSON.parse(args[2]) : {};
    let config: Record<string, any> = {};
    let frames: any[] | undefined;

    if (args[3]) {
      const parsed3 = JSON.parse(args[3]);
      if (Array.isArray(parsed3)) {
        frames = parsed3;
      } else if (parsed3 && typeof parsed3 === 'object') {
        config = parsed3;
      }
    }
    return { data, layout, config, ...(frames ? { frames } : {}) };
  } catch {
    return null;
  }
}

function extractBalancedArgs(src: string, fromIdx: number, maxArgs: number): string[] {
  const result: string[] = [];
  let i = fromIdx;
  const len = src.length;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inString: string | null = null;
  let argStart = fromIdx;

  while (i < len && result.length < maxArgs) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch;
      i++;
      continue;
    }

    if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === '(') depthParen++;
    else if (ch === ')') {
      if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
        const lastArg = src.slice(argStart, i).trim();
        if (lastArg) result.push(lastArg);
        break;
      }
      depthParen = Math.max(0, depthParen - 1);
    } else if (ch === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      result.push(src.slice(argStart, i).trim());
      argStart = i + 1;
    }
    i++;
  }

  return result;
}

/**
 * Decodes Plotly 6+ binary typed arrays `{ bdata: "...", dtype: "f8", shape?: "..." }`
 * into standard JavaScript arrays so all Plotly versions render accurately.
 */
function decodePlotlyBinaryArrays(val: any): any {
  if (val === null || val === undefined || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(decodePlotlyBinaryArrays);
  }
  if (typeof val.bdata === 'string' && typeof val.dtype === 'string') {
    try {
      const binStr = window.atob(val.bdata.replace(/\s/g, ''));
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      const buf = bytes.buffer;
      let flat: ArrayLike<number>;
      switch (val.dtype) {
        case 'f8':
          flat = new Float64Array(buf);
          break;
        case 'f4':
          flat = new Float32Array(buf);
          break;
        case 'i4':
          flat = new Int32Array(buf);
          break;
        case 'u4':
          flat = new Uint32Array(buf);
          break;
        case 'i2':
          flat = new Int16Array(buf);
          break;
        case 'u2':
          flat = new Uint16Array(buf);
          break;
        case 'i1':
          flat = new Int8Array(buf);
          break;
        case 'u1':
          flat = bytes;
          break;
        default:
          return val;
      }
      const arr = Array.from(flat);
      if (typeof val.shape === 'string' && val.shape.includes(',')) {
        const dims = val.shape
          .split(',')
          .map((s: string) => parseInt(s.trim(), 10))
          .filter((n: number) => Number.isFinite(n) && n > 0);
        if (dims.length === 2) {
          const [rows, cols] = dims;
          const reshaped: number[][] = [];
          for (let r = 0; r < rows; r++) {
            reshaped.push(arr.slice(r * cols, (r + 1) * cols));
          }
          return reshaped;
        }
      }
      return arr;
    } catch {
      return val;
    }
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(val)) {
    out[k] = decodePlotlyBinaryArrays(v);
  }
  return out;
}

const PlotlyCanvas: React.FC<{
  normalizedSpec: PlotlySpec;
  height?: number | string;
  plotRefOut: React.MutableRefObject<HTMLDivElement | null>;
}> = React.memo(({ normalizedSpec, height, plotRefOut }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const el = containerRef.current;
    if (!el) return;

    let plotlyInstance: any = null;

    loadPlotly()
      .then((Plotly) => {
        if (cancelled || !containerRef.current) return;
        plotlyInstance = Plotly;
        const rawLayout = normalizedSpec.layout || {};
        const layout: Record<string, any> = {
          autosize: true,
          ...rawLayout,
        };
        if (height && typeof height === 'number' && !rawLayout.height) {
          layout.height = height;
        }
        const config: Record<string, any> = {
          responsive: true,
          displaylogo: false,
          ...(normalizedSpec.config || {}),
        };
        const traces = Array.isArray(normalizedSpec.data) ? normalizedSpec.data : [];
        return Plotly.react(containerRef.current, traces, layout, config).then(() => {
          if (
            !cancelled &&
            containerRef.current &&
            Array.isArray(normalizedSpec.frames) &&
            normalizedSpec.frames.length > 0
          ) {
            return Plotly.addFrames(containerRef.current, normalizedSpec.frames);
          }
        });
      })
      .then(() => {
        if (!cancelled) {
          plotRefOut.current = containerRef.current;
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (plotlyInstance && el) {
        try {
          plotlyInstance.purge(el);
        } catch {
          // ignore
        }
      }
      if (plotRefOut.current === el) {
        plotRefOut.current = null;
      }
    };
  }, [normalizedSpec, height, plotRefOut]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        loadPlotly()
          .then((Plotly) => {
            if (containerRef.current && containerRef.current.offsetParent !== null) {
              Plotly.Plots?.resize(containerRef.current);
            }
          })
          .catch(() => {});
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <div className="relative w-full min-h-[260px] bg-white rounded-b-[3px] overflow-hidden">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-xs text-zinc-500 bg-white/90">
          <Loader2 size={15} className="animate-spin" />
          <span>Renderizando gráfico Plotly interativo...</span>
        </div>
      )}
      {errorMsg && (
        <div className="p-3 text-xs text-red-600 bg-red-50">
          Erro ao renderizar gráfico Plotly: {errorMsg}
        </div>
      )}
      <div
        ref={containerRef}
        data-plotly-canvas="true"
        className="w-full"
        style={{
          minHeight: typeof height === 'number' ? `${height}px` : '360px',
          height: typeof height === 'string' ? height : undefined,
        }}
      />
    </div>
  );
});

export const PlotlyOutputView: React.FC<Props> = React.memo(({ spec, outputLimited = false }) => {
  const normalizedSpec = useMemo<PlotlySpec>(() => {
    let parsed: PlotlySpec;
    if (typeof spec === 'string') {
      try {
        parsed = JSON.parse(spec);
      } catch {
        parsed = { data: [], layout: {} };
      }
    } else {
      parsed = spec || { data: [], layout: {} };
    }
    return decodePlotlyBinaryArrays(parsed) as PlotlySpec;
  }, [spec]);

  const plotRef = useRef<HTMLDivElement | null>(null);
  const fullscreenPlotRef = useRef<HTMLDivElement | null>(null);

  const [downloaded, setDownloaded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [modalExpanded, setModalExpanded] = useState(false);

  const chartTitle = useMemo(() => {
    const rawTitle = normalizedSpec.layout?.title;
    if (typeof rawTitle === 'string' && rawTitle.trim()) return rawTitle.trim();
    if (rawTitle && typeof rawTitle === 'object' && typeof rawTitle.text === 'string' && rawTitle.text.trim()) {
      return rawTitle.text.replace(/<[^>]+>/g, '').trim();
    }
    return 'Gráfico Plotly Interativo';
  }, [normalizedSpec]);

  const handleDownloadPng = useCallback(async () => {
    const targetEl = (isFullscreen ? fullscreenPlotRef.current : plotRef.current) || plotRef.current;
    if (!targetEl) return;
    try {
      const Plotly = await loadPlotly();
      const safeName =
        chartTitle
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/gi, '-')
          .replace(/^-+|-+$/g, '') || 'grafico-plotly';
      await Plotly.downloadImage(targetEl, {
        format: 'png',
        width: 1200,
        height: 700,
        scale: 2,
        filename: safeName,
      });
      setDownloaded(true);
      window.setTimeout(() => setDownloaded(false), 1600);
    } catch {
      // ignore
    }
  }, [isFullscreen, chartTitle]);

  const handleResetZoom = useCallback(async () => {
    const targetEl = (isFullscreen ? fullscreenPlotRef.current : plotRef.current) || plotRef.current;
    if (!targetEl) return;
    try {
      const Plotly = await loadPlotly();
      await Plotly.relayout(targetEl, {
        'xaxis.autorange': true,
        'yaxis.autorange': true,
      });
    } catch {
      // ignore
    }
  }, [isFullscreen]);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isFullscreen]);

  const toolbarBtnClass =
    'h-5.5 px-1.5 rounded-[3px] inline-flex items-center justify-center gap-1 text-[11px] transition-colors cursor-pointer hover:bg-[var(--sat-bg-hover)]';

  return (
    <div
      data-plotly-output="true"
      className="sat-plotly-card relative isolate w-full min-w-0 rounded-[4px] border overflow-hidden"
      style={{
        backgroundColor: 'var(--sat-cell-bg)',
        borderColor: 'var(--sat-border)',
      }}
    >
      <div
        className="h-7 px-2.5 flex items-center justify-between gap-2 border-b select-none"
        style={{
          backgroundColor: 'var(--sat-bg-surface)',
          borderColor: 'var(--sat-border)',
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <BarChart3 size={12} className="shrink-0" style={{ color: 'var(--sat-accent)' }} />
          <span
            className="text-[11px] font-medium truncate"
            style={{ color: 'var(--sat-text-secondary)' }}
            title={chartTitle}
          >
            {chartTitle}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleResetZoom}
            className={toolbarBtnClass}
            style={{ color: 'var(--sat-text-muted)' }}
            title="Resetar zoom dos eixos"
            aria-label="Resetar zoom dos eixos"
          >
            <RotateCcw size={11.5} />
          </button>

          <button
            type="button"
            onClick={handleDownloadPng}
            className={toolbarBtnClass}
            style={{
              color: downloaded ? 'var(--sat-green)' : 'var(--sat-text-secondary)',
            }}
            title="Baixar imagem do gráfico (.png)"
            aria-label="Baixar imagem do gráfico"
          >
            {downloaded ? <Check size={12} /> : <Download size={12} />}
            <span className="hidden sm:inline">{downloaded ? 'Baixado' : 'Baixar PNG'}</span>
          </button>

          <button
            type="button"
            onClick={() => setIsFullscreen(true)}
            className={toolbarBtnClass}
            style={{ color: 'var(--sat-text-muted)' }}
            title="Expandir gráfico em tela cheia"
            aria-label="Expandir gráfico"
          >
            <Maximize2 size={12} />
          </button>
        </div>
      </div>

      <PlotlyCanvas
        normalizedSpec={normalizedSpec}
        height={outputLimited ? 280 : undefined}
        plotRefOut={plotRef}
      />

      {isFullscreen &&
        createPortal(
          <div
            data-modal-root="true"
            onClick={() => setIsFullscreen(false)}
            className="fixed inset-0 z-[115] flex items-center justify-center bg-black/65 p-3 sm:p-6"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className={`rounded-[6px] border shadow-2xl flex flex-col overflow-hidden ${
                modalExpanded ? 'w-[96vw] h-[92vh]' : 'w-[88vw] max-w-[1360px] h-[82vh]'
              }`}
              style={{
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
                  <BarChart3 size={14} style={{ color: 'var(--sat-accent)' }} />
                  <span className="font-semibold text-xs truncate">{chartTitle}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleDownloadPng}
                    className="h-7 px-2.5 rounded-[3px] border text-xs inline-flex items-center gap-1.5 cursor-pointer hover:bg-[var(--sat-bg-hover)]"
                    style={{
                      backgroundColor: 'var(--sat-bg-subtle)',
                      borderColor: 'var(--sat-border)',
                      color: downloaded ? 'var(--sat-green)' : 'var(--sat-text-primary)',
                    }}
                  >
                    {downloaded ? <Check size={12} /> : <Download size={12} />}
                    <span>{downloaded ? 'Imagem baixada!' : 'Baixar imagem (.png)'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setModalExpanded((v) => !v)}
                    className="sat-icon-btn p-1"
                    title={modalExpanded ? 'Restaurar tamanho' : 'Maximizar janela'}
                  >
                    {modalExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsFullscreen(false)}
                    className="sat-icon-btn p-1"
                    title="Fechar (Esc)"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-auto bg-white">
                <PlotlyCanvas
                  normalizedSpec={normalizedSpec}
                  height="100%"
                  plotRefOut={fullscreenPlotRef}
                />
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
});
