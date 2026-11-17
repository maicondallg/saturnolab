import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { ChevronDown, ChevronRight, ChevronsDownUp, Folder, ListTree, Database, PanelLeftClose, Plus, RefreshCw, X } from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { loadNotebookView, loadTextFileView } from '../services/editorViews';
import { api } from '../services/api';
import { FileEntry } from '../types/notebook';
import { flattenVisibleTree, formatModifiedShort, formatModifiedTooltip } from '../utils/fileUtils';
import { notebookOutline } from '../utils/notebookOutline';
import { FileTypeIcon } from './FileTypeIcon';

let fileClipboard: string[] = [];
let clipboardCut = false;
const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');
async function copyPathText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fallback below
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
export const LeftSidebar: React.FC = React.memo(() => {
  const s = useSaturnoStore(useShallow(s => ({
    initialized: s.initialized,
    workspaceRoot: s.workspaceRoot,
    panel: s.leftSidebar, position: s.sidebarPosition, width: s.sidebarWidth,
    files: s.files, expanded: s.expandedFolders, children: s.folderChildren,
    selected: s.selectedFilePaths, folder: s.activeFolderContext, showTime: s.showModifiedTime,
    tab: s.leftSidebar === 'outline' || s.leftSidebar === 'variables' ? s.tabs.find(t => t.id === s.activeTabId) : undefined,
  })));
  const a = useSaturnoStore.getState();
  const nodes = useMemo(() => flattenVisibleTree(s.files, s.expanded, s.children), [s.files, s.expanded, s.children]);
  const paths = nodes.map(n => n.entry.path);
  const notebook = s.tab?.kind === 'notebook' ? s.tab : undefined;
  const headings = useMemo(() => notebookOutline(notebook?.cells || []), [notebook?.cells]);
  const [context, setContext] = useState<{ x: number; y: number; entry?: FileEntry } | null>(null);
  const [naming, setNaming] = useState<{ kind: string; folder: string; entry?: FileEntry } | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [modifiedNow, setModifiedNow] = useState(Date.now);
  useEffect(() => {
    if (s.panel !== 'files' || !s.showTime) return;
    setModifiedNow(Date.now());
    const timer = window.setInterval(() => setModifiedNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [s.panel, s.showTime]);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setContext(null); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setContext(null); setNaming(null); } };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, []);
  useLayoutEffect(() => {
    if (!context || !menuRef.current) return;
    const { width, height } = menuRef.current.getBoundingClientRect();
    const left = context.x + width > window.innerWidth - 8 ? Math.max(8, context.x - width) : Math.max(8, context.x);
    const top = context.y + height > window.innerHeight - 8 ? Math.max(8, context.y - height) : Math.max(8, context.y);
    menuRef.current.style.left = `${left}px`;
    menuRef.current.style.top = `${top}px`;
  }, [context]);
  const perform = async (fn: () => unknown) => {
    setContext(null); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const copyTo = async (selected: string[], folder: string) => {
    await api.copyEntries(selected, folder);
    await a.refreshFiles();
    useSaturnoStore.setState({ statusMessage: `${selected.length} item(ns) copiado(s)` });
  };
  const pasteTo = async (folder: string) => {
    if (clipboardCut) { await a.moveEntries(fileClipboard, folder); fileClipboard = []; clipboardCut = false; }
    else await copyTo(fileClipboard, folder);
  };
  const startNaming = (kind: string, entry?: FileEntry) => {
    const folder = context?.entry ? (context.entry.type === 'directory' ? context.entry.path : parentOf(context.entry.path)) : s.folder;
    setNaming({ kind, folder, entry }); setName(entry?.name || ({ python: 'script.py', markdown: 'notas.md', file: 'arquivo.txt', notebook: 'Untitled.ipynb', folder: '' }[kind] || '')); setContext(null);
  };
  const remove = () => perform(async () => { if (s.selected.length && window.confirm(`Excluir ${s.selected.length} item(ns)?`)) await a.deleteBatchEntries(s.selected); });
  const drop = (e: React.DragEvent, folder: string) => {
    if (!e.dataTransfer.types.includes('application/x-saturno-paths')) return;
    e.preventDefault(); e.stopPropagation(); setDropFolder(null);
    void perform(async () => {
      const selected: string[] = JSON.parse(e.dataTransfer.getData('application/x-saturno-paths'));
      const roots = selected.filter(p => !selected.some(other => other !== p && p.startsWith(other + '/')));
      await a.moveEntries(roots, folder);
    });
  };
  const navigate = (cellId: string, ordinal: number) => {
    if (!notebook) return;
    // Reveal parent sections before navigating to a hidden heading.
    useSaturnoStore.setState(state => ({ tabs: state.tabs.map(t => t.id === notebook.id && t.kind === 'notebook' ? { ...t, cells: t.cells.map((c, index) => { const h = headings.find(h => h.cellId === c.id); const target = headings.find(h => h.cellId === cellId); const end = h ? headings.find(next => next.index > index && next.level <= h.level)?.index ?? t.cells.length : index; return h && target && index <= target.index && target.index < end ? { ...c, sectionCollapsed: false } : c; }) } : t) }));
    a.selectCell(cellId, 'command', true);
    requestAnimationFrame(() => {
      const cell = Array.from(document.querySelectorAll('[data-cell-id]')).find(el => el.getAttribute('data-cell-id') === cellId);
      cell?.querySelectorAll('.jp-markdown-rendered h1, .jp-markdown-rendered h2, .jp-markdown-rendered h3, .jp-markdown-rendered h4, .jp-markdown-rendered h5, .jp-markdown-rendered h6')[ordinal]?.scrollIntoView({ block: 'nearest' });
    });
  };
  const menuItem = (label: string, fn: () => unknown, disabled = false) => <button key={label} className="app-menu-item" disabled={disabled} onClick={() => void perform(fn)}>{label}</button>;
  return <>
    <nav aria-label="Painéis de trabalho" className="activity-rail">
      {([{ id: 'files', title: 'Arquivos', icon: Folder }, { id: 'variables', title: 'Variáveis', icon: Database }, { id: 'outline', title: 'Sumário do notebook', icon: ListTree }] as const).map(({ id, title, icon: Icon }) =>
        <button key={id} title={title} aria-label={title} aria-pressed={s.panel === id} onClick={() => a.setLeftSidebar(id)} className={s.panel === id ? 'is-active' : ''}><Icon size={19} /></button>)}
    </nav>
    {s.panel && <aside className={`workspace-sidebar ${s.position === 'right' ? 'sidebar-right' : ''}`} style={{ width: s.width, background: 'var(--sat-bg-surface)', borderColor: 'var(--sat-border)' }}>
      <div className="h-9 px-3 flex items-center justify-between border-b shrink-0" style={{ borderColor: 'var(--sat-border)' }}>
        <span className="text-sm font-medium">{s.panel === 'files' ? 'Arquivos' : s.panel === 'outline' ? 'Sumário' : 'Variáveis'}</span>
        <button className="sat-icon-btn" title="Ocultar painel (Ctrl+B)" aria-label="Ocultar painel" onClick={() => a.setLeftSidebar(null)}><PanelLeftClose size={16} /></button>
      </div>
      {s.panel === 'files' && <>
        <div className="h-9 px-3 flex items-center gap-1 border-b shrink-0" style={{ borderColor: 'var(--sat-border)' }}>
          <button className="truncate text-xs flex-1 text-left px-1.5 py-1 -ml-1.5 rounded hover:bg-[var(--sat-bg-hover)] hover:text-[var(--sat-text-primary)] transition-colors" title="Raiz do workspace · solte arquivos aqui para mover"
            onClick={() => a.setActiveFolderContext('')} onDragOver={e => e.preventDefault()} onDrop={e => drop(e, '')}>/{s.folder}</button>
          <button className="sat-icon-btn" title="Novo…" aria-label="Novo arquivo ou pasta" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setContext({ x: r.left, y: r.bottom }); }}><Plus size={16} /></button>
          <button className="sat-icon-btn" title="Recolher pastas" onClick={a.collapseAllFolders}><ChevronsDownUp size={15} /></button>
          <button className="sat-icon-btn" title="Atualizar arquivos" onClick={() => void perform(a.refreshFiles)}><RefreshCw size={15} /></button>
        </div>
        {naming && <form className="p-3 border-b flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); void perform(async () => {
          const clean = name.trim(); if (!clean) return;
          if (naming.kind === 'rename' && naming.entry) await a.renameEntry(naming.entry.path, clean);
          else if (naming.kind === 'folder') await a.createNewFolder(clean, naming.folder);
          else if (naming.kind === 'notebook') await a.createNewNotebook(naming.folder, clean);
          else await a.createNewFile(naming.folder, clean);
          setNaming(null);
        }); }}>
          <label className="text-xs w-full">{naming.kind === 'rename' ? 'Renomear' : 'Criar'} em /{naming.folder}</label>
          <input aria-label="Nome" autoFocus value={name} onFocus={e => e.target.select()} onChange={e => setName(e.target.value)} className="min-w-0 flex-1 border rounded px-2 py-1 text-sm" style={{background:'var(--sat-bg-canvas)'}} />
          <button className="px-2 py-1 rounded text-xs font-medium hover:opacity-85 transition-opacity" style={{ background: 'var(--sat-btn-primary-bg)', color: 'var(--sat-btn-primary-text)' }} type="submit">Confirmar</button><button type="button" className="sat-icon-btn" aria-label="Cancelar" onClick={() => setNaming(null)}><X size={14} /></button>
        </form>}
        {error && <div role="alert" className="p-3 text-xs text-red-500">{error}</div>}
        {s.selected.length > 1 && <div className="px-3 py-1 text-xs" style={{color:'var(--sat-text-secondary)'}}>{s.selected.length} itens selecionados</div>}
        <div role="tree" aria-label="Arquivos do workspace" aria-multiselectable="true" tabIndex={0} className="flex-1 overflow-auto py-1 outline-none"
          onContextMenu={e => { e.preventDefault(); setContext({x:e.clientX,y:e.clientY}); }}
          onClick={e => { if (e.target === e.currentTarget) a.clearFileSelection(); }}
          onKeyDown={e => {
            if ((e.target as HTMLElement).closest('input')) return;
            const key = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
            if (ctrl && ['a','c','v','d','x'].includes(key)) {
              e.preventDefault(); e.stopPropagation();
              if (key === 'a') a.selectAllFiles(paths);
              if (key === 'c' || key === 'x') { clipboardCut = key === 'x'; fileClipboard = [...s.selected]; useSaturnoStore.setState({statusMessage:`${fileClipboard.length} item(ns) copiado(s) para colar`}); }
              if (key === 'v' && fileClipboard.length) void perform(() => pasteTo(s.folder));
              if (key === 'd') void perform(() => copyTo(s.selected, parentOf(s.selected[0] || '')));
            } else if (e.key === 'Delete') { e.preventDefault(); void remove(); }
            else if (e.key === 'F2' && s.selected.length === 1) { e.preventDefault(); startNaming('rename', nodes.find(n => n.entry.path === s.selected[0])?.entry); }
            else if (e.key === 'Escape') a.clearFileSelection();
            else if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) {
              e.preventDefault(); e.stopPropagation();
              const current = (e.target as HTMLElement).closest('[data-file-path]')?.getAttribute('data-file-path');
              const index = paths.indexOf(current || s.selected[s.selected.length - 1]);
              const node = nodes[index];
              if (e.key === ' ' && node) { a.toggleFileSelection(node.entry.path, !(e.ctrlKey || e.metaKey)); return; }
              if (node?.entry.type === 'directory' && e.key === 'ArrowRight') { void a.setFolderExpanded(node.entry.path, true); return; }
              if (node?.entry.type === 'directory' && s.expanded[node.entry.path] && e.key === 'ArrowLeft') { void a.setFolderExpanded(node.entry.path, false); return; }
              const next = e.key === 'ArrowLeft' ? paths.indexOf(parentOf(current || '')) : Math.max(0, Math.min(nodes.length - 1, index + (e.key === 'ArrowUp' ? -1 : 1)));
              if (next >= 0 && nodes[next]) {
                if(e.shiftKey) a.selectFileRange(paths, paths[next]); else a.toggleFileSelection(paths[next], true);
                (e.currentTarget.querySelectorAll('[role="treeitem"]')[next] as HTMLElement)?.focus();
              }
            }
          }}>
          {s.initialized && !nodes.length && <p className="p-4 text-sm" style={{color:'var(--sat-text-muted)'}}>Pasta vazia. Clique com o botão direito para criar um arquivo.</p>}
          {nodes.map(({entry,depth}) => <div key={entry.path} data-file-path={entry.path} role="treeitem" tabIndex={0} aria-level={depth + 1} aria-selected={s.selected.includes(entry.path)} aria-expanded={entry.type === 'directory' ? !!s.expanded[entry.path] : undefined}
            onPointerEnter={entry.type !== 'directory' ? () => { void (entry.type === 'notebook' ? loadNotebookView() : loadTextFileView()).catch(() => {}); } : undefined}
            draggable title={formatModifiedTooltip(entry)}
            className={`saturno-file-row h-8 flex items-center gap-2 text-[13px] cursor-pointer ${s.selected.includes(entry.path) ? 'is-selected' : ''} ${dropFolder === entry.path ? 'drop-target' : ''}`}
            style={{paddingLeft:depth*14+10,paddingRight:10}}
            onClick={e => {
              e.stopPropagation(); e.currentTarget.focus();
              if (e.shiftKey) { a.selectFileRange(paths,entry.path); return; }
              if (e.ctrlKey || e.metaKey) { a.toggleFileSelection(entry.path); return; }
              a.toggleFileSelection(entry.path,true);
              a.setActiveFolderContext(entry.type === 'directory' ? entry.path : parentOf(entry.path));
              if (entry.type === 'directory') void a.toggleFolderExpanded(entry.path); else void perform(() => a.openEntry(entry));
            }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if(entry.type === 'directory') void a.toggleFolderExpanded(entry.path); else void perform(() => a.openEntry(entry)); } }}
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if(!s.selected.includes(entry.path)) a.toggleFileSelection(entry.path,true); setContext({x:e.clientX,y:e.clientY,entry}); }}
            onDragStart={e => {
              const selected = s.selected.includes(entry.path) ? s.selected : [entry.path];
              if(!s.selected.includes(entry.path)) a.toggleFileSelection(entry.path,true);
              e.dataTransfer.setData('application/x-saturno-paths',JSON.stringify(selected));
              e.dataTransfer.setData('application/x-saturno-entry',JSON.stringify(entry));
              e.dataTransfer.setData('application/x-saturno-entries',JSON.stringify(nodes.filter(n=>selected.includes(n.entry.path)).map(n=>n.entry)));
              e.dataTransfer.effectAllowed='copyMove';
            }}
            onDragOver={e => { if(entry.type==='directory' && e.dataTransfer.types.includes('application/x-saturno-paths')) { e.preventDefault(); e.stopPropagation(); setDropFolder(entry.path); e.dataTransfer.dropEffect='move'; } }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropFolder(null); }} onDragEnd={() => setDropFolder(null)}
            onDrop={e => { if(entry.type==='directory') drop(e,entry.path); }}>
            {entry.type==='directory' && (s.expanded[entry.path] ? <ChevronDown size={13}/> : <ChevronRight size={13}/>)}
            <FileTypeIcon name={entry.name} type={entry.type} isOpenFolder={!!s.expanded[entry.path]} size={16}/>
            <span className="truncate flex-1">{entry.name}</span>
            {s.showTime && entry.modified && !Number.isNaN(Date.parse(entry.modified)) &&
              <time className="file-modified" dateTime={entry.modified} title={`Modificado em ${new Date(entry.modified).toLocaleString('pt-BR')}`}>
                {formatModifiedShort(entry.modified, modifiedNow)}
              </time>}
          </div>)}
        </div>
      </>}
      {s.panel === 'outline' && <div className="flex-1 overflow-auto py-2">
        {!headings.length && <p className="p-4 text-sm" style={{color:'var(--sat-text-muted)'}}>Os títulos Markdown (H1–H6) do notebook aparecem aqui.</p>}
        {headings.map(h => <div key={`${h.cellId}-${h.ordinal}`} className="flex items-center pr-2" style={{paddingLeft:8+(h.level-1)*12}}>
          {h.ordinal === 0 ? <button title="Recolher / expandir seção" aria-expanded={!notebook?.cells[h.index].sectionCollapsed} className="sat-icon-btn p-1" onClick={()=>a.toggleSection(h.cellId)}>{notebook?.cells[h.index].sectionCollapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}</button> : <span className="w-6"/>}
          <button className="text-sm py-1.5 px-2 my-0.5 rounded truncate text-left flex-1 hover:bg-[var(--sat-bg-hover)] transition-colors" title={h.title} onClick={()=>navigate(h.cellId,h.ordinal)}>{h.title}</button>
        </div>)}
      </div>}
      {s.panel === 'variables' && <div className="flex-1 overflow-auto p-3 space-y-3">
        {!notebook?.variables.length && <p className="text-sm" style={{color:'var(--sat-text-muted)'}}>Execute uma célula para inspecionar as variáveis.</p>}
        {notebook?.variables.map(v=><div key={v.name} className="border rounded p-3 text-sm" style={{borderColor:'var(--sat-border)'}}><b>{v.name}</b><span className="ml-2 opacity-70">{v.type} {v.shape}</span><pre className="text-xs whitespace-pre-wrap mt-2">{v.preview}</pre></div>)}
      </div>}
      <div className={`absolute inset-y-0 w-1.5 cursor-col-resize ${s.position==='left'?'right-0':'left-0'}`} title="Redimensionar painel"
        onMouseDown={e=>{ e.preventDefault(); const start=e.clientX, width=s.width; const move=(event:MouseEvent)=>a.setSidebarWidth(width+(event.clientX-start)*(s.position==='left'?1:-1),false); const end=()=>{a.setSidebarWidth(useSaturnoStore.getState().sidebarWidth,true);window.removeEventListener('mousemove',move);window.removeEventListener('mouseup',end);};window.addEventListener('mousemove',move);window.addEventListener('mouseup',end); }} />
    </aside>}
    {context && createPortal(<div ref={menuRef} data-app-menu className="file-context-menu" style={{left:context.x+250>window.innerWidth-8?Math.max(8,context.x-250):Math.max(8,context.x),top:context.y+(context.entry?440:230)>window.innerHeight-8?Math.max(8,context.y-(context.entry?440:230)):Math.max(8,context.y)}}>
      {context.entry && <>
        {menuItem('Abrir lado a lado',()=>a.openEntry(context.entry!,{sideBySide:true}),context.entry.type==='directory')}
        {menuItem('Copiar caminho',async ()=>{
          const relPath = context.entry!.path;
          await copyPathText(relPath);
          useSaturnoStore.setState({statusMessage:`Caminho copiado: ${relPath}`});
        })}
        {menuItem('Copiar caminho absoluto',async ()=>{
          const root = (s.workspaceRoot || '').replace(/\/+$/, '');
          const absPath = root ? `${root}/${context.entry!.path}` : context.entry!.path;
          await copyPathText(absPath);
          useSaturnoStore.setState({statusMessage:`Caminho absoluto copiado: ${absPath}`});
        })}
        {menuItem('Copiar · Ctrl+C',()=>{clipboardCut=false; fileClipboard=[...useSaturnoStore.getState().selectedFilePaths];})}
        {menuItem('Recortar · Ctrl+X',()=>{clipboardCut=true; fileClipboard=[...s.selected];})}
        {menuItem('Duplicar · Ctrl+D',()=>copyTo(s.selected,parentOf(context.entry!.path)))}
        {menuItem('Renomear · F2',()=>startNaming('rename',context.entry),s.selected.length!==1)}
        {menuItem('Excluir · Delete',remove)}<hr />
      </>}
      {!context.entry && <>
        {menuItem('Copiar caminho da pasta',async ()=>{
          const root = (s.workspaceRoot || '').replace(/\/+$/, '');
          const folderPath = s.folder ? (root ? `${root}/${s.folder}` : s.folder) : root;
          await copyPathText(folderPath);
          useSaturnoStore.setState({statusMessage:`Caminho copiado: ${folderPath}`});
        })}
        <hr />
      </>}
      {menuItem('Colar aqui · Ctrl+V',()=>pasteTo(context.entry?.type==='directory'?context.entry.path:context.entry?parentOf(context.entry.path):s.folder),!fileClipboard.length)}
      {menuItem('Novo notebook…',()=>startNaming('notebook'))}
      {menuItem('Novo arquivo Python…',()=>startNaming('python'))}
      {menuItem('Novo Markdown…',()=>startNaming('markdown'))}
      {menuItem('Novo arquivo…',()=>startNaming('file'))}
      {menuItem('Nova pasta…',()=>startNaming('folder'))}
    </div>,document.body)}
  </>;
});
