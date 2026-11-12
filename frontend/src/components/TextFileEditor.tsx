import React from 'react';
import { Save } from 'lucide-react';
import { OpenTextFileTab } from '../types/notebook';
import { useSaturnoStore } from '../store/useSaturnoStore';

interface Props {
  tab: OpenTextFileTab;
}

export const TextFileEditor: React.FC<Props> = ({ tab }) => {
  const { updateTextFileContent, saveActiveTab } = useSaturnoStore();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div
        className="h-9 px-3 flex items-center justify-between border-b shrink-0"
        style={{
          backgroundColor: 'var(--sat-bg-surface)',
          borderColor: 'var(--sat-border)',
        }}
      >
        <span className="font-mono text-xs" style={{ color: 'var(--sat-text-secondary)' }}>
          {tab.path}
        </span>
        <button
          onClick={() => saveActiveTab()}
          className="h-7 px-3 rounded-[3px] text-xs font-medium flex items-center gap-1.5 cursor-pointer"
          style={{
            backgroundColor: 'var(--sat-btn-primary-bg)',
            color: 'var(--sat-btn-primary-text)',
          }}
        >
          <Save size={13} />
          <span>Salvar (Ctrl+S)</span>
        </button>
      </div>
      <textarea
        value={tab.content}
        onChange={(e) => updateTextFileContent(tab.id, e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            saveActiveTab();
          }
        }}
        spellCheck={false}
        className="flex-1 w-full p-4 font-mono text-[13.5px] leading-relaxed resize-none focus:outline-none"
        style={{
          backgroundColor: 'var(--sat-bg-canvas)',
          color: 'var(--sat-text-primary)',
        }}
      />
    </div>
  );
};
