import { StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { collectInputs, replaceInput, scrubValue, type InputLiteral } from '../analysis/inputs';
import type { Span } from '../lang/types';
export const traceEffect = StateEffect.define<Span[]>();
const marks = (source: string, trace: Span[]): DecorationSet =>
  Decoration.set(
    [
      ...collectInputs(source).map((input) =>
        Decoration.mark({
          class: input.role === 'spread' ? 'scrub-number spread-number' : 'scrub-number',
          attributes: {
            'data-input': input.id,
            title:
              input.role === 'spread'
                ? `Drag to reshape the uncertainty: ${input.label}. Alt: fine. Shift: coarse.`
                : `Drag ${input.label} left or right. Alt: fine. Shift: coarse. The Adjust field is the keyboard alternative.`,
          },
        }).range(input.start, input.end),
      ),
      ...trace
        .filter((span) => span.start >= 0 && span.end <= source.length && span.end > span.start)
        .map((span) => Decoration.mark({ class: 'dependency-token' }).range(span.start, span.end)),
    ],
    true,
  );
export const numberField = StateField.define<{ decorations: DecorationSet; trace: Span[] }>({
  create(state) {
    return { decorations: marks(state.doc.toString(), []), trace: [] };
  },
  update(value, transaction) {
    let trace = transaction.docChanged ? [] : value.trace;
    for (const effect of transaction.effects) if (effect.is(traceEffect)) trace = effect.value;
    return transaction.docChanged || transaction.effects.some((effect) => effect.is(traceEffect))
      ? { decorations: marks(transaction.state.doc.toString(), trace), trace }
      : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});
export interface ScrubCallbacks {
  select: (input: InputLiteral) => void;
  gesture: (active: boolean, input: InputLiteral, value: number) => void;
}
export function installScrubbing(view: EditorView, callbacks: ScrubCallbacks) {
  let active:
    | { input: InputLiteral; x: number; end: number; pointer: number; value: number }
    | undefined;
  let frame = 0,
    pending: PointerEvent | undefined;
  const apply = () => {
    frame = 0;
    if (!active || !pending) return;
    const value = scrubValue(
      active.input,
      pending.clientX - active.x,
      pending.altKey,
      pending.shiftKey,
    );
    if (!Number.isFinite(value) || value === active.value) return;
    const source = view.state.doc.toString();
    const next = replaceInput(source, { ...active.input, end: active.end }, value);
    const inserted = next.slice(active.input.start, next.length - (source.length - active.end));
    view.dispatch({
      changes: { from: active.input.start, to: active.end, insert: inserted },
      annotations: Transaction.addToHistory.of(false),
    });
    active.end = active.input.start + inserted.length;
    active.value = value;
    callbacks.gesture(true, active.input, value);
  };
  const finish = (cancel = false) => {
    if (!active) return;
    cancelAnimationFrame(frame);
    frame = 0;
    if (!cancel) apply();
    const current = active;
    const finalToken = view.state.doc.sliceString(current.input.start, current.end);
    if (finalToken !== current.input.raw) {
      // Preview frames stay out of history. Restore without history, then commit
      // one real edit so a complete gesture is one undo, regardless of duration.
      view.dispatch({
        changes: { from: current.input.start, to: current.end, insert: current.input.raw },
        annotations: Transaction.addToHistory.of(false),
      });
      if (!cancel)
        view.dispatch({
          changes: {
            from: current.input.start,
            to: current.input.start + current.input.raw.length,
            insert: finalToken,
          },
          annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.type.scrub')],
        });
    }
    active = undefined;
    pending = undefined;
    if (view.dom.hasPointerCapture(current.pointer))
      view.dom.releasePointerCapture(current.pointer);
    view.dispatch({ annotations: isolateHistory.of('after') });
    document.body.classList.remove('is-scrubbing');
    callbacks.gesture(false, current.input, cancel ? current.input.value : current.value);
  };
  const down = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target.closest('[data-input]') : null;
    if (!target || event.button !== 0) return;
    const input = collectInputs(view.state.doc.toString()).find(
      (item) => item.id === target.getAttribute('data-input'),
    );
    if (!input) return;
    event.preventDefault();
    event.stopPropagation();
    callbacks.select(input);
    active = {
      input,
      x: event.clientX,
      end: input.end,
      pointer: event.pointerId,
      value: input.value,
    };
    view.dom.setPointerCapture(event.pointerId);
    document.body.classList.add('is-scrubbing');
    callbacks.gesture(true, input, input.value);
  };
  const move = (event: PointerEvent) => {
    if (!active) return;
    event.preventDefault();
    pending = event;
    if (!frame) frame = requestAnimationFrame(apply);
  };
  const up = () => finish();
  const cancel = () => finish(true);
  const key = (event: KeyboardEvent) => {
    if (active && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    }
  };
  view.dom.addEventListener('pointerdown', down, true);
  view.dom.addEventListener('pointermove', move);
  view.dom.addEventListener('pointerup', up);
  view.dom.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
  return () => {
    finish(true);
    view.dom.removeEventListener('pointerdown', down, true);
    view.dom.removeEventListener('pointermove', move);
    view.dom.removeEventListener('pointerup', up);
    view.dom.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
  };
}
