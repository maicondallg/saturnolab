import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Annotation, EditorState, Compartment } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { closeBrackets, autocompletion } from '@codemirror/autocomplete';

const externalSyncAnnotation = Annotation.define<boolean>();

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

interface Props {
  value: string;
  language: 'python' | 'markdown';
  theme: 'light' | 'dark';
  showLineNumbers: boolean;
  autoFocus?: boolean;
  fullHeight?: boolean;
  placeholder?: string;
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
  value,
  language,
  theme,
  showLineNumbers,
  autoFocus,
  fullHeight = false,
  placeholder,
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
    if (container.getClientRects().length && bounds.bottom >= (viewport?.top ?? 0) - 400
        && bounds.top <= (viewport?.bottom ?? window.innerHeight) + 400) {
      setReady(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setReady(true);
        observer.disconnect();
      }
    }, { root: containerRef.current.closest('[data-notebook-scroll]'), rootMargin: '400px 0px' });
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

    const saturnoKeymap = keymap.of([
      {
        key: 'Shift-Enter',
        run: () => {
          if (!cbRef.current.onShiftEnter) return false;
          cbRef.current.onShiftEnter();
          return true;
        },
      },
      {
        key: 'Mod-Enter',
        run: () => {
          if (!cbRef.current.onCtrlEnter) return false;
          cbRef.current.onCtrlEnter();
          return true;
        },
      },
      {
        key: 'Alt-Enter',
        run: () => {
          if (!cbRef.current.onAltEnter) return false;
          cbRef.current.onAltEnter();
          return true;
        },
      },
      {
        key: 'Mod-Shift-Enter',
        run: () => {
          if (!cbRef.current.onAltEnter) return false;
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
        key: 'Escape',
        run: (view) => {
          if (!cbRef.current.onEscape) return false;
          view.contentDOM.blur();
          cbRef.current.onEscape();
          return true;
        },
      },
      indentWithTab,
    ]);

    const state = EditorState.create({
      doc: initialNormalized,
      extensions: [
        saturnoKeymap,
        history(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: false }),
        highlightActiveLine(),
        saturnoEditorTheme,
        syntaxHighlighting(saturnoHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        langCompartment.current.of(language === 'python' ? python() : markdown()),
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
    // Local edits already updated this ref; avoid serializing the document again.
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
        language === 'python' ? python() : markdown()
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
    }
  }, [autoFocus]);

  return (
    <div
      ref={containerRef}
      className={`saturno-cm-wrapper w-full ${fullHeight ? 'h-full overflow-y-auto' : ''}`}
      onClick={!ready ? (e) => { e.stopPropagation(); setReady(true); cbRef.current.onFocus?.(); } : undefined}
    >
      {!ready && (
        <pre className={`editor-source-preview ${showLineNumbers ? 'has-line-numbers' : ''}`}>
          {(value || placeholder || ' ').split('\n').map((line, index) => (
            <span className="editor-preview-line" key={index}>
              {showLineNumbers && <span className="editor-preview-number" aria-hidden="true">{index + 1}</span>}
              <span className="editor-preview-source">{line || ' '}</span>
            </span>
          ))}
        </pre>
      )}
    </div>
  );
};
