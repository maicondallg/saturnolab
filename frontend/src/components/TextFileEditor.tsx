import { useShallow } from 'zustand/react/shallow';
import React from 'react';
import { Save } from 'lucide-react';
import { OpenTextFileTab } from '../types/notebook';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { isThemeDark } from '../themes';
import { getFileVisual } from '../utils/fileUtils';
import { FileTypeIcon } from './FileTypeIcon';
import { CodeMirrorCellEditor } from './CodeMirrorCellEditor';

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

  const visual = getFileVisual({ name: tab.name, type: 'file' });
  const darkTheme = isThemeDark(config?.theme);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div
        className="h-9 px-3 flex items-center justify-between border-b shrink-0 select-none"
        style={{
          backgroundColor: 'var(--sat-bg-surface)',
          borderColor: 'var(--sat-border)',
        }}
      >
        <button onClick={() => saveTabById(tab.id)} title="Salvar (Ctrl+S)"
          className="h-7 px-2 rounded-[3px] text-xs flex items-center gap-1.5 hover:bg-[var(--sat-bg-hover)] hover:text-[var(--sat-text-primary)] transition-colors cursor-pointer"
          style={{ color: 'var(--sat-text-secondary)' }}><Save size={13} /><span>Salvar</span></button>
        <div className="flex items-center gap-2 min-w-0">
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
        className="flex-1 min-h-0 overflow-y-auto p-2"
        style={{ backgroundColor: 'var(--sat-bg-canvas)' }}
      >
        <div
          className="min-h-full rounded-[4px] border overflow-hidden"
          style={{
            backgroundColor: 'var(--sat-cell-bg)',
            borderColor: 'var(--sat-border)',
          }}
        >
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
        </div>
      </div>
    </div>
  );
});
