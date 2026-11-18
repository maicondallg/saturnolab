import React, { useCallback, useEffect,
  useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Annotation, EditorState, Compartment, Prec } from '@codemirror/state';
import {
  EditorView,
  Panel,
  Rect,
  ViewUpdate,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  placeholder as cmPlaceholder,
  tooltips,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  redo,
  indentMore,
  indentLess,
} from '@codemirror/commands';
import {
  LanguageSupport,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { python } from '@codemirror/lang-python';
import { markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import {
  closeBrackets,
  insertBracket,
  closeBracketsKeymap,
  autocompletion,
  startCompletion,
  acceptCompletion,
  closeCompletion,
  completionStatus,
  CompletionContext,
  CompletionResult,
  Completion,
} from '@codemirror/autocomplete';
import {
  SearchQuery,
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
  closeSearchPanel,
  searchPanelOpen,
  getSearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  selectMatches,
  replaceNext,
  replaceAll,
} from '@codemirror/search';
import { BookOpen, Loader2, X } from 'lucide-react';
import { api } from '../services/api';
import { registerEditorFlusher } from '../services/editorViews';
import { findNotebookTabForCell } from '../store/useSaturnoStore';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { KernelInspectResponse } from '../types/notebook';

function createMarkdownExtension() {
  return new LanguageSupport(markdownLanguage, Prec.high(keymap.of(markdownKeymap)));
}

const externalSyncAnnotation = Annotation.define<boolean>();

let sharedTooltipHost: HTMLElement | null = null;

function getSharedTooltipHost(): HTMLElement | undefined {
  if (typeof document === 'undefined' || !document.body) return undefined;
  if (sharedTooltipHost && sharedTooltipHost.isConnected) {
    return sharedTooltipHost;
  }
  const existing = document.getElementById('saturno-cm-tooltips');
  if (existing) {
    sharedTooltipHost = existing;
    return existing;
  }
  const host = document.createElement('div');
  host.id = 'saturno-cm-tooltips';
  host.setAttribute('data-sat-cm-tooltips', 'true');
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.left = '0';
  host.style.width = '0';
  host.style.height = '0';
  host.style.zIndex = '55';
  document.body.appendChild(host);
  sharedTooltipHost = host;
  return host;
}

function getEditorTooltipSpace(view: EditorView): Rect {
  const scrollHost = view.dom.closest(
    '[data-notebook-scroll], [data-editor-scroll], [data-tab-panel]'
  );
  if (scrollHost) {
    const r = scrollHost.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return {
        top: r.top + 4,
        left: r.left + 4,
        bottom: r.bottom - 4,
        right: r.right - 4,
      };
    }
  }
  return {
    top: 4,
    left: 4,
    bottom: window.innerHeight - 4,
    right: window.innerWidth - 4,
  };
}

const LAZY_MOUNT_MARGIN_PX = 600;
const MAX_UNVIRTUALIZED_CELL_LINES = 500;
const MAX_UNVIRTUALIZED_CELL_CHARS = 50_000;

interface InternalEditorView {
  measure?: (flush?: boolean) => void;
  viewState?: {
    printing: boolean;
    mustMeasureContent: boolean | 'refresh';
  };
}

function shouldRenderFullCellViewport(fullHeight: boolean, state: EditorState): boolean {
  return (
    !fullHeight &&
    state.doc.lines <= MAX_UNVIRTUALIZED_CELL_LINES &&
    state.doc.length <= MAX_UNVIRTUALIZED_CELL_CHARS
  );
}

interface LazyObserverPool {
  observer: IntersectionObserver;
  callbacks: Map<Element, () => void>;
  paused: boolean;
  intersecting: Set<Element>;
  flushRaf: number | null;
}

const lazyObserverPools = new WeakMap<Element, LazyObserverPool>();
let windowLazyObserverPool: LazyObserverPool | null = null;

function mountLazyTarget(pool: LazyObserverPool, target: Element): void {
  const cb = pool.callbacks.get(target);
  if (!cb) return;
  pool.callbacks.delete(target);
  pool.intersecting.delete(target);
  pool.observer.unobserve(target);
  cb();
}

/**
 * Temporarily pauses lazy CodeMirror mounting for a scroll container (e.g., while
 * rapidly scrubbing the minimap viewport lens) so swept-past offscreen cells do not
 * mount synchronously and stall the main thread. When resumed, visible cells mount
 * immediately and offscreen margin cells flush gently across animation frames.
 */
export function setLazyMountPaused(scrollRoot: Element | null, paused: boolean): void {
  const pool = scrollRoot ? lazyObserverPools.get(scrollRoot) ?? null : windowLazyObserverPool;
  if (!pool) return;
  pool.paused = paused;

  if (paused) {
    if (pool.flushRaf !== null) {
      window.cancelAnimationFrame(pool.flushRaf);
      pool.flushRaf = null;
    }
    return;
  }

  if (pool.intersecting.size === 0) return;

  const vpRect = scrollRoot?.getBoundingClientRect();
  const vpTop = vpRect?.top ?? 0;
  const vpBottom = vpRect?.bottom ?? window.innerHeight;
  const visibleNow: Element[] = [];
  const marginQueue: Element[] = [];

  for (const el of Array.from(pool.intersecting)) {
    pool.intersecting.delete(el);
    if (!el.isConnected || !pool.callbacks.has(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.bottom >= vpTop && rect.top <= vpBottom) {
      visibleNow.push(el);
    } else if (
      rect.bottom >= vpTop - LAZY_MOUNT_MARGIN_PX &&
      rect.top <= vpBottom + LAZY_MOUNT_MARGIN_PX
    ) {
      marginQueue.push(el);
    }
  }

  for (const el of visibleNow) {
    mountLazyTarget(pool, el);
  }

  if (marginQueue.length === 0) return;

  const flushBatch = () => {
    pool.flushRaf = null;
    if (pool.paused) return;
    let count = 0;
    while (marginQueue.length > 0 && count < 2) {
      const el = marginQueue.shift()!;
      if (!el.isConnected || !pool.callbacks.has(el)) continue;
      mountLazyTarget(pool, el);
      count++;
    }
    if (marginQueue.length > 0 && !pool.paused) {
      pool.flushRaf = window.requestAnimationFrame(flushBatch);
    }
  };

  if (pool.flushRaf !== null) {
    window.cancelAnimationFrame(pool.flushRaf);
  }
  pool.flushRaf = window.requestAnimationFrame(flushBatch);
}

function observeLazyMount(
  element: Element,
  scrollRoot: Element | null,
  onEnter: () => void
): () => void {
  let pool = scrollRoot ? lazyObserverPools.get(scrollRoot) ?? null : windowLazyObserverPool;
  if (!pool) {
    const callbacks = new Map<Element, () => void>();
    const intersecting = new Set<Element>();
    const createdPool: LazyObserverPool = {
      observer: null as unknown as IntersectionObserver,
      callbacks,
      paused: false,
      intersecting,
      flushRaf: null,
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (createdPool.paused) {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              createdPool.intersecting.add(entry.target);
            } else {
              createdPool.intersecting.delete(entry.target);
            }
          }
          return;
        }
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          mountLazyTarget(createdPool, entry.target);
        }
      },
      { root: scrollRoot, rootMargin: `${LAZY_MOUNT_MARGIN_PX}px 0px` }
    );
    createdPool.observer = observer;
    pool = createdPool;
    if (scrollRoot) {
      lazyObserverPools.set(scrollRoot, pool);
    } else {
      windowLazyObserverPool = pool;
    }
  }
  const activePool = pool;
  activePool.callbacks.set(element, onEnter);
  activePool.observer.observe(element);
  return () => {
    activePool.intersecting.delete(element);
    if (activePool.callbacks.delete(element)) {
      activePool.observer.unobserve(element);
    }
  };
}

