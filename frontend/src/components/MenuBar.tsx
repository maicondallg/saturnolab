import React, { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChevronDown, FolderOpen, Menu } from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';

export const MenuBar: React.FC = React.memo(() => {
  const s = useSaturnoStore(useShallow(s => ({
    initialized: s.initialized, workspaceRoot: s.workspaceRoot, leftSidebar: s.leftSidebar, sidebarPosition: s.sidebarPosition,
    notebookLayout: s.notebookLayout, showLineNumbers: s.showLineNumbers,
    activeTab: s.tabs.find(t => t.id === s.activeTabId && (t.kind === 'launcher' || !t.loading)), activePaneId: s.activePaneId,
  })));
  const menu = useRef<HTMLDetailsElement>(null);
  const actions = useSaturnoStore.getState();
  const notebook = s.activeTab?.kind === 'notebook' ? s.activeTab : undefined;
  const cell = notebook?.cells.find(c => c.id === notebook.activeCellId);
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
  const hasOutput = cell?.cell_type === 'code' && cell.outputs.length > 0;
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
          {item('Salvar', () => { void actions.saveActiveTab(); }, !s.activeTab || s.activeTab.kind === 'launcher', 'Ctrl+S')}
        </div></div>
        <div className="app-submenu"><button type="button" className="app-menu-heading">Editar</button><div className="app-submenu-items">
          {group('Células')}
          {item('Recortar célula', () => actions.cutCell(cell?.id), !cell, 'X')}
          {item('Copiar célula', () => actions.copyCell(cell?.id), !cell, 'C')}
          {item('Colar célula abaixo', () => actions.pasteCellBelow(cell?.id), !notebook, 'V')}
          {item('Restaurar célula excluída', () => actions.undoDeleteCell(), !notebook, 'Z')}
          {separator}
          {item('Limpar saída da célula', () => { if (cell) actions.clearCellOutputs(cell.id); }, !hasOutput)}
          {item('Limpar todas as saídas', () => actions.clearAllOutputs(), !notebook || !notebook.cells.some(c => c.outputs.length > 0))}
          {separator}
          {item('Editar célula com IA…', () => { if (cell) { actions.selectCell(cell.id, 'edit'); actions.openInlineAI(cell.id, null); } }, !cell, 'Ctrl+I')}
        </div></div>
        <div className="app-submenu"><button type="button" className="app-menu-heading">Exibir</button><div className="app-submenu-items">
          {group('Painéis')}
          {item(s.leftSidebar ? 'Ocultar painel lateral' : 'Mostrar painel lateral', () => actions.setLeftSidebar(s.leftSidebar ? null : 'files'), false, 'Ctrl+B')}
          {item(s.sidebarPosition === 'left' ? 'Painel lateral à direita' : 'Painel lateral à esquerda', () => actions.toggleSidebarPosition())}
          {item('Dividir editor à direita', () => { if (s.activeTab) actions.splitTab(s.activeTab.id, s.activePaneId, 'right'); }, !s.activeTab || s.activeTab.kind === 'launcher')}
          {separator}
          {group('Editor')}
          {item(s.showLineNumbers ? 'Ocultar números de linha' : 'Mostrar números de linha', () => actions.toggleLineNumbers(), !s.activeTab || s.activeTab.kind === 'launcher')}
          {separator}
          {group('Notebook')}
          {item(s.notebookLayout === 'centered' ? 'Usar largura total' : 'Centralizar notebook', () => actions.toggleNotebookLayout(), !notebook)}
          {item('Ocultar / mostrar saída da célula', () => actions.toggleCellOutputCollapse(cell?.id), !hasOutput, 'O')}
        </div></div>
        <div className="app-submenu"><button type="button" className="app-menu-heading">Executar</button><div className="app-submenu-items">
          {item('Executar célula selecionada', () => { if (cell) void actions.runCell(cell.id, 'none'); }, !cell, 'Ctrl+Enter')}
          {item('Executar todas as células', () => { void actions.runAllCells(); }, !notebook)}
          {separator}
          {group('Kernel')}
          {item('Interromper execução', () => { void actions.interruptKernel(); }, !notebook || notebook.kernelStatus !== 'busy')}
          {item('Reiniciar kernel', () => { void actions.restartKernel(false); }, !notebook)}
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
      <FolderOpen size={14} /><span className="truncate max-w-[240px]">{s.workspaceRoot?.split('/').filter(Boolean).pop() || (s.initialized ? 'Abrir pasta' : '\u00a0')}</span><ChevronDown size={12} />
    </button>

  </header>;
});
