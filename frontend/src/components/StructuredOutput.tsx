import { useState, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

export interface Preview {
  kind: string;
  info?: string;
  value?: string;
  size?: number;
  entries?: [string, Preview][];
}

// Notebook MIME bundles can also come from files created outside Saturno.
export function isPreview(input: unknown): input is Preview {
  let budget = 512;
  function check(value: unknown, depth: number): boolean {
    if (!value || typeof value !== 'object' || --budget < 0 || depth > 5) return false;
    const node = value as Preview;
    if (typeof node.kind !== 'string' || (node.info !== undefined && typeof node.info !== 'string')) return false;
    if (node.entries === undefined) return typeof node.value === 'string';
    return Array.isArray(node.entries) && node.entries.length <= 64 && Number.isSafeInteger(node.size) &&
      node.entries.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && check(pair[1], depth + 1));
  }
  return check(input, 0);
}

function summary(node: Preview) {
  return node.value ?? `${node.kind} (${node.size})`;
}

export function StructuredOutput({ node, formatAction }: { node: Preview; formatAction: ReactNode }) {
  const [path, setPath] = useState<number[]>([]);
  let current = node;
  const labels: string[] = [];
  for (const index of path) {
    const entry = current.entries?.[index];
    if (!entry) break;
    labels.push(entry[0]);
    current = entry[1];
  }
  const entries = current.entries ?? [];
  const matrix = ['list', 'tuple', 'ndarray'].includes(current.kind) && entries.length > 0 &&
    entries.every(([, row]) => ['list', 'tuple', 'ndarray'].includes(row.kind) && row.entries !== undefined);
  const columns = matrix ? Math.max(...entries.map(([, row]) => row.entries!.length)) : 0;
  const valueButton = (child: Preview, next: number[]) => (
    <button type="button" className="block w-full truncate text-left cursor-pointer hover:underline"
      title={summary(child)} onClick={() => setPath(next)}>{summary(child) || '""'}</button>
  );
  return <section className="rounded border border-[var(--sat-border)] text-xs overflow-hidden">
    <header className="sat-preview-header">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {labels.length > 0 && <button type="button" className="sat-preview-back border border-[var(--sat-border)]"
          title="Voltar um nível" aria-label="Voltar um nível" onClick={() => setPath(path.slice(0, -1))}>
          <ChevronLeft size={15} /> Voltar
        </button>}
        <strong>{node.kind}</strong>
        {labels.length > 0 && <>
          <code className="truncate" title={labels.join(' › ')}>{labels.map(label => `[${label}]`).join('')}</code>
          <span className="text-[var(--sat-text-muted)]">{current.kind}</span>
        </>}
        {current.info && <span>{current.info}</span>}
        {current.size !== undefined && <span className="text-[var(--sat-text-muted)]">{current.size.toLocaleString('pt-BR')} itens</span>}
      </div>
      {formatAction}
    </header>
    {current.value !== undefined ? <pre className="p-2 whitespace-pre-wrap break-words">{current.value || '""'}</pre> :
      <div className="overflow-auto max-h-[50vh]"><table className="sat-preview-grid" style={{ minWidth: matrix ? `${columns * 6 + 5}rem` : undefined }}>
        <colgroup><col className={current.kind === 'dict' ? 'sat-preview-key' : 'sat-preview-index'} />
          {Array.from({ length: matrix ? columns : 1 }, (_, i) => <col key={i} />)}
        </colgroup>
        <thead><tr><th>{current.kind === 'dict' ? 'Chave' : 'Índice'}</th>
          {matrix ? Array.from({ length: columns }, (_, i) => <th key={i}>{i}</th>) : <th>Valor</th>}</tr></thead>
        <tbody>{entries.map(([key, child], i) => <tr key={i}><th title={key}>{key}</th>
          {matrix ? child.entries!.map(([, item], j) => <td key={j}>{valueButton(item, [...path, i, j])}</td>)
            : <td>{valueButton(child, [...path, i])}</td>}</tr>)}</tbody>
      </table></div>}
    {(entries.length < (current.size ?? 0) || (matrix && entries.some(([, row]) => row.entries!.length < row.size!))) &&
      <p className="px-3 py-1">Prévia parcial · {entries.length} de {current.size} itens</p>}
  </section>;
}
