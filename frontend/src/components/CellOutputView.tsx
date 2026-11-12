import React from 'react';
import DOMPurify from 'dompurify';
import { Sparkles } from 'lucide-react';
import { CellOutput } from '../types/notebook';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

interface Props {
  outputs: CellOutput[];
  onFixErrorWithAI: (errorSummary: string) => void;
}

export const CellOutputView: React.FC<Props> = ({ outputs, onFixErrorWithAI }) => {
  if (!outputs || outputs.length === 0) return null;

  return (
    <div
      className="px-3.5 py-2.5 space-y-2 border-t"
      style={{
        backgroundColor: 'var(--sat-bg-canvas)',
        borderColor: 'var(--sat-border)',
      }}
    >
      {outputs.map((out, idx) => {
        if (out.output_type === 'stream') {
          const isErr = out.name === 'stderr';
          return (
            <pre
              key={idx}
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
              key={idx}
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
                  className="h-6.5 px-2.5 rounded-[3px] border text-xs font-medium flex items-center gap-1.5 shrink-0 cursor-pointer"
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

          return (
            <div key={idx} className="overflow-x-auto space-y-2">
              {data['image/png'] && (
                <img
                  src={`data:image/png;base64,${String(data['image/png']).trim()}`}
                  alt="Plot output"
                  className="max-w-full h-auto rounded-[3px] bg-white p-1.5 border"
                  style={{ borderColor: 'var(--sat-border)' }}
                />
              )}

              {!data['image/png'] && data['image/jpeg'] && (
                <img
                  src={`data:image/jpeg;base64,${String(data['image/jpeg']).trim()}`}
                  alt="JPEG output"
                  className="max-w-full h-auto rounded-[3px]"
                />
              )}

              {data['image/svg+xml'] && (
                <div
                  className="bg-white p-1.5 rounded-[3px] inline-block max-w-full overflow-x-auto"
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(String(data['image/svg+xml']), {
                      USE_PROFILES: { svg: true, svgFilters: true },
                    }),
                  }}
                />
              )}

              {data['text/html'] && (
                <div
                  className="jp-rendered-html"
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(String(data['text/html'])),
                  }}
                />
              )}

              {!data['text/html'] &&
                !data['image/png'] &&
                !data['image/jpeg'] &&
                !data['image/svg+xml'] &&
                data['text/plain'] && (
                  <pre className="m-0 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                    {String(data['text/plain'])}
                  </pre>
                )}
            </div>
          );
        }

        return null;
      })}
    </div>
  );
};