function syncCellEditorLayout(
  view: EditorView,
  fullHeight: boolean,
  forceRefresh = false
): void {
  if (!view.dom.isConnected) return;
  const internal = view as unknown as InternalEditorView;
  const renderFull = shouldRenderFullCellViewport(fullHeight, view.state);

  if (internal.viewState) {
    internal.viewState.printing = renderFull;
    if (forceRefresh) {
      internal.viewState.mustMeasureContent = 'refresh';
    }
  }

  if (view.dom.getClientRects().length === 0) return;

  if (renderFull) {
    internal.measure?.(false);
  } else if (!fullHeight && internal.viewState && internal.measure) {
    // Giant cell (>500 lines): calibrate HeightOracle & visible gutter lines offscreen
    // without forcing CodeMirror to render thousands of lines at once.
    const contentEl = view.contentDOM;
    const prevMaxH = contentEl.style.maxHeight;
    const prevOverflow = contentEl.style.overflow;
    contentEl.style.maxHeight = '1200px';
    contentEl.style.overflow = 'hidden';
    internal.viewState.printing = true;
    internal.viewState.mustMeasureContent = 'refresh';
    try {
      internal.measure(false);
    } finally {
      internal.viewState.printing = false;
      contentEl.style.maxHeight = prevMaxH;
      contentEl.style.overflow = prevOverflow;
    }
  }
}

const pendingPrePaintSyncs = new Map<
  EditorView,
  { fullHeight: boolean; forceRefresh: boolean }
>();
let prePaintFlushQueued = false;

function schedulePrePaintCellSync(
  view: EditorView,
  fullHeight: boolean,
  forceRefresh = false
): void {
  const internal = view as unknown as InternalEditorView;
  if (internal.viewState) {
    internal.viewState.printing = shouldRenderFullCellViewport(fullHeight, view.state);
    if (forceRefresh) {
      internal.viewState.mustMeasureContent = 'refresh';
    }
  }

  const prev = pendingPrePaintSyncs.get(view);
  pendingPrePaintSyncs.set(view, {
    fullHeight,
    forceRefresh: Boolean(prev?.forceRefresh || forceRefresh),
  });

  if (!prePaintFlushQueued) {
    prePaintFlushQueued = true;
    queueMicrotask(() => {
      prePaintFlushQueued = false;
      const batch = Array.from(pendingPrePaintSyncs.entries());
      pendingPrePaintSyncs.clear();
      for (const [v, opts] of batch) {
        syncCellEditorLayout(v, opts.fullHeight, opts.forceRefresh);
      }
    });
  }
}

interface TrackedCellResize {
  view: EditorView;
  getFullHeight: () => boolean;
  lastWidth: number;
}

const resizeTrackedCells = new Map<Element, TrackedCellResize>();
let sharedCellResizeObserver: ResizeObserver | null = null;
let printRestoreInstalled = false;

function observeCellContainerResize(
  container: Element,
  view: EditorView,
  getFullHeight: () => boolean
): () => void {
  if (!printRestoreInstalled && typeof window !== 'undefined') {
    printRestoreInstalled = true;
    window.addEventListener('afterprint', () => {
      window.setTimeout(() => {
        for (const item of resizeTrackedCells.values()) {
          const internal = item.view as unknown as InternalEditorView;
          if (internal.viewState) {
            internal.viewState.printing = shouldRenderFullCellViewport(
              item.getFullHeight(),
              item.view.state
            );
          }
        }
      }, 550);
    });
  }

  if (typeof ResizeObserver === 'undefined') {
    return () => {};
  }

  if (!sharedCellResizeObserver) {
    sharedCellResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const tracked = resizeTrackedCells.get(entry.target);
        if (!tracked) continue;
        const width = entry.contentRect.width;
        if (tracked.lastWidth < 0) {
          tracked.lastWidth = width;
          continue;
        }
        if (Math.abs(width - tracked.lastWidth) <= 0.5) continue;
        const wasHidden = tracked.lastWidth <= 0;
        tracked.lastWidth = width;
        if (width <= 0) continue;
        if (wasHidden) {
          schedulePrePaintCellSync(tracked.view, tracked.getFullHeight(), true);
        } else {
          tracked.view.requestMeasure();
        }
      }
    });
  }

  resizeTrackedCells.set(container, {
    view,
    getFullHeight,
    lastWidth: -1,
  });
  sharedCellResizeObserver.observe(container);

  return () => {
    resizeTrackedCells.delete(container);
    sharedCellResizeObserver?.unobserve(container);
  };
}

