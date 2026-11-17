import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Annotation, EditorState, Compartment, Prec } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
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
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
  closeSearchPanel,
  searchPanelOpen,
} from '@codemirror/search';
import { BookOpen, Loader2, X } from 'lucide-react';
import { api } from '../services/api';
import { useSaturnoStore } from '../store/useSaturnoStore';
import { KernelInspectResponse } from '../types/notebook';

function createMarkdownExtension() {
  return new LanguageSupport(markdownLanguage, Prec.high(keymap.of(markdownKeymap)));
}

const externalSyncAnnotation = Annotation.define<boolean>();

const saturnoPtPhrases = EditorState.phrases.of({
  Find: 'Localizar...',
  Replace: 'Substituir por...',
  next: 'Próximo',
  previous: 'Anterior',
  all: 'Todos',
  'match case': 'Maiúsc./minúsc.',
  'by word': 'Palavra inteira',
  regexp: 'Regex',
  literal: 'Literal',
  replace: 'Substituir',
  'replace all': 'Substituir tudo',
  close: 'Fechar (Esc)',
  'Go to line': 'Ir para a linha',
  go: 'Ir',
});

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
  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
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
  autoFocus?: boolean;
  fullHeight?: boolean;
  placeholder?: string;
  searchTriggerSeq?: number;
  onChange: (val: string) => void;
  onFocus?: () => void;
  onShiftEnter?: () => void;
  onCtrlEnter?: () => void;
  onAltEnter?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onToggleType?: () => void;
  onDeleteCell?: () => void;
  onEscape?: () => void;
  onSave: () => void;
  onTriggerAI?: (selection: { from: number; to: number; text: string } | null) => void;
}

export const CodeMirrorCellEditor: React.FC<Props> = ({
  cellId,
  value,
  language,
  theme,
  showLineNumbers,
  autoFocus,
  fullHeight = false,
  placeholder,
  searchTriggerSeq,
  onChange,
  onFocus,
  onShiftEnter,
  onCtrlEnter,
  onAltEnter,
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

  const [quickDoc, setQuickDoc] = useState<QuickDocState | null>(null);
  const quickDocRef = useRef<HTMLDivElement>(null);
  const quickDocActiveRef = useRef(false);
  quickDocActiveRef.current = Boolean(quickDoc);

  const langCompartment = useRef(new Compartment());
  const lineNumCompartment = useRef(new Compartment());
  const appliedOptions = useRef({ language, showLineNumbers });

  const cbRef = useRef({
    onChange,
    onFocus,
    onShiftEnter,
    onCtrlEnter,
    onAltEnter,
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
    onMoveUp,
    onMoveDown,
    onToggleType,
    onDeleteCell,
    onEscape,
    onSave,
    onTriggerAI,
  };

  const inspectAtCursor = useCallback(async (view: EditorView, detailLevel = 0) => {
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
      const res = await api.inspectCode(notebookPath, docText, pos, detailLevel, contextCode);
      setQuickDoc((prev) =>
        prev && prev.cursorPos === pos ? { ...prev, loading: false, data: res } : prev
      );
    } catch {
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
  // unhighlighted offscreen placeholder. Keep far-away editors lazy.
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
      bounds.bottom >= (viewport?.top ?? 0) - 400 &&
      bounds.top <= (viewport?.bottom ?? window.innerHeight) + 400
    ) {
      setReady(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setReady(true);
          observer.disconnect();
        }
      },
      { root: containerRef.current.closest('[data-notebook-scroll]'), rootMargin: '400px 0px' }
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [ready, autoFocus]);

  useLayoutEffect(() => {
    if (!ready || !containerRef.current) return;

    const initialNormalized = (value || '').replace(/\r\n/g, '\n');
    lastValueRef.current = initialNormalized;
    appliedOptions.current = { language, showLineNumbers };

    const triggerAIHandler = (view: EditorView) => {
      if (!cbRef.current.onTriggerAI) return false;
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

      try {
        const res = await api.completeCode(notebookPath, docText, pos, contextCode);
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
        {
          key: 'Shift-Enter',
          run: (view) => {
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
            if (!cbRef.current.onCtrlEnter) return false;
            setQuickDoc(null);
            cbRef.current.onCtrlEnter();
            return true;
          },
        },
        {
          key: 'Alt-Enter',
          run: () => {
            if (!cbRef.current.onAltEnter) return false;
            setQuickDoc(null);
            cbRef.current.onAltEnter();
            return true;
          },
        },
        {
          key: 'Mod-Shift-Enter',
          run: () => {
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
          run: (view) => openSearchPanel(view),
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
        saturnoPtPhrases,
        saturnoKeymap,
        history(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        search({ top: true }),
        highlightSelectionMatches(),
        autocompletion({
          activateOnTyping: false,
          override: [pythonCompletionSource],
          icons: true,
          defaultKeymap: true,
        }),
        highlightActiveLine(),
        saturnoEditorTheme,
        syntaxHighlighting(saturnoHighlightStyle, { fallback: true }),
        keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
        langCompartment.current.of(
          language === 'python' ? python() : createMarkdownExtension()
        ),
        lineNumCompartment.current.of(showLineNumbers ? lineNumbers() : []),
        placeholder ? cmPlaceholder(placeholder) : [],
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged &&
            !update.transactions.some((tr) => tr.annotation(externalSyncAnnotation))
          ) {
            const nextDoc = update.state.doc.toString();
            if (nextDoc !== lastValueRef.current) {
              lastValueRef.current = nextDoc;
              cbRef.current.onChange(nextDoc);
            }
          }
          if (update.focusChanged && update.view.hasFocus) {
            cbRef.current.onFocus?.();
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;

    if (autoFocus) view.focus();

    return () => {
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
    if (autoFocus && viewRef.current && !viewRef.current.hasFocus) {
      viewRef.current.focus();
    } else if (autoFocus === false && viewRef.current && viewRef.current.hasFocus) {
      viewRef.current.contentDOM.blur();
    }
  }, [autoFocus]);

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
        {!ready && (
          <pre className={`editor-source-preview ${showLineNumbers ? 'has-line-numbers' : ''}`}>
            {(value || placeholder || ' ').split('\n').map((line, index) => (
              <span className="editor-preview-line" key={index}>
                {showLineNumbers && (
                  <span className="editor-preview-number" aria-hidden="true">
                    {index + 1}
                  </span>
                )}
                <span className="editor-preview-source">{line || ' '}</span>
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
};
