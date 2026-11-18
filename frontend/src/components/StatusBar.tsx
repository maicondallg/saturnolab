import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CircleHelp, Loader2 } from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';

export const StatusBar: React.FC = React.memo(() => {
  const { tabKind, tabDirty, activeCellIndex, cellCount, kernelStatus, running, status, mode, openSettings } = useSaturnoStore(useShallow((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    const nb = tab?.kind === 'notebook' ? tab : undefined;
    let runningCount = 0;
    for (const t of s.tabs) {
      if (t.kind === 'notebook' && t.kernelStatus === 'busy') runningCount++;
    }
    return {
      tabKind: tab?.kind,
      tabDirty: Boolean(tab && tab.kind !== 'launcher' && tab.dirty),
      activeCellIndex: nb ? nb.cells.findIndex((c) => c.id === nb.activeCellId) : -1,
      cellCount: nb ? nb.cells.length : 0,
      kernelStatus: nb?.kernelStatus,
      running: runningCount,
      status: s.statusMessage,
      mode: s.notebookMode,
      openSettings: s.openSettings,
    };
  }));
  const kernel = kernelStatus ? ({ busy: 'Executando', starting: 'Iniciando kernel', idle: 'Kernel pronto', stopped: 'Kernel parado', not_started: 'Kernel não iniciado' })[kernelStatus] : '';
  return <footer className="h-8 px-3 flex items-center gap-3 border-t shrink-0 text-xs" style={{ background: 'var(--sat-bg-surface)', borderColor: 'var(--sat-border)', color: 'var(--sat-text-secondary)' }}>
    <div role="status" className="flex items-center gap-2 min-w-0 flex-1">
      {running > 0 && <Loader2 size={13} className="animate-spin shrink-0" />}
      <span className="truncate">{running > 0 ? `${running} notebook(s) executando` : status || 'Pronto'}</span>
    </div>
    {tabKind === 'notebook' && <><span className="hidden sm:inline">{activeCellIndex >= 0 ? `Célula ${activeCellIndex + 1} de ${cellCount} · ${mode === 'edit' ? 'Edição' : 'Comando'}` : 'Nenhuma célula selecionada'}</span><span>{kernel}</span></>}
    {tabKind && tabKind !== 'launcher' && <span className="hidden md:inline">{tabDirty ? 'Alterações não salvas' : 'Salvo'}</span>}
    <button onClick={() => openSettings('shortcuts')} aria-label="Ajuda e atalhos de teclado" title="Ajuda e atalhos de teclado" className="sat-icon-btn p-1"><CircleHelp size={16} /></button>
  </footer>;
});
