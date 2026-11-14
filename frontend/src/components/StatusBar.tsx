import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CircleHelp, Loader2 } from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';

export const StatusBar: React.FC = () => {
  const { tab, running, status, mode, openSettings } = useSaturnoStore(useShallow(s => ({
    tab: s.tabs.find(t => t.id === s.activeTabId),
    running: s.tabs.filter(t => t.kind === 'notebook' && t.kernelStatus === 'busy').length,
    status: s.statusMessage, mode: s.notebookMode, openSettings: s.openSettings,
  })));
  const notebook = tab?.kind === 'notebook' ? tab : undefined;
  const index = notebook?.cells.findIndex(c => c.id === notebook.activeCellId) ?? -1;
  const kernel = notebook ? ({ busy: 'Executando', starting: 'Iniciando kernel', idle: 'Kernel pronto', stopped: 'Kernel parado', not_started: 'Kernel não iniciado' })[notebook.kernelStatus] : '';
  return <footer className="h-8 px-3 flex items-center gap-3 border-t shrink-0 text-xs" style={{ background: 'var(--sat-bg-surface)', borderColor: 'var(--sat-border)', color: 'var(--sat-text-secondary)' }}>
    <div role="status" className="flex items-center gap-2 min-w-0 flex-1">
      {running > 0 && <Loader2 size={13} className="animate-spin shrink-0" />}
      <span className="truncate">{running > 0 ? `${running} notebook(s) executando` : status || 'Pronto'}</span>
    </div>
    {notebook && <><span className="hidden sm:inline">{index >= 0 ? `Célula ${index + 1} de ${notebook.cells.length} · ${mode === 'edit' ? 'Edição' : 'Comando'}` : 'Nenhuma célula selecionada'}</span><span>{kernel}</span></>}
    {tab && tab.kind !== 'launcher' && <span className="hidden md:inline">{tab.dirty ? 'Alterações não salvas' : 'Salvo'}</span>}
    <button onClick={() => openSettings('shortcuts')} aria-label="Ajuda e atalhos de teclado" title="Ajuda e atalhos de teclado" className="sat-icon-btn p-1"><CircleHelp size={16} /></button>
  </footer>;
};
