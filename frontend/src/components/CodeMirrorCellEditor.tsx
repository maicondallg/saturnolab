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
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { closeBrackets, autocompletion } from '@codemirror/autocomplete';

interface Props {
  value: string;
  language: 'python' | 'markdown';
  theme: 'light' | 'dark';
  showLineNumbers: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  onChange: (val: string) => void;
  onFocus?: () => void;
  onShiftEnter: () => void;
  onCtrlEnter: () => void;
  onAltEnter: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleType: () => void;
  onDeleteCell: () => void;
  onEscape: () => void;
  onSave: () => void;
  onTriggerAI: (selection: { from: number; to: number; text: string } | null) => void;
}

export const CodeMirrorCellEditor: React.FC<Props> = ({
  value,
  language,
  theme,
  showLineNumbers,
  autoFocus,
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
          cbRef.current.onShiftEnter();
          return true;
        },
      },
      {
        key: 'Mod-Enter',
        run: () => {
          cbRef.current.onCtrlEnter();
          return true;
        },
      },
      {
        key: 'Alt-Enter',
        run: () => {
          cbRef.current.onAltEnter();
          return true;
        },
      },
      {
        key: 'Mod-Shift-Enter',
        run: () => {
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
          cbRef.current.onMoveUp();
          return true;
        },
      },
      {
        key: 'Alt-ArrowDown',
        run: () => {
          cbRef.current.onMoveDown();
          return true;
        },
      },
      {
        key: 'Mod-m',
        run: () => {
          cbRef.current.onToggleType();
          return true;
        },
      },
      {
        key: 'Mod-Shift-Backspace',
        run: () => {
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
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        langCompartment.current.of(language === 'python' ? python() : markdown()),
        themeCompartment.current.of(theme === 'dark' ? oneDark : []),
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
      effects: themeCompartment.current.reconfigure(theme === 'dark' ? oneDark : []),
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

  return <div ref={containerRef} className="saturno-cm-wrapper w-full" />;
};
