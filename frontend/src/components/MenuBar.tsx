import React, { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChevronDown, FolderOpen, Menu } from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';

export const MenuBar: React.FC = React.memo(() => {
  const s = useSaturnoStore(useShallow((state) => {
    const activeTab = state.tabs.find(
      (t) => t.id === state.activeTabId && (t.kind === 'launcher' || !t.loading)
    );
    const nb = activeTab?.kind === 'notebook' ? activeTab : undefined;
    const activeCell = nb?.cells.find((c) => c.id === nb.activeCellId);
    return {
      initialized: state.initialized,
      workspaceRoot: state.workspaceRoot,
      leftSidebar: state.leftSidebar,
      sidebarPosition: state.sidebarPosition,
      notebookLayout: state.notebookLayout,
      showLineNumbers: state.showLineNumbers,
      showMinimap: state.showMinimap,
      autoSave: state.autoSave,
      activePaneId: state.activePaneId,
      activeTabId: activeTab?.id,
      activeTabKind: activeTab?.kind,
      activeCellId: activeCell?.id,
      hasOutput: Boolean(activeCell?.cell_type === 'code' && activeCell.outputs.length > 0),
      hasAnyOutput: Boolean(nb?.cells.some((c) => c.outputs.length > 0)),
      hasRedoDeleted: Boolean(nb?.redoDeletedCellIds?.length),
      kernelBusy: nb?.kernelStatus === 'busy',
    };
  }));
  const menu = useRef<HTMLDetailsElement>(null);
  const actions = useSaturnoStore.getState();
  const isNotebook = s.activeTabKind === 'notebook';
  const hasCell = Boolean(s.activeCellId);
  const canSaveOrSplit = Boolean(s.activeTabKind && s.activeTabKind !== 'launcher');
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && menu.current) menu.current.open = false;
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, []);
  const item = (label: string, run: () => void, disabled = false, shortcut?: string) => (
    <button key={label} type="button" disabled={disabled} className="app-menu-item"
      onClick={() => { if (menu.current) menu.current.open = false; run(); }}>
      <span>{label}</span>{shortcut && <span className="text-xs opacity-60">{shortcut}</span>}
    </button>
  );
  const separator = <hr className="my-1" style={{ borderColor: 'var(--sat-border)' }} />;
  const group = (label: string) => <div className="px-3 pt-2 pb-1 text-xs" style={{ color: 'var(--sat-text-muted)' }}>{label}</div>;
  return <header className="relative h-10 pr-3 flex items-center gap-1 border-b shrink-0 select-none"
    style={{ background: 'var(--sat-bg-surface)', borderColor: 'var(--sat-border)' }}>
    <details ref={menu} className="contents" data-app-menu>
      <summary aria-label="Menu principal" title="Menu principal" className="list-none w-8 h-8 ml-[5px] flex items-center justify-center rounded cursor-pointer hover:bg-[var(--sat-bg-hover)] text-[var(--sat-text-secondary)] hover:text-[var(--sat-text-primary)] transition-colors shrink-0"><Menu size={18} /></summary>
      <div className="app-menu-strip"
        style={{ background: 'var(--sat-bg-surface)', borderColor: 'var(--sat-border)' }}>
        <div className="app-submenu"><button type="button" className="app-menu-heading">Arquivo</button><div className="app-submenu-items">
          {item('Novo notebook', () => { void actions.createNewNotebook(); })}
          {item('Novo arquivo Python', () => { void actions.createNewFile(undefined, 'script.py'); })}
          {item('Novo Markdown', () => { void actions.createNewFile(undefined, 'notas.md'); })}
          {item('Novo arquivo de texto', () => { void actions.createNewFile(undefined, 'arquivo.txt'); })}
          {separator}
          {item('Abrir Launcher', () => actions.openLauncher())}
          {item('Abrir pasta…', () => actions.setShowFolderModal(true))}
          {separator}
          {item('Salvar', () => { void actions.saveActiveTab(); }, !canSaveOrSplit, 'Ctrl+S')}
          {item(s.autoSave ? '✓ Salvamento automático' : 'Salvamento automático', () => actions.setAutoSave(!s.autoSave))}
        </div></div>
        <div className="app-submenu"><button type="button" className="app-menu-heading">Editar</button><div className="app-submenu-items">
          {group('Células')}
          {item('Recortar célula', () => actions.cutCell(s.activeCellId), !hasCell, 'X')}
          {item('Copiar célula', () => actions.copyCell(s.activeCellId), !hasCell, 'C')}
          {item('Colar célula abaixo', () => actions.pasteCellBelow(s.activeCellId), !isNotebook, 'V')}
          {item('Refazer exclusão de célula', () => actions.redoDeleteCell(), !s.hasRedoDeleted, 'Shift+Z')}
          {item('Restaurar célula excluída', () => actions.undoDeleteCell(), !isNotebook, 'Z')}
          {separator}
          {item('Limpar saída da célula', () => { if (s.activeCellId) actions.clearCellOutputs(s.activeCellId); }, !s.hasOutput)}
          {item('Limpar todas as saídas', () => actions.clearAllOutputs(), !isNotebook || !s.hasAnyOutput)}
          {separator}
          {item('Editar célula com IA…', () => { if (s.activeCellId) { actions.selectCell(s.activeCellId, 'edit'); actions.openInlineAI(s.activeCellId, null); } }, !hasCell, 'Ctrl+I')}
        </div></div>
        <div className="app-submenu"><button type="button" className="app-menu-heading">Exibir</button><div className="app-submenu-items">
          {group('Painéis')}
          {item(s.leftSidebar ? 'Ocultar painel lateral' : 'Mostrar painel lateral', () => actions.setLeftSidebar(s.leftSidebar ? null : 'files'), false, 'Ctrl+B')}
          {item(s.sidebarPosition === 'left' ? 'Painel lateral à direita' : 'Painel lateral à esquerda', () => actions.toggleSidebarPosition())}
          {item('Dividir editor à direita', () => { if (s.activeTabId) actions.splitTab(s.activeTabId, s.activePaneId, 'right'); }, !canSaveOrSplit)}
          {separator}
          {group('Editor')}
          {item(s.showLineNumbers ? 'Ocultar números de linha' : 'Mostrar números de linha', () => actions.toggleLineNumbers(), !canSaveOrSplit)}
          {item(s.showMinimap ? 'Ocultar minimapa' : 'Mostrar minimapa', () => actions.toggleMinimap(), !canSaveOrSplit)}
          {separator}
          {group('Notebook')}
          {item(s.notebookLayout === 'centered' ? 'Usar largura total' : 'Centralizar notebook', () => actions.toggleNotebookLayout(), !isNotebook)}
          {item('Ocultar / mostrar saída da célula', () => actions.toggleCellOutputCollapse(s.activeCellId), !s.hasOutput, 'O')}
        </div></div>
        <div className="app-submenu"><button type="button" className="app-menu-heading">Executar</button><div className="app-submenu-items">
          {item('Executar célula selecionada', () => { if (s.activeCellId) void actions.runCell(s.activeCellId, 'none'); }, !hasCell, 'Ctrl+Enter')}
          {item('Executar todas as células', () => { void actions.runAllCells(); }, !isNotebook)}
          {separator}
          {group('Kernel')}
          {item('Interromper execução', () => { void actions.interruptKernel(); }, !isNotebook || !s.kernelBusy)}
          {item('Reiniciar kernel', () => { void actions.restartKernel(false); }, !isNotebook)}
        </div></div>
        <div className="app-submenu"><button type="button" className="app-menu-heading">Configurações</button><div className="app-submenu-items">
          {item('Aparência e layout…', () => actions.openSettings('appearance'))}
          {item('Editor e execução…', () => actions.openSettings('editor'))}
          {item('Inteligência artificial…', () => actions.openSettings('ai'))}
        </div></div>
        <div className="app-submenu"><button type="button" className="app-menu-heading">Ajuda</button><div className="app-submenu-items">
          {item('Referência de atalhos', () => actions.openSettings('shortcuts'))}
        </div></div>
      </div>
    </details>
    <span className="inline-flex items-center gap-1.5 font-semibold text-sm leading-none shrink-0">
      <span className="inline-block text-[15px] leading-none -translate-y-[1.5px]" aria-hidden="true">🪐</span>
      <span>SaturnoLab</span>
    </span>
    <button className="ml-1.5 flex items-center gap-1.5 px-2 py-1 rounded text-xs min-w-0 hover:bg-[var(--sat-bg-hover)] text-[var(--sat-text-secondary)] hover:text-[var(--sat-text-primary)] transition-colors cursor-pointer" onClick={() => actions.setShowFolderModal(true)} title={s.workspaceRoot || 'Abrir pasta'}>
      <FolderOpen size={14} /><span className="truncate max-w-[240px]">{s.workspaceRoot?.split(/[\\/]/).filter(Boolean).pop() || (s.initialized ? 'Abrir pasta' : '\u00a0')}</span><ChevronDown size={12} />
    </button>

  </header>;
});