function createSaturnoSearchPanel(view: EditorView): Panel {
  let query = getSearchQuery(view.state);
  let caseSensitive = query.caseSensitive;
  let wholeWord = query.wholeWord;
  let regexp = query.regexp;
  let replaceVisible = true;

  const dom = document.createElement('div');
  dom.className = 'cm-search sat-cm-search-panel';
  dom.setAttribute('data-sat-search-panel', 'true');

  // Left chevron toggle for Replace row
  const toggleReplaceBtn = document.createElement('button');
  toggleReplaceBtn.type = 'button';
  toggleReplaceBtn.className = 'sat-cm-search-chevron';
  toggleReplaceBtn.title = 'Mostrar / ocultar Substituir';
  toggleReplaceBtn.setAttribute('aria-label', 'Mostrar ou ocultar Substituir');
  toggleReplaceBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

  const rowsWrap = document.createElement('div');
  rowsWrap.className = 'sat-cm-search-rows';

  // --- ROW 1: FIND ---
  const findRow = document.createElement('div');
  findRow.className = 'sat-cm-search-row';

  const findBox = document.createElement('div');
  findBox.className = 'sat-cm-input-group';

  const findIcon = document.createElement('span');
  findIcon.className = 'sat-cm-input-icon';
  findIcon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.name = 'search';
  searchInput.setAttribute('main-field', 'true');
  searchInput.placeholder = 'Localizar na célula...';
  searchInput.value = query.search;
  searchInput.className = 'cm-textfield sat-cm-input';
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;

  const togglesWrap = document.createElement('div');
  togglesWrap.className = 'sat-cm-toggles';

  const makeTogglePill = (
    label: string,
    title: string,
    isActive: () => boolean,
    onToggle: () => void
  ) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `sat-cm-toggle-pill ${isActive() ? 'is-active' : ''}`;
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute('aria-pressed', String(isActive()));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      onToggle();
      btn.classList.toggle('is-active', isActive());
      btn.setAttribute('aria-pressed', String(isActive()));
      commitQuery();
      searchInput.focus();
    });
    return btn;
  };

  const caseBtn = makeTogglePill(
    'Aa',
    'Diferenciar maiúsculas e minúsculas',
    () => caseSensitive,
    () => {
      caseSensitive = !caseSensitive;
    }
  );
  const wordBtn = makeTogglePill(
    'ab',
    'Palavra inteira',
    () => wholeWord,
    () => {
      wholeWord = !wholeWord;
    }
  );
  const regexBtn = makeTogglePill(
    '.*',
    'Expressão regular (Regex)',
    () => regexp,
    () => {
      regexp = !regexp;
    }
  );

  togglesWrap.append(caseBtn, wordBtn, regexBtn);
  findBox.append(findIcon, searchInput, togglesWrap);

  const countBadge = document.createElement('span');
  countBadge.className = 'sat-cm-match-count';
  countBadge.textContent = '';

  const navGroup = document.createElement('div');
  navGroup.className = 'sat-cm-nav-group';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.name = 'prev';
  prevBtn.className = 'cm-button sat-cm-icon-btn';
  prevBtn.title = 'Ocorrência anterior (Shift+Enter)';
  prevBtn.setAttribute('aria-label', 'Anterior');
  prevBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`;
  prevBtn.addEventListener('click', (e) => {
    e.preventDefault();
    findPrevious(view);
  });

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.name = 'next';
  nextBtn.className = 'cm-button sat-cm-icon-btn';
  nextBtn.title = 'Próxima ocorrência (Enter)';
  nextBtn.setAttribute('aria-label', 'Próximo');
  nextBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>`;
  nextBtn.addEventListener('click', (e) => {
    e.preventDefault();
    findNext(view);
  });

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.name = 'select';
  allBtn.className = 'cm-button sat-cm-action-btn';
  allBtn.title = 'Selecionar todas as ocorrências';
  allBtn.textContent = 'Todos';
  allBtn.addEventListener('click', (e) => {
    e.preventDefault();
    selectMatches(view);
  });

  navGroup.append(prevBtn, nextBtn, allBtn);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.name = 'close';
  closeBtn.className = 'sat-cm-close-btn';
  closeBtn.title = 'Fechar busca (Esc)';
  closeBtn.setAttribute('aria-label', 'Fechar');
  closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    closeSearchPanel(view);
    view.focus();
  });

  findRow.append(findBox, countBadge, navGroup, closeBtn);

  // --- ROW 2: REPLACE ---
  const replaceRow = document.createElement('div');
  replaceRow.className = 'sat-cm-search-row sat-cm-replace-row';

  const replaceBox = document.createElement('div');
  replaceBox.className = 'sat-cm-input-group';

  const replaceIcon = document.createElement('span');
  replaceIcon.className = 'sat-cm-input-icon';
  replaceIcon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`;

  const replaceInput = document.createElement('input');
  replaceInput.type = 'text';
  replaceInput.name = 'replace';
  replaceInput.placeholder = 'Substituir por...';
  replaceInput.value = query.replace;
  replaceInput.className = 'cm-textfield sat-cm-input';
  replaceInput.autocomplete = 'off';
  replaceInput.spellcheck = false;

  replaceBox.append(replaceIcon, replaceInput);

  const replaceActions = document.createElement('div');
  replaceActions.className = 'sat-cm-replace-actions';

  const runSmartReplaceNext = () => {
    commitQuery();
    const curQ = getSearchQuery(view.state);
    if (!curQ.valid) return;
    const sel = view.state.selection.main;
    let selMatches = false;
    if (!sel.empty) {
      const cur = curQ.getCursor(view.state.doc, sel.from, sel.to);
      const step = cur.next();
      if (!step.done && step.value.from === sel.from && step.value.to === sel.to) {
        selMatches = true;
      }
    }
    if (!selMatches) {
      findNext(view);
    }
    replaceNext(view);
  };

  const replaceBtn = document.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.name = 'replace';
  replaceBtn.className = 'cm-button sat-cm-action-btn';
  replaceBtn.title = 'Substituir ocorrência atual (Enter)';
  replaceBtn.textContent = 'Substituir';
  replaceBtn.addEventListener('click', (e) => {
    e.preventDefault();
    runSmartReplaceNext();
  });

  const replaceAllBtn = document.createElement('button');
  replaceAllBtn.type = 'button';
  replaceAllBtn.name = 'replaceAll';
  replaceAllBtn.className = 'cm-button sat-cm-action-btn';
  replaceAllBtn.title = 'Substituir todas as ocorrências na célula';
  replaceAllBtn.textContent = 'Substituir tudo';
  replaceAllBtn.addEventListener('click', (e) => {
    e.preventDefault();
    commitQuery();
    replaceAll(view);
  });

  replaceActions.append(replaceBtn, replaceAllBtn);
  replaceRow.append(replaceBox, replaceActions);

  rowsWrap.append(findRow, replaceRow);
  dom.append(toggleReplaceBtn, rowsWrap);

  const updateReplaceVisibility = () => {
    replaceRow.style.display = replaceVisible ? 'flex' : 'none';
    toggleReplaceBtn.innerHTML = replaceVisible
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
  };

  toggleReplaceBtn.addEventListener('click', (e) => {
    e.preventDefault();
    replaceVisible = !replaceVisible;
    updateReplaceVisibility();
  });

  const updateMatchCount = () => {
    const q = getSearchQuery(view.state);
    if (!q.search) {
      countBadge.textContent = '';
      countBadge.removeAttribute('data-empty');
      return;
    }
    if (!q.valid) {
      countBadge.textContent = 'Regex inválida';
      countBadge.setAttribute('data-empty', 'true');
      return;
    }
    try {
      const cursor = q.getCursor(view.state.doc);
      const sel = view.state.selection.main;
      let total = 0;
      let currentIdx = 0;
      let item = cursor.next();
      while (!item.done && total < 2000) {
        total++;
        const { from, to } = item.value;
        if (currentIdx === 0 && from >= sel.from) {
          currentIdx = total;
        }
        if (from === sel.from && to === sel.to) {
          currentIdx = total;
        }
        item = cursor.next();
      }
      if (total === 0) {
        countBadge.textContent = '0 resultados';
        countBadge.setAttribute('data-empty', 'true');
      } else {
        if (currentIdx === 0) currentIdx = 1;
        countBadge.textContent = `${currentIdx} de ${total}${total >= 2000 ? '+' : ''}`;
        countBadge.removeAttribute('data-empty');
      }
    } catch {
      countBadge.textContent = '';
    }
  };

  const commitQuery = () => {
    const nextQ = new SearchQuery({
      search: searchInput.value,
      replace: replaceInput.value,
      caseSensitive,
      wholeWord,
      regexp,
    });
    if (!nextQ.eq(query)) {
      query = nextQ;
      view.dispatch({ effects: setSearchQuery.of(nextQ) });
    }
    updateMatchCount();
  };

  searchInput.addEventListener('input', commitQuery);
  replaceInput.addEventListener('input', commitQuery);

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commitQuery();
      if (e.shiftKey) {
        findPrevious(view);
      } else {
        findNext(view);
      }
      updateMatchCount();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSearchPanel(view);
      view.focus();
    }
  });

  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey || e.altKey) {
        commitQuery();
        replaceAll(view);
      } else {
        runSmartReplaceNext();
      }
      updateMatchCount();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSearchPanel(view);
      view.focus();
    }
  });

  dom.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSearchPanel(view);
      view.focus();
    }
  });

  return {
    dom,
    top: true,
    mount() {
      searchInput.focus();
      searchInput.select();
      updateMatchCount();
    },
    update(update: ViewUpdate) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setSearchQuery)) {
            query = effect.value;
            if (searchInput.value !== query.search) {
              searchInput.value = query.search;
            }
            if (replaceInput.value !== query.replace) {
              replaceInput.value = query.replace;
            }
            caseSensitive = query.caseSensitive;
            wholeWord = query.wholeWord;
            regexp = query.regexp;
            caseBtn.classList.toggle('is-active', caseSensitive);
            wordBtn.classList.toggle('is-active', wholeWord);
            regexBtn.classList.toggle('is-active', regexp);
          }
        }
      }
      if (update.docChanged || update.selectionSet || update.transactions.length > 0) {
        updateMatchCount();
      }
    },
  };
}

const PYTHON_KEYWORDS_AND_BUILTINS: { label: string; type: string; detail?: string }[] = [
  { label: 'import', type: 'keyword' },
  { label: 'from', type: 'keyword' },
  { label: 'def', type: 'keyword' },
  { label: 'return', type: 'keyword' },
  { label: 'class', type: 'keyword' },
  { label: 'for', type: 'keyword' },
  { label: 'while', type: 'keyword' },
  { label: 'if', type: 'keyword' },
  { label: 'elif', type: 'keyword' },
  { label: 'else', type: 'keyword' },
  { label: 'try', type: 'keyword' },
  { label: 'except', type: 'keyword' },
  { label: 'finally', type: 'keyword' },
  { label: 'with', type: 'keyword' },
  { label: 'as', type: 'keyword' },
  { label: 'lambda', type: 'keyword' },
  { label: 'True', type: 'keyword' },
  { label: 'False', type: 'keyword' },
  { label: 'None', type: 'keyword' },
  { label: 'print', type: 'function', detail: '(*values, ...)' },
  { label: 'len', type: 'function', detail: '(obj)' },
  { label: 'range', type: 'function', detail: '(start, stop, step)' },
  { label: 'enumerate', type: 'function', detail: '(iterable, start=0)' },
  { label: 'zip', type: 'function', detail: '(*iterables)' },
  { label: 'sorted', type: 'function', detail: '(iterable, key=None, reverse=False)' },
  { label: 'sum', type: 'function', detail: '(iterable, start=0)' },
  { label: 'min', type: 'function', detail: '(iterable)' },
  { label: 'max', type: 'function', detail: '(iterable)' },
  { label: 'round', type: 'function', detail: '(number, ndigits=None)' },
  { label: 'isinstance', type: 'function', detail: '(obj, class_or_tuple)' },
  { label: 'list', type: 'class', detail: '(iterable=())' },
  { label: 'dict', type: 'class', detail: '(**kwargs)' },
  { label: 'set', type: 'class', detail: '(iterable=())' },
  { label: 'str', type: 'class', detail: '(object="")' },
  { label: 'int', type: 'class', detail: '(x=0)' },
  { label: 'float', type: 'class', detail: '(x=0.0)' },
];

const COMMON_DATAFRAME_METHODS: { label: string; type: string; detail: string }[] = [
  { label: 'head', type: 'method', detail: '(n=5)' },
  { label: 'tail', type: 'method', detail: '(n=5)' },
  { label: 'info', type: 'method', detail: '()' },
  { label: 'describe', type: 'method', detail: '()' },
  { label: 'groupby', type: 'method', detail: '(by=None, as_index=True)' },
  { label: 'sort_values', type: 'method', detail: '(by, ascending=True)' },
  { label: 'value_counts', type: 'method', detail: '(normalize=False)' },
  { label: 'fillna', type: 'method', detail: '(value=None)' },
  { label: 'dropna', type: 'method', detail: '(axis=0, how="any")' },
  { label: 'drop', type: 'method', detail: '(labels=None, columns=None)' },
  { label: 'rename', type: 'method', detail: '(columns=None)' },
  { label: 'reset_index', type: 'method', detail: '(drop=False)' },
  { label: 'set_index', type: 'method', detail: '(keys)' },
  { label: 'merge', type: 'method', detail: '(right, how="inner", on=None)' },
  { label: 'join', type: 'method', detail: '(other, on=None, how="left")' },
  { label: 'apply', type: 'method', detail: '(func, axis=0)' },
  { label: 'astype', type: 'method', detail: '(dtype)' },
  { label: 'isna', type: 'method', detail: '()' },
  { label: 'isnull', type: 'method', detail: '()' },
  { label: 'nunique', type: 'method', detail: '()' },
  { label: 'unique', type: 'method', detail: '()' },
  { label: 'corr', type: 'method', detail: '(method="pearson")' },
  { label: 'pivot_table', type: 'method', detail: '(values=None, index=None, columns=None)' },
  { label: 'query', type: 'method', detail: '(expr)' },
  { label: 'sample', type: 'method', detail: '(n=None, frac=None)' },
  { label: 'copy', type: 'method', detail: '(deep=True)' },
  { label: 'to_csv', type: 'method', detail: '(path_or_buf=None, index=True)' },
  { label: 'to_excel', type: 'method', detail: '(excel_writer, index=True)' },
  { label: 'to_parquet', type: 'method', detail: '(path=None)' },
  { label: 'to_dict', type: 'method', detail: '(orient="dict")' },
  { label: 'loc', type: 'property', detail: 'indexador por rótulo' },
  { label: 'iloc', type: 'property', detail: 'indexador por posição' },
  { label: 'columns', type: 'property', detail: 'Index de colunas' },
  { label: 'shape', type: 'property', detail: '(linhas, colunas)' },
  { label: 'dtypes', type: 'property', detail: 'tipos das colunas' },
  { label: 'index', type: 'property', detail: 'Index das linhas' },
  { label: 'values', type: 'property', detail: 'ndarray' },
];

function getNotebookContextForCell(cellId?: string) {
  const state = useSaturnoStore.getState();
  const activeTab = findNotebookTabForCell(state.tabs, state.activeTabId, cellId);
  if (!activeTab || activeTab.kind !== 'notebook') {
    return { notebookPath: '', contextCode: '', variables: [] };
  }
  const codeCells: string[] = [];
  for (const c of activeTab.cells) {
    if (c.id === cellId) break;
    if (c.cell_type === 'code' && c.source.trim()) {
      codeCells.push(c.source);
    }
  }
  return {
    notebookPath: activeTab.path,
    contextCode: codeCells.join('\n\n'),
    variables: activeTab.variables || [],
  };
}

const saturnoHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.operatorKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
    ],
    color: 'var(--sat-syn-keyword)',
    fontWeight: '600',
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: 'var(--sat-syn-string)',
  },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom],
    color: 'var(--sat-syn-number)',
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: 'var(--sat-syn-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.definition(tags.variableName),
    ],
    color: 'var(--sat-syn-function)',
  },
  {
    tag: [tags.className, tags.typeName, tags.definition(tags.typeName), tags.namespace],
    color: 'var(--sat-syn-class)',
    fontWeight: '600',
  },
  {
    tag: [tags.operator, tags.compareOperator, tags.arithmeticOperator, tags.logicOperator],
    color: 'var(--sat-syn-operator)',
  },
  {
    tag: [tags.standard(tags.variableName), tags.self],
    color: 'var(--sat-syn-builtin)',
  },
  {
    tag: [tags.meta, tags.annotation, tags.processingInstruction],
    color: 'var(--sat-syn-meta)',
  },
  {
    tag: tags.heading,
    color: 'var(--sat-accent)',
    fontWeight: '700',
  },
  {
    tag: tags.emphasis,
    fontStyle: 'italic',
  },
  {
    tag: tags.strong,
    fontWeight: '700',
  },
]);

const saturnoEditorTheme = EditorView.theme({
  '&': {
    color: 'var(--sat-text-primary)',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    caretColor: 'var(--sat-accent)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--sat-accent)',
    borderLeftWidth: '2px',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--sat-accent-soft)',
    color: 'var(--sat-text-primary) !important',
    outline: '1px solid var(--sat-border-strong)',
  },
});

interface QuickDocState {
  x: number;
  y: number;
  loading: boolean;
  data: KernelInspectResponse | null;
  detailLevel: number;
  cursorPos: number;
}

interface Props {
  cellId?: string;
  value: string;
  language: 'python' | 'markdown';
  theme: 'light' | 'dark';
  showLineNumbers: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  fullHeight?: boolean;
  placeholder?: string;
  searchTriggerSeq?: number;
  onChange: (val: string) => void;
  onFocus?: () => void;
  onShiftEnter?: () => void;
  onCtrlEnter?: () => void;
  onAltEnter?: () => void;
  onNavigate?: (down: boolean) => boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onToggleType?: () => void;
  onDeleteCell?: () => void;
  onEscape?: () => void;
  onSave: () => void;
  onTriggerAI?: (selection: { from: number; to: number; text: string } | null) => void;
}

export const CodeMirrorCellEditor: React.FC<Props> = React.memo(({
  cellId,
  value,
  language,
  theme,
  showLineNumbers,
  readOnly = false,
  autoFocus,
  fullHeight = false,
  placeholder,
  searchTriggerSeq,
  onChange,
  onFocus,
  onShiftEnter,
  onCtrlEnter,
  onAltEnter,
  onNavigate,
  onMoveUp,
  onMoveDown,
  onToggleType,
  onDeleteCell,
  onEscape,
  onSave,
  onTriggerAI,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(Boolean(autoFocus || fullHeight));
  const viewRef = useRef<EditorView | null>(null);
  const lastValueRef = useRef<string>((value || '').replace(/\r\n/g, '\n'));
  const cellIdRef = useRef(cellId);
  cellIdRef.current = cellId;
  const fullHeightRef = useRef(fullHeight);
  fullHeightRef.current = fullHeight;

  const pendingTextChangeRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<number | null>(null);

  const flushPendingDoc = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (pendingTextChangeRef.current !== null) {
      const textToEmit = pendingTextChangeRef.current;
      pendingTextChangeRef.current = null;
      cbRef.current.onChange(textToEmit);
    }
  }, []);

  const fallbackEditorId = useId();
  useEffect(() => {
    // Always key by per-instance useId() so split views or copied notebooks sharing a cellId never collide.
    const unreg = registerEditorFlusher(fallbackEditorId, flushPendingDoc);
    return () => {
      unreg();
      flushPendingDoc();
    };
  }, [fallbackEditorId, flushPendingDoc]);

  const [quickDoc, setQuickDoc] = useState<QuickDocState | null>(null);
  const quickDocRef = useRef<HTMLDivElement>(null);
  const quickDocActiveRef = useRef(false);
  quickDocActiveRef.current = Boolean(quickDoc);
  const inspectAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      inspectAbortRef.current?.abort();
      inspectAbortRef.current = null;
    };
  }, []);

  const langCompartment = useRef(new Compartment());
  const lineNumCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const appliedOptions = useRef({ language, showLineNumbers, readOnly });

  const cbRef = useRef({
    onChange,
    onFocus,
    onShiftEnter,
    onCtrlEnter,
    onAltEnter,
    onNavigate,
    onMoveUp,
    onMoveDown,
    onToggleType,
    onDeleteCell,
    onEscape,
    onSave,
    onTriggerAI,
  });
  cbRef.current = {
    onChange,
    onFocus,
    onShiftEnter,
    onCtrlEnter,
    onAltEnter,
    onNavigate,
    onMoveUp,
    onMoveDown,
    onToggleType,
    onDeleteCell,
    onEscape,
    onSave,
    onTriggerAI,
  };

  const inspectAtCursor = useCallback(async (view: EditorView, detailLevel = 0) => {
    inspectAbortRef.current?.abort();
    const controller = new AbortController();
    inspectAbortRef.current = controller;

    const pos = view.state.selection.main.head;
    const coords = view.coordsAtPos(pos) || view.dom.getBoundingClientRect();
    const x = Math.max(12, Math.min(window.innerWidth - 520, coords.left));
    const y =
      coords.bottom + 320 > window.innerHeight
        ? Math.max(12, coords.top - 280)
        : coords.bottom + 6;

    setQuickDoc({
      x,
      y,
      loading: true,
      data: null,
      detailLevel,
      cursorPos: pos,
    });

    const docText = view.state.doc.toString();
    const { notebookPath, contextCode } = getNotebookContextForCell(cellIdRef.current);
    try {
      const res = await api.inspectCode(
        notebookPath,
        docText,
        pos,
        detailLevel,
        contextCode,
        controller.signal
      );
      if (controller.signal.aborted) return;
      setQuickDoc((prev) =>
        prev && prev.cursorPos === pos ? { ...prev, loading: false, data: res } : prev
      );
    } catch {
      if (controller.signal.aborted) return;
      setQuickDoc((prev) =>
        prev && prev.cursorPos === pos
          ? { ...prev, loading: false, data: { found: false } }
          : prev
      );
    }
  }, []);

  // Close QuickDoc when clicking outside
  useEffect(() => {
    if (!quickDoc) return;
    const onPointerDown = (e: PointerEvent) => {
      if (quickDocRef.current?.contains(e.target as Node)) return;
      setQuickDoc(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [quickDoc]);

  // Open search/replace panel when triggered from cell toolbar or menu
  useEffect(() => {
    if (!searchTriggerSeq) return;
    if (!ready) {
      setReady(true);
    }
    const timer = window.setTimeout(() => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      openSearchPanel(view);
      const replaceInput = view.dom.querySelector<HTMLInputElement>(
        '.cm-search input[name="replace"]'
      );
      const searchInput = view.dom.querySelector<HTMLInputElement>(
        '.cm-search input[name="search"]'
      );
      if (searchInput && !searchInput.value) {
        searchInput.focus();
      } else if (replaceInput) {
        replaceInput.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [searchTriggerSeq, ready]);

  // Resolve initial visibility before paint, so visible cells never show the
  // unhighlighted offscreen placeholder. Keep far-away editors lazy via a
  // single shared IntersectionObserver per notebook scroll container.
  useLayoutEffect(() => {
    if (ready || !containerRef.current) return;
    if (autoFocus || typeof IntersectionObserver === 'undefined') {
      setReady(true);
      return;
    }
    const container = containerRef.current;
    const scrollRoot = container.closest('[data-notebook-scroll]');
    const bounds = container.getBoundingClientRect();
    const viewport = scrollRoot?.getBoundingClientRect();
    if (
      container.getClientRects().length &&
      bounds.bottom >= (viewport?.top ?? 0) - LAZY_MOUNT_MARGIN_PX &&
      bounds.top <= (viewport?.bottom ?? window.innerHeight) + LAZY_MOUNT_MARGIN_PX
    ) {
      setReady(true);
      return;
    }
    return observeLazyMount(container, scrollRoot, () => setReady(true));
  }, [ready, autoFocus]);

  useLayoutEffect(() => {
    if (!ready || !containerRef.current) return;

    const initialNormalized = (value || '').replace(/\r\n/g, '\n');
    lastValueRef.current = initialNormalized;
    appliedOptions.current = { language, showLineNumbers, readOnly };

    const triggerAIHandler = (view: EditorView) => {
      flushPendingDoc();
      if (!cbRef.current.onTriggerAI) return false;
      setQuickDoc(null);
      if (completionStatus(view.state) === 'active') {
        closeCompletion(view);
      }
      const sel = view.state.selection.main;
      if (!sel.empty) {
        cbRef.current.onTriggerAI({
          from: sel.from,
          to: sel.to,
          text: view.state.sliceDoc(sel.from, sel.to),
        });
      } else {
        cbRef.current.onTriggerAI(null);
      }
      return true;
    };

    const openReplacePanel = (view: EditorView) => {
      setQuickDoc(null);
      if (completionStatus(view.state) === 'active') {
        closeCompletion(view);
      }
      openSearchPanel(view);
      window.requestAnimationFrame(() => {
        const searchInput = view.dom.querySelector<HTMLInputElement>(
          '.cm-search input[name="search"]'
        );
        const replaceInput = view.dom.querySelector<HTMLInputElement>(
          '.cm-search input[name="replace"]'
        );
        if (searchInput && searchInput.value && replaceInput) {
          replaceInput.focus();
          replaceInput.select();
        } else if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      });
      return true;
    };

    const pythonCompletionSource = async (
      context: CompletionContext
    ): Promise<CompletionResult | null> => {
      if (appliedOptions.current.language !== 'python') return null;

      const docText = context.state.doc.toString();
      const pos = context.pos;
      const beforeCursor = docText.slice(0, pos);

      if (!context.explicit && !/(?:\b[A-Za-z_]\w*\.|\b[A-Za-z_]\w*\[\s*['"]?)$/.test(beforeCursor)) {
        return null;
      }

      const { notebookPath, contextCode, variables } = getNotebookContextForCell(
        cellIdRef.current
      );

      let fromPos = pos;
      const wordMatch = beforeCursor.match(/[A-Za-z_]\w*$/);
      if (wordMatch) {
        fromPos = pos - wordMatch[0].length;
      }

      const seen = new Set<string>();
      const options: Completion[] = [];

      const abortController = new AbortController();
      context.addEventListener('abort', () => abortController.abort());

      try {
        const res = await api.completeCode(notebookPath, docText, pos, contextCode, abortController.signal);
        if (typeof res.from === 'number') {
          fromPos = res.from;
        }
        for (const opt of res.options || []) {
          if (!opt.label || seen.has(opt.label)) continue;
          seen.add(opt.label);
          options.push({
            label: opt.label,
            type: opt.type || 'variable',
            detail: opt.detail || undefined,
            boost: opt.boost ?? 0,
          });
        }
      } catch {
        // Fallback to local completions below
      }

      // Local fallback enrichment from notebook variables & cell code
      const dotMatch = beforeCursor.match(/\b([A-Za-z_]\w*)\.([A-Za-z0-9_]*)$/);
      const bracketMatch = beforeCursor.match(
        /\b([A-Za-z_]\w*)\[\s*(?:\[\s*)?(['"]?)([^'"\]]*)$/
      );
      const varMap = new Map(variables.map((v) => [v.name, v]));

      if (dotMatch) {
        const objName = dotMatch[1];
        const vInfo = varMap.get(objName);
        if (vInfo) {
          for (const col of vInfo.columns || []) {
            if (/^[A-Za-z_]\w*$/.test(col.name) && !seen.has(col.name)) {
              seen.add(col.name);
              options.push({
                label: col.name,
                type: 'property',
                detail: `coluna · ${col.dtype}`,
                boost: 30,
              });
            }
          }
          if (vInfo.type === 'DataFrame' || vInfo.type === 'Series') {
            for (const m of COMMON_DATAFRAME_METHODS) {
              if (!seen.has(m.label)) {
                seen.add(m.label);
                options.push({
                  label: m.label,
                  type: m.type,
                  detail: m.detail,
                  boost: 12,
                });
              }
            }
          }
        }
      } else if (bracketMatch) {
        const objName = bracketMatch[1];
        const quoteChar = bracketMatch[2];
        const partial = bracketMatch[3];
        fromPos = pos - partial.length;
        const vInfo = varMap.get(objName);
        if (vInfo?.columns) {
          for (const col of vInfo.columns) {
            const label = quoteChar ? col.name : `"${col.name}"`;
            if (!seen.has(label)) {
              seen.add(label);
              options.push({
                label,
                type: 'property',
                detail: `coluna · ${col.dtype}`,
                boost: 30,
              });
            }
          }
        }
      } else {
        for (const v of variables) {
          if (!seen.has(v.name)) {
            seen.add(v.name);
            options.push({
              label: v.name,
              type: 'variable',
              detail: `${v.type} ${v.shape}`.trim(),
              boost: 20,
            });
          }
        }
        // Extract identifiers defined in the notebook/cell
        const fullSource = `${contextCode}\n${docText}`;
        const idMatches = fullSource.match(/\b[A-Za-z_][A-Za-z0-9_]{1,}\b/g) || [];
        const currentWord = wordMatch ? wordMatch[0] : '';
        for (const token of idMatches) {
          if (token === currentWord || seen.has(token)) continue;
          seen.add(token);
          options.push({
            label: token,
            type: 'variable',
            boost: 5,
          });
        }
        for (const kw of PYTHON_KEYWORDS_AND_BUILTINS) {
          if (!seen.has(kw.label)) {
            seen.add(kw.label);
            options.push({
              label: kw.label,
              type: kw.type,
              detail: kw.detail,
              boost: 2,
            });
          }
        }
      }

      if (options.length === 0) return null;

      return {
        from: fromPos,
        to: pos,
        options,
        validFor: /^[A-Za-z0-9_'"]*$/,
      };
    };

    const saturnoKeymap = Prec.highest(
      keymap.of([
        { key: 'Mod-y', run: redo, preventDefault: true },
        { key: 'Mod-Shift-z', run: redo, preventDefault: true },
        ...["'", '"'].map(quote => ({
          key: quote,
          run: (view: EditorView) => {
            if (view.composing || view.state.readOnly) return false;
            const transaction = insertBracket(view.state, quote);
            if (!transaction) return false;
            view.dispatch(transaction);
            return true;
          },
        })),
        ...['ArrowUp', 'ArrowDown'].map(key => ({
          key,
          run: (view: EditorView) => {
            const selection = view.state.selection.main;
            if (!selection.empty || view.state.selection.ranges.length !== 1 || completionStatus(view.state) === 'active') return false;
            const down = key === 'ArrowDown';
            const edge = view.moveToLineBoundary(selection, down, true).head;
            if (edge !== (down ? view.state.doc.length : 0)) return false;
            return cbRef.current.onNavigate?.(down) ?? false;
          },
        })),
        {
          key: 'Shift-Enter',
          run: (view) => {
            flushPendingDoc();
            if (!cbRef.current.onShiftEnter) return false;
            setQuickDoc(null);
            view.contentDOM.blur();
            cbRef.current.onShiftEnter();
            return true;
          },
        },
        {
          key: 'Mod-Enter',
          run: () => {
            flushPendingDoc();
            if (!cbRef.current.onCtrlEnter) return false;
            setQuickDoc(null);
            cbRef.current.onCtrlEnter();
            return true;
          },
        },
        {
          key: 'Alt-Enter',
          run: () => {
            flushPendingDoc();
            if (!cbRef.current.onAltEnter) return false;
            setQuickDoc(null);
            cbRef.current.onAltEnter();
            return true;
          },
        },
        {
          key: 'Mod-Shift-Enter',
          run: () => {
            flushPendingDoc();
            if (!cbRef.current.onAltEnter) return false;
            setQuickDoc(null);
            cbRef.current.onAltEnter();
            return true;
          },
        },
        {
          key: 'Mod-i',
          run: triggerAIHandler,
        },
        {
          key: 'Mod-k',
          run: triggerAIHandler,
        },
        {
          key: 'Mod-f',
          run: (view) => {
            setQuickDoc(null);
            if (completionStatus(view.state) === 'active') {
              closeCompletion(view);
            }
            return openSearchPanel(view);
          },
        },
        {
          key: 'Mod-h',
          run: openReplacePanel,
        },
        {
          key: 'Mod-Alt-f',
          run: openReplacePanel,
        },
        {
          key: 'Alt-ArrowUp',
          run: () => {
            if (!cbRef.current.onMoveUp) return false;
            cbRef.current.onMoveUp();
            return true;
          },
        },
        {
          key: 'Alt-ArrowDown',
          run: () => {
            if (!cbRef.current.onMoveDown) return false;
            cbRef.current.onMoveDown();
            return true;
          },
        },
        {
          key: 'Mod-m',
          run: () => {
            if (!cbRef.current.onToggleType) return false;
            cbRef.current.onToggleType();
            return true;
          },
        },
        {
          key: 'Mod-Shift-Backspace',
          run: () => {
            if (!cbRef.current.onDeleteCell) return false;
            cbRef.current.onDeleteCell();
            return true;
          },
        },
        {
          key: 'Mod-s',
          run: () => {
            flushPendingDoc();
            cbRef.current.onSave();
            return true;
          },
        },
        {
          key: 'Tab',
          run: (view) => {
            if (completionStatus(view.state) === 'active') {
              return acceptCompletion(view);
            }
            const sel = view.state.selection.main;
            if (!sel.empty) {
              return indentMore(view);
            }
            const line = view.state.doc.lineAt(sel.head);
            const beforeOnLine = line.text.slice(0, sel.head - line.from);
            if (/^\s*$/.test(beforeOnLine) || appliedOptions.current.language !== 'python') {
              return indentMore(view);
            }
            return startCompletion(view);
          },
        },
        {
          key: 'Shift-Tab',
          run: (view) => {
            const sel = view.state.selection.main;
            if (!sel.empty) {
              return indentLess(view);
            }
            const line = view.state.doc.lineAt(sel.head);
            const beforeOnLine = line.text.slice(0, sel.head - line.from);
            if (/^\s*$/.test(beforeOnLine) || appliedOptions.current.language !== 'python') {
              return indentLess(view);
            }
            if (completionStatus(view.state) === 'active') {
              closeCompletion(view);
            }
            void inspectAtCursor(view, 0);
            return true;
          },
        },
        {
          key: 'Escape',
          run: (view) => {
            if (quickDocActiveRef.current) {
              setQuickDoc(null);
              return true;
            }
            if (completionStatus(view.state) === 'active') {
              return closeCompletion(view);
            }
            if (searchPanelOpen(view.state)) {
              return closeSearchPanel(view);
            }
            if (!cbRef.current.onEscape) return false;
            view.contentDOM.blur();
            cbRef.current.onEscape();
            return true;
          },
        },
      ])
    );

    const state = EditorState.create({
      doc: initialNormalized,
      extensions: [
        saturnoKeymap,
        history(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        search({ top: true, createPanel: createSaturnoSearchPanel }),
        highlightSelectionMatches(),
        tooltips({
          parent: getSharedTooltipHost(),
          tooltipSpace: getEditorTooltipSpace,
        }),
        autocompletion({
          activateOnTyping: true,
          override: [pythonCompletionSource],
          icons: true,
          defaultKeymap: true,
        }),
        highlightActiveLine(),
        saturnoEditorTheme,
        syntaxHighlighting(saturnoHighlightStyle, { fallback: true }),
        keymap.of([...closeBracketsKeymap, ...searchKeymap, ...defaultKeymap, ...historyKeymap]),
        langCompartment.current.of(
          language === 'python' ? python() : createMarkdownExtension()
        ),
        lineNumCompartment.current.of(showLineNumbers ? lineNumbers() : []),
        readOnlyCompartment.current.of(
          readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
        ),
        placeholder ? cmPlaceholder(placeholder) : [],
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const internal = update.view as unknown as InternalEditorView;
            if (internal.viewState) {
              internal.viewState.printing = shouldRenderFullCellViewport(
                fullHeightRef.current,
                update.state
              );
            }
            if (!update.transactions.some((tr) => tr.annotation(externalSyncAnnotation))) {
              const nextDoc = update.state.doc.toString();
              if (nextDoc !== lastValueRef.current) {
                lastValueRef.current = nextDoc;
                pendingTextChangeRef.current = nextDoc;
                if (debounceTimerRef.current !== null) {
                  clearTimeout(debounceTimerRef.current);
                }
                debounceTimerRef.current = window.setTimeout(() => {
                  debounceTimerRef.current = null;
                  if (pendingTextChangeRef.current !== null) {
                    const textToEmit = pendingTextChangeRef.current;
                    pendingTextChangeRef.current = null;
                    cbRef.current.onChange(textToEmit);
                  }
                }, 60);
              }
            }
          }
          if (update.focusChanged) {
            if (update.view.hasFocus) {
              cbRef.current.onFocus?.();
            } else {
              flushPendingDoc();
            }
          }
        }),
      ],
    });

    const containerEl = containerRef.current;
    const view = new EditorView({
      state,
      parent: containerEl,
    });
    viewRef.current = view;

    // Pre-measure cell line heights & gutter alignment before browser paint even when
    // lazy-mounted inside the offscreen scroll margin, avoiding unmeasured cm-gap / gutter jumps.
    schedulePrePaintCellSync(view, fullHeightRef.current);
    const unobserveResize = observeCellContainerResize(
      containerEl,
      view,
      () => fullHeightRef.current
    );

    if (autoFocus) view.focus();

    return () => {
      pendingPrePaintSyncs.delete(view);
      unobserveResize();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const normalizedIncoming = (value || '').replace(/\r\n/g, '\n');
    if (normalizedIncoming !== lastValueRef.current) {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      pendingTextChangeRef.current = null;
      lastValueRef.current = normalizedIncoming;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: normalizedIncoming },
        annotations: externalSyncAnnotation.of(true),
      });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || appliedOptions.current.language === language) return;
    appliedOptions.current.language = language;
    view.dispatch({
      effects: langCompartment.current.reconfigure(
        language === 'python' ? python() : createMarkdownExtension()
      ),
    });
  }, [language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || appliedOptions.current.showLineNumbers === showLineNumbers) return;
    appliedOptions.current.showLineNumbers = showLineNumbers;
    view.dispatch({
      effects: lineNumCompartment.current.reconfigure(
        showLineNumbers ? lineNumbers() : []
      ),
    });
  }, [showLineNumbers]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || appliedOptions.current.readOnly === readOnly) return;
    appliedOptions.current.readOnly = readOnly;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
      ),
    });
  }, [readOnly]);

  useEffect(() => {
    if (autoFocus && viewRef.current && !viewRef.current.hasFocus) {
      viewRef.current.focus();
    } else if (autoFocus === false && viewRef.current && viewRef.current.hasFocus) {
      viewRef.current.contentDOM.blur();
    }
  }, [autoFocus]);

  const isShowingPlaceholder = !value && Boolean(placeholder);
  const previewLines = !ready
    ? (value ? value.replace(/\r\n/g, '\n') : placeholder || ' ').split('\n')
    : null;
  const previewDigits = previewLines ? String(previewLines.length).length : 1;

  return (
    <>
      <div
        ref={containerRef}
        className={`saturno-cm-wrapper w-full ${fullHeight ? 'h-full overflow-y-auto' : ''}`}
        onClick={
          !ready
            ? (e) => {
                e.stopPropagation();
                setReady(true);
                cbRef.current.onFocus?.();
              }
            : undefined
        }
      >
        {previewLines && (
          <pre
            className={`editor-source-preview ${showLineNumbers ? 'has-line-numbers' : ''}`}
            style={
              showLineNumbers
                ? ({ '--sat-preview-digits': previewDigits } as React.CSSProperties)
                : undefined
            }
          >
            {previewLines.map((line, index) => (
              <span className="editor-preview-line" key={index}>
                {showLineNumbers && (
                  <span className="editor-preview-number" aria-hidden="true">
                    {index + 1}
                  </span>
                )}
                <span
                  className={`editor-preview-source ${isShowingPlaceholder ? 'is-placeholder' : ''}`}
                >
                  {line || ' '}
                </span>
              </span>
            ))}
          </pre>
        )}
      </div>

      {quickDoc &&
        createPortal(
          <div
            ref={quickDocRef}
            data-sat-quickdoc-popover="true"
            onClick={(e) => e.stopPropagation()}
            style={{
              top: `${quickDoc.y}px`,
              left: `${quickDoc.x}px`,
              backgroundColor: 'var(--sat-bg-surface)',
              borderColor: 'var(--sat-border-strong)',
              color: 'var(--sat-text-primary)',
            }}
            className="fixed z-[130] w-[520px] max-w-[calc(100vw-24px)] max-h-[340px] rounded-[5px] border shadow-2xl flex flex-col overflow-hidden text-xs"
          >
            <div
              className="h-8 px-3 flex items-center justify-between gap-2 border-b shrink-0 select-none"
              style={{
                backgroundColor: 'var(--sat-bg-subtle)',
                borderColor: 'var(--sat-border)',
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <BookOpen size={13} className="shrink-0" style={{ color: 'var(--sat-accent)' }} />
                <span className="font-mono font-semibold text-xs truncate">
                  {quickDoc.loading
                    ? 'Inspecionando documentação...'
                    : quickDoc.data?.found
                      ? quickDoc.data.name || 'Documentação Rápida'
                      : 'Documentação Rápida (Shift+Tab)'}
                </span>
                {quickDoc.data?.type_name && (
                  <span
                    className="font-mono text-[10.5px] px-1.5 py-0.5 rounded-[2px] shrink-0"
                    style={{
                      backgroundColor: 'var(--sat-accent-soft)',
                      color: 'var(--sat-accent)',
                    }}
                  >
                    {quickDoc.data.type_name}
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={() => setQuickDoc(null)}
                className="sat-icon-btn p-1"
                title="Fechar documentação (Esc)"
                aria-label="Fechar documentação"
              >
                <X size={13} />
              </button>
            </div>

            <div className="p-3 overflow-y-auto space-y-2.5 flex-1 min-h-0">
              {quickDoc.loading ? (
                <div
                  className="py-6 flex items-center justify-center gap-2 text-xs"
                  style={{ color: 'var(--sat-text-muted)' }}
                >
                  <Loader2 size={14} className="animate-spin" />
                  <span>Consultando assinatura e docstring...</span>
                </div>
              ) : !quickDoc.data?.found ? (
                <div className="py-3 text-xs" style={{ color: 'var(--sat-text-muted)' }}>
                  Nenhuma documentação encontrada para o símbolo sob o cursor. Execute a célula ou posicione o cursor sobre uma função, método ou variável.
                </div>
              ) : (
                <>
                  {quickDoc.data.signature && (
                    <pre
                      data-sat-quickdoc-signature="true"
                      className="m-0 p-2 rounded-[3px] border font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words"
                      style={{
                        backgroundColor: 'var(--sat-bg-canvas)',
                        borderColor: 'var(--sat-border)',
                        color: 'var(--sat-syn-function)',
                      }}
                    >
                      {quickDoc.data.signature}
                    </pre>
                  )}

                  {quickDoc.data.string_form && !quickDoc.data.signature && (
                    <pre
                      className="m-0 p-2 rounded-[3px] border font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words"
                      style={{
                        backgroundColor: 'var(--sat-bg-canvas)',
                        borderColor: 'var(--sat-border)',
                        color: 'var(--sat-text-secondary)',
                      }}
                    >
                      {quickDoc.data.string_form}
                    </pre>
                  )}

                  {quickDoc.data.docstring ? (
                    <pre
                      data-sat-quickdoc-docstring="true"
                      className="m-0 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words"
                      style={{ color: 'var(--sat-text-primary)' }}
                    >
                      {quickDoc.data.docstring}
                    </pre>
                  ) : (
                    <div className="text-[11px] italic" style={{ color: 'var(--sat-text-muted)' }}>
                      Sem docstring adicional.
                    </div>
                  )}

                  {quickDoc.data.file && (
                    <div
                      className="pt-1.5 border-t font-mono text-[10.5px] truncate"
                      style={{
                        borderColor: 'var(--sat-border-subtle)',
                        color: 'var(--sat-text-muted)',
                      }}
                      title={quickDoc.data.file}
                    >
                      Arquivo: {quickDoc.data.file}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
});
