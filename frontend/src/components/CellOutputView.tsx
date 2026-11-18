import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DOMPurify from 'dompurify';
import {
  Check,
  FileText,
  Table2,
  ChevronsLeftRight,
  Copy,
  Download,
  Loader2,
  Maximize2,
  Minimize2,
  Sparkles,
  X,
} from 'lucide-react';
import { StructuredOutput, isPreview } from './StructuredOutput';
import { CellOutput } from '../types/notebook';
import { useSaturnoStore, findNotebookTabForCell } from '../store/useSaturnoStore';
import { api } from '../services/api';
import { TableOutputView } from './TableOutputView';
import {
  extractPlotlySpecFromHtml,
  isPlotlyLoaderOnlyHtml,
  PlotlyOutputView,
} from './PlotlyOutputView';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

interface Props {
  outputs: CellOutput[];
  onFixErrorWithAI: (errorSummary: string) => void;
  outputLimited?: boolean;
  cellId?: string;
  executionCount?: number | null;
}

function triggerDataUrlDownload(dataUrl: string, filename: string) {
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx !== -1 && dataUrl.startsWith('data:')) {
      const header = dataUrl.slice(5, commaIdx);
      const isBase64 = header.includes(';base64');
      const mime = header.split(';')[0] || 'application/octet-stream';
      const payload = dataUrl.slice(commaIdx + 1);
      let blob: Blob;
      if (isBase64) {
        const binStr = window.atob(payload.replace(/\s/g, ''));
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) {
          bytes[i] = binStr.charCodeAt(i);
        }
        blob = new Blob([bytes], { type: mime });
      } else {
        blob = new Blob([decodeURIComponent(payload)], { type: mime });
      }
      const objUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objUrl;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(objUrl), 2000);
      return;
    }
  } catch {
    // Fallback below
  }
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function copyImageDataUrlToClipboard(dataUrl: string): Promise<boolean> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    return false;
  }
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    if (blob.type === 'image/png') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    }
    // Convert JPEG/SVG to PNG on canvas for universal clipboard support
    const img = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image load failed'));
    });
    img.src = dataUrl;
    await loaded;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width || 800;
    canvas.height = img.naturalHeight || img.height || 600;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const pngBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png')
    );
    if (!pngBlob) return false;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    return true;
  } catch {
    return false;
  }
}

