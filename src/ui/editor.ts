import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  gutters,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory,
} from '@codemirror/commands';
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { setDiagnostics, lintGutter } from '@codemirror/lint';
import { autocompletion } from '@codemirror/autocomplete';
import type { Diagnostic, Span } from '../lang/types';
import { unitNames } from '../lang/units';
import { deferredEditorScroll } from './scroll';
import { numberField, traceEffect, installScrubbing, type ScrubCallbacks } from './scrub';
const language = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return 'string';
    if (stream.match(/@\w+(?:\.\w+)*/)) return 'attributeName';
    if (stream.match(/\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/)) return 'number';
    if (stream.match(/\b(source|let|assume|assumed|fn|print|as|page|year|url)\b/)) return 'keyword';
    if (stream.match(/\b(sum|round|sqrt|normal|lognormal|triangular|uniform)\b/))
      return 'variableName.function';
    if (stream.match(/[a-zA-Z_£%Ω](?:\w|\.(?=\w))*/)) return 'variableName';
    stream.next();
    return 'operator';
  },
});
const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: '#233fa4' },
  { tag: tags.number, color: '#9f4100' },
  { tag: tags.string, color: '#516154' },
  { tag: tags.attributeName, color: '#233fa4', fontWeight: '600' },
  { tag: tags.comment, color: '#687178', fontStyle: 'normal' },
  { tag: tags.function(tags.variableName), color: '#3b4687' },
]);
export function createEditor(
  parent: HTMLElement,
  code: string,
  onChange: (code: string) => void,
  onRun: () => void,
  scrub: ScrubCallbacks,
) {
  // `view` is assigned below; the keymap reads it only when a key is pressed.
  let view: EditorView;
  const extensions = [
        deferredEditorScroll,
        numberField,
        gutters({ fixed: false }),
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        lintGutter(),
        language,
        syntaxHighlighting(highlighting),
        EditorView.contentAttributes.of({
          'aria-label': 'Sourced code editor',
          spellcheck: 'false',
          autocapitalize: 'off',
          autocorrect: 'off',
        }),
        EditorView.lineWrapping,
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              onRun();
              return true;
            },
          },
          {
            key: 'Escape',
            run: () => {
              view.contentDOM.blur();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        autocompletion({
          override: [
            (context) => {
              const word = context.matchBefore(/[\w.]+/);
              if (!word || (!context.explicit && word.from === word.to)) return null;
              return {
                from: word.from,
                options: [
                  ...['source', 'let', 'assume', 'assumed', 'fn', 'print', 'as', 'sum', 'round', 'sqrt'],
                  ...['normal', 'lognormal', 'triangular', 'uniform'],
                  ...unitNames,
                ].map((label) => ({ label, type: unitNames.includes(label) ? 'type' : 'keyword' })),
              };
            },
          ],
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
  ];
  view = new EditorView({ parent, state: EditorState.create({ doc: code, extensions }) });
  installScrubbing(view, scrub);
  return {
    view,
    trace(spans: Span[]) {
      view.dispatch({ effects: traceEffect.of(spans) });
    },
    setCode(code: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
        selection: { anchor: 0 },
      });
      view.scrollDOM.scrollTop = 0;
    },
    diagnostics(items: Diagnostic[]) {
      view.dispatch(
        setDiagnostics(
          view.state,
          items.map((item) => ({
            from: Math.min(item.start, view.state.doc.length),
            to: Math.min(Math.max(item.end, item.start + 1), view.state.doc.length),
            severity: 'error',
            message: `${item.message} ${item.hint}`,
          })),
        ),
      );
    },
    /** A different document with its own undo history: switching examples is
     * navigation, so Undo never swaps another example's code back in. */
    load(code: string) {
      view.setState(EditorState.create({ doc: code, extensions }));
      view.scrollDOM.scrollTop = 0;
    },
    /** One insertion that is exactly one undo step. */
    insert(at: number, text: string) {
      const position = Math.min(at, view.state.doc.length);
      view.dispatch({
        changes: { from: position, insert: text },
        selection: { anchor: position + text.length },
        userEvent: 'input.type',
        annotations: isolateHistory.of('full'),
      });
    },
    reveal(span: Span) {
      view.dispatch({
        selection: {
          anchor: Math.min(span.start, view.state.doc.length),
          head: Math.min(span.end, view.state.doc.length),
        },
        effects: EditorView.scrollIntoView(Math.min(span.start, view.state.doc.length), {
          y: 'center',
        }),
      });
    },
  };
}
