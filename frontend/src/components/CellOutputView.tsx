import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import DOMPurify from 'dompurify';
import {
  Check,
  ChevronsLeftRight,
  Copy,
  Download,
  Loader2,
  Maximize2,
  Minimize2,
  Sparkles,
  X,
} from 'lucide-react';
import { CellOutput } from '../types/notebook';
import { useSaturnoStore } from '../store/useSaturnoStore';
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
  cellSource?: string;
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
        className="group/img relative inline-block max-w-full rounded-[4px] bg-white p-1.5 border"
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

export const CellOutputView: React.FC<Props> = React.memo(
  ({ outputs, onFixErrorWithAI, outputLimited = false, executionCount, cellSource }) => {
    if (!outputs || outputs.length === 0) return null;

    return (
      <div
        className="px-3.5 py-2.5 space-y-2 border-t"
        style={{
          backgroundColor: 'var(--sat-bg-canvas)',
          borderColor: 'var(--sat-border)',
        }}
      >
        {outputs.map((out, idx) => (
          <OutputItem
            key={idx}
            out={out}
            onFixErrorWithAI={onFixErrorWithAI}
            outputLimited={outputLimited}
            executionCount={out.execution_count ?? executionCount ?? null}
            cellSource={cellSource}
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
    cellSource,
  }: {
    out: CellOutput;
    onFixErrorWithAI: Props['onFixErrorWithAI'];
    outputLimited: boolean;
    executionCount: number | null;
    cellSource?: string;
  }) => {
    const [expandedData, setExpandedData] = useState<{
      html?: string | null;
      text?: string | null;
    } | null>(null);
    const [showingExpanded, setShowingExpanded] = useState(false);
    const [expandingFromKernel, setExpandingFromKernel] = useState(false);

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
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      const nbPath = activeTab?.kind === 'notebook' ? activeTab.path : '';
      if (!nbPath) return;

      setExpandingFromKernel(true);
      try {
        const res = await api.expandOutput(nbPath, executionCount, cellSource || '');
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
    }, [showingExpanded, expandedData, executionCount, cellSource]);

    if (out.output_type === 'stream') {
      const isErr = out.name === 'stderr';
      return (
        <pre
          className={`m-0 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words ${
            isErr ? 'text-amber-500 bg-amber-500/10 p-2 rounded-[3px]' : ''
          }`}
        >
          {stripAnsi(out.text || '')}
        </pre>
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
          <pre className="m-0 font-mono text-xs whitespace-pre-wrap leading-relaxed opacity-90">
            {tbText}
          </pre>
        </div>
      );
    }

    if (out.output_type === 'display_data' || out.output_type === 'execute_result') {
      const data = out.data || {};
      const rawHtml = data['text/html'] ? String(data['text/html']) : '';

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

      const plotlySpec =
        data['application/vnd.plotly.v1+json'] ||
        (rawHtml ? extractPlotlySpecFromHtml(rawHtml) : null);

      const effectiveHtml =
        showingExpanded && expandedData?.html ? expandedData.html : rawHtml;
      const rawPlain = data['text/plain'] ? String(data['text/plain']) : '';
      const effectivePlain =
        showingExpanded && expandedData?.text ? expandedData.text : rawPlain;
      const plainHasEllipsis = /\.\.\.|…/.test(rawPlain);

      return (
        <div className="overflow-x-auto space-y-2">
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
              svgHtml={DOMPurify.sanitize(String(data['image/svg+xml']), {
                USE_PROFILES: { svg: true, svgFilters: true },
              })}
              ext="svg"
              alt="SVG output"
            />
          )}

          {!plotlySpec && effectiveHtml && (
            <TableOutputView
              rawHtml={effectiveHtml}
              outputLimited={outputLimited}
              onExpandTruncated={handleExpandFromKernel}
              isExpandingTruncated={expandingFromKernel}
              isExpandedTruncated={showingExpanded}
            />
          )}

          {!plotlySpec &&
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
                <pre className="m-0 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                  {effectivePlain}
                </pre>
              </div>
            )}
        </div>
      );
    }

    return null;
  }
);