const ImageOutputCard: React.FC<{
  src: string;
  svgHtml?: string;
  ext: 'png' | 'jpg' | 'svg';
  alt: string;
}> = React.memo(({ src, svgHtml, ext, alt }) => {
  const [downloaded, setDownloaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    if (!lightboxOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setLightboxOpen(false);
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [lightboxOpen]);

  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const filename = `grafico-saturno.${ext}`;
      triggerDataUrlDownload(src, filename);
      setDownloaded(true);
      window.setTimeout(() => setDownloaded(false), 1500);
    },
    [src, ext]
  );

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      const ok = await copyImageDataUrlToClipboard(src);
      if (ok) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }
    },
    [src]
  );

  return (
    <>
      <div
        data-image-output="true"
        className="group/img relative isolate inline-block min-w-36 min-h-12 max-w-full rounded-[4px] bg-white p-1.5 border"
        style={{ borderColor: 'var(--sat-border)' }}
      >
        {/* Top-Right Hover Action Bar for Image Download / Copy / Expand */}
        <div
          className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1 px-1.5 py-1 rounded-[4px] border shadow-md opacity-0 group-hover/img:opacity-100 focus-within:opacity-100 transition-opacity"
          style={{
            backgroundColor: 'var(--sat-bg-surface)',
            borderColor: 'var(--sat-border)',
            color: 'var(--sat-text-primary)',
          }}
        >
          <button
            type="button"
            onClick={handleDownload}
            className="h-6 px-2 rounded-[3px] text-[11px] font-medium inline-flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] cursor-pointer transition-colors"
            style={{
              color: downloaded ? 'var(--sat-green)' : 'var(--sat-text-primary)',
            }}
            title={`Baixar imagem (.${ext})`}
            aria-label="Baixar imagem"
          >
            {downloaded ? <Check size={12} /> : <Download size={12} />}
            <span>{downloaded ? 'Baixada' : 'Baixar'}</span>
          </button>

          <button
            type="button"
            onClick={handleCopy}
            className="h-6 px-1.5 rounded-[3px] text-[11px] inline-flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] cursor-pointer transition-colors"
            style={{
              color: copied ? 'var(--sat-green)' : 'var(--sat-text-secondary)',
            }}
            title="Copiar imagem para a área de transferência"
            aria-label="Copiar imagem"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setLightboxOpen(true);
            }}
            className="h-6 px-1.5 rounded-[3px] text-[11px] inline-flex items-center gap-1 hover:bg-[var(--sat-bg-hover)] cursor-pointer transition-colors"
            style={{ color: 'var(--sat-text-secondary)' }}
            title="Ampliar imagem"
            aria-label="Ampliar imagem"
          >
            <Maximize2 size={12} />
          </button>
        </div>

        {svgHtml ? (
          <div
            className="max-w-full overflow-x-auto"
            dangerouslySetInnerHTML={{ __html: svgHtml }}
          />
        ) : (
          <img
            src={src}
            alt={alt}
            onDoubleClick={() => setLightboxOpen(true)}
            className="max-w-full h-auto block rounded-[2px]"
          />
        )}
      </div>

      {lightboxOpen &&
        createPortal(
          <div
            data-modal-root="true"
            onClick={() => setLightboxOpen(false)}
            className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-4"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="max-w-[95vw] max-h-[92vh] rounded-[6px] border shadow-2xl flex flex-col overflow-hidden"
              style={{
                backgroundColor: 'var(--sat-bg-surface)',
                borderColor: 'var(--sat-border)',
                color: 'var(--sat-text-primary)',
              }}
            >
              <div
                className="h-10 px-3 flex items-center justify-between gap-4 border-b shrink-0"
                style={{ borderColor: 'var(--sat-border)' }}
              >
                <span className="text-xs font-semibold">Visualização da Imagem (.{ext})</span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleDownload}
                    className="h-7 px-2.5 rounded-[3px] border text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--sat-bg-hover)] cursor-pointer"
                    style={{
                      backgroundColor: 'var(--sat-bg-subtle)',
                      borderColor: 'var(--sat-border)',
                      color: downloaded ? 'var(--sat-green)' : 'var(--sat-text-primary)',
                    }}
                  >
                    {downloaded ? <Check size={13} /> : <Download size={13} />}
                    <span>{downloaded ? 'Imagem baixada!' : `Baixar imagem (.${ext})`}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="h-7 px-2.5 rounded-[3px] border text-xs inline-flex items-center gap-1.5 hover:bg-[var(--sat-bg-hover)] cursor-pointer"
                    style={{
                      backgroundColor: 'var(--sat-bg-subtle)',
                      borderColor: 'var(--sat-border)',
                      color: copied ? 'var(--sat-green)' : 'var(--sat-text-secondary)',
                    }}
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    <span>{copied ? 'Copiada!' : 'Copiar'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLightboxOpen(false)}
                    className="sat-icon-btn p-1"
                    title="Fechar"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
              <div className="p-4 overflow-auto bg-white flex items-center justify-center">
                {svgHtml ? (
                  <div dangerouslySetInnerHTML={{ __html: svgHtml }} />
                ) : (
                  <img src={src} alt={alt} className="max-w-full max-h-[80vh] object-contain" />
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
});

function PageControls({ page, count, change }: { page: number; count: number; change: (page: number) => void }) {
  if (count <= 1) return null;
  return <nav aria-label="Páginas da saída" className="flex items-center gap-3 text-xs py-1">
    <button disabled={!page} onClick={() => change(page - 1)}>← Anterior</button>
    <span>{page + 1} / {count}</span>
    <button disabled={page + 1 >= count} onClick={() => change(page + 1)}>Próxima →</button>
  </nav>;
}

function TextOutput({ text, className = '', ansi = false }: { text: string; className?: string; ansi?: boolean }) {
  const [requested, change] = useState(0);
  const count = Math.max(1, Math.ceil(text.length / 16384));
  const page = Math.min(requested, count - 1);
  const chunk = text.slice(page * 16384, (page + 1) * 16384);
  return <div><PageControls page={page} count={count} change={change} />
    <pre className={`m-0 overflow-auto whitespace-pre font-mono text-[13px] leading-relaxed ${className}`}>{ansi ? stripAnsi(chunk) : chunk}</pre>
  </div>;
}

export const CellOutputView: React.FC<Props> = React.memo(
  ({ outputs, onFixErrorWithAI, outputLimited = false, cellId, executionCount }) => {
    const [requested, change] = useState(0);
    const count = Math.ceil(outputs.length / 64);
    const page = Math.min(requested, Math.max(0, count - 1));
    if (!outputs || outputs.length === 0) return null;

    return (
      <div
        className="px-3.5 py-2.5 space-y-2"
        style={{
          backgroundColor: 'var(--sat-bg-canvas)',
        }}
      >
        <PageControls page={page} count={count} change={change} />
        {outputs.slice(page * 64, (page + 1) * 64).map((out, idx) => (
          <OutputItem
            key={page * 64 + idx}
            out={out}
            onFixErrorWithAI={onFixErrorWithAI}
            outputLimited={outputLimited}
            executionCount={out.execution_count ?? executionCount ?? null}
            cellId={cellId}
          />
        ))}
      </div>
    );
  }
);

const OutputItem = React.memo(
  ({
    out,
    onFixErrorWithAI,
    outputLimited,
    executionCount,
    cellId,
  }: {
    out: CellOutput;
    onFixErrorWithAI: Props['onFixErrorWithAI'];
    outputLimited: boolean;
    executionCount: number | null;
    cellId?: string;
  }) => {
    const [expandedData, setExpandedData] = useState<{
      html?: string | null;
      text?: string | null;
    } | null>(null);
    const [showingExpanded, setShowingExpanded] = useState(false);
    const [expandingFromKernel, setExpandingFromKernel] = useState(false);

    useEffect(() => {
      setExpandedData(null);
      setShowingExpanded(false);
    }, [out]);

    const originalDefault = useSaturnoStore(s => s.config?.output_format === 'original');
    const [originalOverride, setOriginal] = useState<boolean>();
    const original = originalOverride ?? originalDefault;
    const rawData = out.data;
    const candidate = rawData?.['application/vnd.saturno.preview+json'];
    const preview = useMemo(() => isPreview(candidate) ? candidate : undefined, [candidate]);
    const rawHtmlForMemo = rawData?.['text/html'] ? String(rawData['text/html']) : '';
    const explicitPlotlySpec = rawData?.['application/vnd.plotly.v1+json'];
    const plotlySpec = useMemo(
      () =>
        explicitPlotlySpec || (rawHtmlForMemo ? extractPlotlySpecFromHtml(rawHtmlForMemo) : null),
      [explicitPlotlySpec, rawHtmlForMemo]
    );
    const rawSvg = rawData?.['image/svg+xml'];
    const sanitizedSvgHtml = useMemo(
      () =>
        rawSvg
          ? DOMPurify.sanitize(String(rawSvg), {
              USE_PROFILES: { svg: true, svgFilters: true },
            })
          : '',
      [rawSvg]
    );

    const handleExpandFromKernel = useCallback(async () => {
      if (showingExpanded) {
        setShowingExpanded(false);
        return;
      }
      if (expandedData) {
        setShowingExpanded(true);
        return;
      }
      const state = useSaturnoStore.getState();
      const activeTab = findNotebookTabForCell(state.tabs, state.activeTabId, cellId);
      const nbPath = activeTab?.kind === 'notebook' ? activeTab.path : '';
      if (!nbPath) return;
      const latestSource =
        activeTab?.kind === 'notebook'
          ? activeTab.cells.find((c) => c.id === cellId)?.source || ''
          : '';

      setExpandingFromKernel(true);
      try {
        const res = await api.expandOutput(nbPath, executionCount, latestSource);
        if (res.found && (res['text/html'] || res['text/plain'])) {
          setExpandedData({
            html: res['text/html'],
            text: res['text/plain'],
          });
          setShowingExpanded(true);
        }
      } catch {
        // ignore if kernel not running
      } finally {
        setExpandingFromKernel(false);
      }
    }, [showingExpanded, expandedData, executionCount, cellId]);

    if (out.output_type === 'stream') {
      const isErr = out.name === 'stderr';
      return (
        <TextOutput text={out.text || ''} ansi className={isErr ? 'text-amber-500 bg-amber-500/10 p-2 rounded' : ''} />
      );
    }

    if (out.output_type === 'error') {
      const tbText =
        stripAnsi((out.traceback || []).join('\n')) || `${out.ename}: ${out.evalue}`;
      return (
        <div
          className="p-3 rounded-[3px] border space-y-2 overflow-x-auto"
          style={{
            backgroundColor: 'var(--sat-error-bg)',
            borderColor: 'var(--sat-error-border)',
            color: 'var(--sat-error-text)',
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono font-semibold text-xs">
              {out.ename}: {out.evalue}
            </span>
            <button
              type="button"
              onClick={() => onFixErrorWithAI(tbText)}
              className="h-6.5 px-2.5 rounded-[3px] border text-xs font-medium flex items-center gap-1.5 shrink-0 hover:bg-[var(--sat-bg-hover)] transition-colors cursor-pointer"
              style={{
                backgroundColor: 'var(--sat-bg-surface)',
                borderColor: 'var(--sat-border)',
                color: 'var(--sat-text-primary)',
              }}
            >
              <Sparkles size={12} style={{ color: 'var(--sat-accent)' }} />
              <span>Corrigir com IA</span>
            </button>
          </div>
          <TextOutput text={tbText} className="text-xs opacity-90" />
        </div>
      );
    }

    if (out.output_type === 'display_data' || out.output_type === 'execute_result') {
      const data = out.data || {};
      const rawHtml = rawHtmlForMemo;

      // Skip standalone RequireJS loader script block emitted by Plotly's legacy notebook renderer
      if (
        rawHtml &&
        !data['application/vnd.plotly.v1+json'] &&
        !data['image/png'] &&
        !data['image/jpeg'] &&
        !data['image/svg+xml'] &&
        isPlotlyLoaderOnlyHtml(rawHtml)
      ) {
        return null;
      }

      const effectiveHtml =
        showingExpanded && expandedData?.html ? expandedData.html : rawHtml;
      const plain = data['text/plain'];
      const rawPlain = Array.isArray(plain) ? plain.join('') : String(plain ?? '');
      const effectivePlain =
        showingExpanded && expandedData?.text ? expandedData.text : rawPlain;
      const plainHasEllipsis = /\.\.\.|…/.test(rawPlain);

      const canToggle = typeof plain !== 'undefined' && (preview || /<table[\s>]/i.test(effectiveHtml)) &&
        !plotlySpec && !data['image/png'] && !data['image/jpeg'] && !data['image/svg+xml'];
      const structured = canToggle && preview && !original;
      const raw = canToggle && original;
      const toggleLabel = original ? 'Ver formatado' : 'Ver texto original';
      const formatAction = canToggle && (
        <button type="button" className="sat-output-action" title={toggleLabel}
          aria-label={toggleLabel} aria-pressed={original} onClick={() => setOriginal(!original)}>
          {original ? <Table2 size={14} /> : <FileText size={14} />}
        </button>
      );
      return (
        <div className="overflow-x-auto space-y-2">
          {raw && <section className="rounded border border-[var(--sat-border)]">
            <header className="sat-preview-header"><strong>Texto original</strong>{formatAction}</header>
            <div className="px-2 py-1"><TextOutput text={rawPlain} /></div>
          </section>}
          {structured && <StructuredOutput node={preview} formatAction={formatAction} />}
          {plotlySpec && (
            <PlotlyOutputView spec={plotlySpec} outputLimited={outputLimited} />
          )}

          {data['image/png'] && (
            <ImageOutputCard
              src={`data:image/png;base64,${String(data['image/png']).trim()}`}
              ext="png"
              alt="Plot output"
            />
          )}

          {!data['image/png'] && data['image/jpeg'] && (
            <ImageOutputCard
              src={`data:image/jpeg;base64,${String(data['image/jpeg']).trim()}`}
              ext="jpg"
              alt="JPEG output"
            />
          )}

          {data['image/svg+xml'] && (
            <ImageOutputCard
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(
                String(data['image/svg+xml'])
              )}`}
              svgHtml={sanitizedSvgHtml}
              ext="svg"
              alt="SVG output"
            />
          )}

          {!raw && !structured && !plotlySpec && effectiveHtml && (
            <TableOutputView
              formatAction={formatAction}
              rawHtml={effectiveHtml}
              outputLimited={outputLimited}
              onExpandTruncated={handleExpandFromKernel}
              isExpandingTruncated={expandingFromKernel}
              isExpandedTruncated={showingExpanded}
            />
          )}

          {!raw && !structured && !plotlySpec &&
            !effectiveHtml &&
            !data['image/png'] &&
            !data['image/jpeg'] &&
            !data['image/svg+xml'] &&
            effectivePlain && (
              <div className="relative group/plain">
                {(plainHasEllipsis || showingExpanded) && (
                  <div className="flex justify-end mb-1">
                    <button
                      type="button"
                      onClick={handleExpandFromKernel}
                      disabled={expandingFromKernel}
                      className="h-6 px-2 rounded-[3px] border text-[11px] font-medium inline-flex items-center gap-1.5 hover:bg-[var(--sat-bg-hover)] cursor-pointer transition-colors"
                      style={{
                        backgroundColor: showingExpanded
                          ? 'var(--sat-accent-soft)'
                          : 'var(--sat-bg-surface)',
                        borderColor: showingExpanded
                          ? 'var(--sat-accent)'
                          : 'var(--sat-border)',
                        color: showingExpanded
                          ? 'var(--sat-accent)'
                          : 'var(--sat-text-secondary)',
                      }}
                      title={
                        showingExpanded
                          ? 'Voltar para visualização resumida'
                          : 'Expandir campos cortados com ... para ver o texto completo'
                      }
                    >
                      {expandingFromKernel ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : showingExpanded ? (
                        <Minimize2 size={11} />
                      ) : (
                        <ChevronsLeftRight size={12} />
                      )}
                      <span>
                        {showingExpanded
                          ? 'Recolher campos expandidos'
                          : 'Expandir campos (...)'}
                      </span>
                    </button>
                  </div>
                )}
                <TextOutput text={effectivePlain} />
              </div>
            )}
        </div>
      );
    }

    return null;
  }
);
