import React, { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
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
  const viewRef = useRef<EditorView | null>(null);

  const langCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const lineNumCompartment = useRef(new Compartment());

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

  useEffect(() => {
    if (!containerRef.current) return;

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
      doc: value,
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
        themeCompartment.current.of([]),
        lineNumCompartment.current.of(showLineNumbers ? lineNumbers() : []),
        placeholder ? cmPlaceholder(placeholder) : [],
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            cbRef.current.onChange(update.state.doc.toString());
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

    if (autoFocus) {
      setTimeout(() => view.focus(), 10);
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (value !== currentDoc) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: langCompartment.current.reconfigure(
        language === 'python' ? python() : markdown()
      ),
    });
  }, [language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure([]),
    });
  }, [theme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
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
    />
  );
};
