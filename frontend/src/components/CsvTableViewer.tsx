import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ParsedCsv } from '../utils/csvParser';
import { registerEditorFlusher } from '../services/editorViews';

interface Props {
  parsed: ParsedCsv;
  onCellChange?: (rowIndex: number, colIndex: number, value: string, isHeader?: boolean) => void;
  onSave?: () => void;
}

interface EditingTarget {
  row: number;
  col: number;
  isHeader?: boolean;
}

const INITIAL_VISIBLE_ROWS = 500;
const LOAD_MORE_STEP = 1000;

export const CsvTableViewer: React.FC<Props> = React.memo(({ parsed, onCellChange, onSave }) => {
  const flusherId = useId();
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_ROWS);
  const [editing, setEditing] = useState<EditingTarget | null>(null);
  const [draft, setDraft] = useState('');

  const { headers, rows } = parsed;

  const visibleRows = useMemo(
    () => (rows.length > visibleLimit ? rows.slice(0, visibleLimit) : rows),
    [rows, visibleLimit]
  );

  const commitEdit = useCallback(() => {
    if (!editing || !onCellChange) {
      setEditing(null);
      return;
    }
    const prevValue = editing.isHeader
      ? headers[editing.col] ?? ''
      : rows[editing.row]?.[editing.col] ?? '';
    if (draft !== prevValue) {
      onCellChange(editing.row, editing.col, draft, editing.isHeader);
    }
    setEditing(null);
  }, [editing, onCellChange, headers, rows, draft]);

  useEffect(() => {
    if (!editing) return;
    return registerEditorFlusher(`csv_table_${flusherId}`, commitEdit);
  }, [editing, commitEdit, flusherId]);

  if (headers.length === 0) {
    return (
      <div
        className="h-full flex items-center justify-center text-xs font-mono"
        style={{ color: 'var(--sat-text-muted)' }}
      >
        Arquivo CSV vazio
      </div>
    );
  }

  const startEdit = (row: number, col: number, currentValue: string, isHeader = false) => {
    if (!onCellChange) return;
    setEditing({ row, col, isHeader });
    setDraft(currentValue);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      commitEdit();
      onSave?.();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(null);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const current = editing;
      commitEdit();
      if (current && !current.isHeader && current.row + 1 < visibleRows.length) {
        const nextRow = current.row + 1;
        startEdit(nextRow, current.col, rows[nextRow]?.[current.col] ?? '');
      }
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const current = editing;
      commitEdit();
      if (!current) return;
      const nextCol = e.shiftKey ? current.col - 1 : current.col + 1;
      if (nextCol >= 0 && nextCol < headers.length) {
        const nextVal = current.isHeader
          ? headers[nextCol] ?? ''
          : rows[current.row]?.[nextCol] ?? '';
        startEdit(current.row, nextCol, nextVal, current.isHeader);
      }
    }
  };

  const handleContainerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      commitEdit();
      onSave?.();
    }
  };

  const hasMore = rows.length > visibleRows.length;

  return (
    <div className="h-full flex flex-col overflow-hidden isolate" onKeyDown={handleContainerKeyDown}>
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-max min-w-full border-collapse text-[13px] font-mono">
          <thead className="sticky top-0 z-10">
            <tr
              style={{
                backgroundColor: 'var(--sat-bg-subtle)',
                borderBottom: '1px solid var(--sat-border)',
              }}
            >
              <th
                className="px-3 py-1.5 text-right font-medium select-none sticky left-0 z-20"
                style={{
                  backgroundColor: 'var(--sat-bg-subtle)',
                  color: 'var(--sat-text-muted)',
                  borderRight: '1px solid var(--sat-border)',
                  borderBottom: '1px solid var(--sat-border)',
                  minWidth: '48px',
                }}
              >
                #
              </th>
              {headers.map((header, colIdx) => {
                const isEditingCell = editing?.isHeader && editing.col === colIdx;
                return (
                  <th
                    key={colIdx}
                    title={isEditingCell ? undefined : header}
                    onClick={() => !isEditingCell && startEdit(0, colIdx, header, true)}
                    className={`px-3 py-1.5 text-left font-semibold whitespace-nowrap max-w-[320px] ${
                      isEditingCell ? 'p-0' : 'truncate'
                    } ${onCellChange ? 'cursor-text' : ''}`}
                    style={{
                      color: 'var(--sat-text-primary)',
                      borderRight: '1px solid var(--sat-border-subtle)',
                      borderBottom: '1px solid var(--sat-border)',
                    }}
                  >
                    {isEditingCell ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={handleInputKeyDown}
                        className="w-full min-w-[100px] px-3 py-1.5 bg-[var(--sat-cell-bg)] text-[var(--sat-text-primary)] outline-none ring-1 ring-inset ring-[var(--sat-accent)] font-semibold"
                      />
                    ) : (
                      header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className="transition-colors hover:bg-[var(--sat-accent-soft)]"
                style={{
                  backgroundColor: rowIdx % 2 === 1 ? 'rgba(128, 128, 128, 0.04)' : 'transparent',
                  borderBottom: '1px solid var(--sat-border-subtle)',
                }}
              >
                <td
                  className="px-3 py-1 text-right select-none tabular-nums sticky left-0"
                  style={{
                    backgroundColor: 'var(--sat-cell-bg)',
                    color: 'var(--sat-text-muted)',
                    borderRight: '1px solid var(--sat-border)',
                  }}
                >
                  {rowIdx + 1}
                </td>
                {row.map((cell, colIdx) => {
                  const isEditingCell =
                    editing && !editing.isHeader && editing.row === rowIdx && editing.col === colIdx;
                  return (
                    <td
                      key={colIdx}
                      title={isEditingCell ? undefined : cell}
                      onClick={() => !isEditingCell && startEdit(rowIdx, colIdx, cell)}
                      className={`text-left whitespace-nowrap max-w-[320px] tabular-nums ${
                        isEditingCell ? 'p-0' : 'px-3 py-1 truncate'
                      } ${onCellChange ? 'cursor-text' : ''}`}
                      style={{
                        color: cell === '' ? 'var(--sat-text-muted)' : 'var(--sat-text-primary)',
                        borderRight: '1px solid var(--sat-border-subtle)',
                      }}
                    >
                      {isEditingCell ? (
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={handleInputKeyDown}
                          className="w-full min-w-[100px] px-3 py-1 bg-[var(--sat-cell-bg)] text-[var(--sat-text-primary)] outline-none ring-1 ring-inset ring-[var(--sat-accent)]"
                        />
                      ) : cell === '' ? (
                        '—'
                      ) : (
                        cell
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div
          className="px-3 py-1.5 flex items-center justify-between text-xs border-t shrink-0"
          style={{
            backgroundColor: 'var(--sat-bg-surface)',
            borderColor: 'var(--sat-border)',
            color: 'var(--sat-text-secondary)',
          }}
        >
          <span>
            Mostrando {visibleRows.length.toLocaleString('pt-BR')} de{' '}
            {rows.length.toLocaleString('pt-BR')} linhas
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setVisibleLimit((prev) => prev + LOAD_MORE_STEP)}
              className="px-2 py-0.5 rounded-[3px] hover:bg-[var(--sat-bg-hover)] transition-colors cursor-pointer"
              style={{ color: 'var(--sat-accent)' }}
            >
              Mostrar +{LOAD_MORE_STEP.toLocaleString('pt-BR')}
            </button>
            <button
              onClick={() => setVisibleLimit(rows.length)}
              className="px-2 py-0.5 rounded-[3px] hover:bg-[var(--sat-bg-hover)] transition-colors cursor-pointer"
              style={{ color: 'var(--sat-text-primary)' }}
            >
              Mostrar tudo
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
