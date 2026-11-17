import { useShallow } from 'zustand/react/shallow';
import React, { useCallback, useMemo, useState } from 'react';
import { Code2, Save, Table2 } from 'lucide-react';
import { OpenTextFileTab } from '../types/notebook';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { isThemeDark } from '../themes';
import { getFileVisual } from '../utils/fileUtils';
import { parseCsv, serializeCsv } from '../utils/csvParser';
import { FileTypeIcon } from './FileTypeIcon';
import { CodeMirrorCellEditor } from './CodeMirrorCellEditor';
import { CsvTableViewer } from './CsvTableViewer';

interface Props {
  tab: OpenTextFileTab;
}

export const TextFileEditor: React.FC<Props> = React.memo(({ tab }) => {
  const { updateTextFileContent, saveTabById, config, showLineNumbers } = useSaturnoStore(useShallow((s) => ({
    updateTextFileContent: s.updateTextFileContent,
    saveTabById: s.saveTabById,
    config: s.config,
    showLineNumbers: s.showLineNumbers,
  })));

  const lowerName = tab.name.toLowerCase();
  const isCsv = lowerName.endsWith('.csv');
  const isTsv = lowerName.endsWith('.tsv');
  const isTabular = isCsv || isTsv;

  const [viewMode, setViewMode] = useState<'table' | 'text'>(isTabular ? 'table' : 'text');

  const parsedCsv = useMemo(() => {
    if (!isTabular || viewMode !== 'table') return null;
    return parseCsv(tab.content, isTsv ? '\t' : undefined);
  }, [isTabular, isTsv, viewMode, tab.content]);

  const visual = getFileVisual({ name: tab.name, type: 'file' });
  const darkTheme = isThemeDark(config?.theme);
  const showingTable = isTabular && viewMode === 'table' && parsedCsv !== null;

  const handleCsvCellChange = useCallback(
    (rowIndex: number, colIndex: number, value: string, isHeader?: boolean) => {
      if (!parsedCsv) return;
      if (isHeader) {
        const nextHeaders = parsedCsv.headers.map((h, i) => (i === colIndex ? value : h));
        updateTextFileContent(tab.id, serializeCsv(nextHeaders, parsedCsv.rows, parsedCsv.delimiter));
      } else {
        const nextRows = parsedCsv.rows.map((row, rIdx) =>
          rIdx === rowIndex ? row.map((cell, cIdx) => (cIdx === colIndex ? value : cell)) : row
        );
        updateTextFileContent(tab.id, serializeCsv(parsedCsv.headers, nextRows, parsedCsv.delimiter));
      }
    },
    [parsedCsv, tab.id, updateTextFileContent]
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div
        className="h-9 px-3 flex items-center justify-between border-b shrink-0 select-none"
        style={{
          backgroundColor: 'var(--sat-bg-surface)',
          borderColor: 'var(--sat-border)',
        }}
      >
        <div className="flex items-center gap-2">
          <button onClick={() => saveTabById(tab.id)} title="Salvar (Ctrl+S)"
            className="h-7 px-2 rounded-[3px] text-xs flex items-center gap-1.5 hover:bg-[var(--sat-bg-hover)] hover:text-[var(--sat-text-primary)] transition-colors cursor-pointer"
            style={{ color: 'var(--sat-text-secondary)' }}><Save size={13} /><span>Salvar</span></button>

          {isTabular && (
            <div
              className="flex items-center rounded-[4px] p-0.5 border"
              style={{
                backgroundColor: 'var(--sat-bg-canvas)',
                borderColor: 'var(--sat-border)',
              }}
            >
              <button
                onClick={() => setViewMode('table')}
                className="h-6 px-2 rounded-[3px] text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                style={{
                  backgroundColor: viewMode === 'table' ? 'var(--sat-bg-hover)' : 'transparent',
                  color: viewMode === 'table' ? 'var(--sat-text-primary)' : 'var(--sat-text-secondary)',
                }}
                title="Visualizar como tabela"
              >
                <Table2 size={13} />
                <span>Tabela</span>
              </button>
              <button
                onClick={() => setViewMode('text')}
                className="h-6 px-2 rounded-[3px] text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                style={{
                  backgroundColor: viewMode === 'text' ? 'var(--sat-bg-hover)' : 'transparent',
                  color: viewMode === 'text' ? 'var(--sat-text-primary)' : 'var(--sat-text-secondary)',
                }}
                title="Editar como texto"
              >
                <Code2 size={13} />
                <span>Texto</span>
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 min-w-0">
          {isTabular && parsedCsv && parsedCsv.headers.length > 0 && (
            <span
              className="text-[11px] font-mono px-1.5 py-0.5 rounded-[2px] shrink-0"
              style={{
                backgroundColor: 'var(--sat-bg-subtle)',
                color: 'var(--sat-text-muted)',
              }}
            >
              {parsedCsv.rows.length.toLocaleString('pt-BR')} × {parsedCsv.headers.length}
            </span>
          )}
          <FileTypeIcon name={tab.name} type="file" size={14} />
          <span
            className="font-mono text-xs truncate"
            style={{ color: 'var(--sat-text-secondary)' }}
          >
            {tab.path}
          </span>
          {tab.dirty && (
            <span
              className="text-[11px] font-mono px-1.5 py-0.5 rounded-[2px]"
              style={{
                backgroundColor: 'var(--sat-accent-soft)',
                color: 'var(--sat-accent)',
              }}
            >
              modificado
            </span>
          )}
        </div>
      </div>

      <div
        className={`flex-1 min-h-0 p-2 ${showingTable ? 'overflow-hidden' : 'overflow-y-auto'}`}
        style={{ backgroundColor: 'var(--sat-bg-canvas)' }}
      >
        <div
          className={`${showingTable ? 'h-full' : 'min-h-full'} rounded-[4px] border overflow-hidden`}
          style={{
            backgroundColor: 'var(--sat-cell-bg)',
            borderColor: 'var(--sat-border)',
          }}
        >
          {showingTable ? (
            <CsvTableViewer
              parsed={parsedCsv}
              onCellChange={handleCsvCellChange}
              onSave={() => saveTabById(tab.id)}
            />
          ) : (
            <CodeMirrorCellEditor
              value={tab.content}
              language={visual.cmLanguage}
              theme={darkTheme ? 'dark' : 'light'}
              showLineNumbers={showLineNumbers}
              fullHeight
              placeholder={`Editar ${tab.name}...`}
              onChange={(val) => updateTextFileContent(tab.id, val)}
              onSave={() => saveTabById(tab.id)}
            />
          )}
        </div>
      </div>
    </div>
  );
});
