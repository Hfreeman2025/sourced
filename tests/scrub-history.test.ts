import { test } from 'node:test';
import assert from 'node:assert/strict';
import { history, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import { type HistoryTarget, scrubHistory } from '../src/ui/scrub-history';

const before = 'let usage = 200 kWh @bill\nprint usage';
const code = 'let usage = 284 kWh @bill\nprint usage';
const at = code.indexOf('284');

/** An editor whose last edit is a whole-document replacement, as Reset and the
 * Adjust field make: the undo step a drag on the number must not disturb. */
function editor(): HistoryTarget & { text: () => string } {
  let state = EditorState.create({ doc: before, extensions: history() });
  const target = {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      state = transaction.state;
    },
    text: () => state.doc.toString(),
  };
  target.dispatch(state.update({ changes: { from: 0, to: before.length, insert: code } }));
  return target;
}
/** Drags the number through `values`, advancing the clock between frames. */
function drag(target: HistoryTarget, values: string[], tick = () => {}) {
  const gesture = scrubHistory(target);
  let end = at + 3;
  for (const value of values) {
    tick();
    gesture.frame({ from: at, to: end, insert: value });
    end = at + value.length;
  }
  return { gesture, end };
}

test('a drag is one undo step, however long it lasts, and earlier steps undo exactly', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const target = editor();
  // Two seconds between frames: far longer than the history's grouping delay.
  drag(target, ['290', '1002', '314'], () => t.mock.timers.tick(2000)).gesture.keep();
  assert.equal(target.text(), code.replace('284', '314'));
  assert.equal(undoDepth(target.state), 2);
  undo(target);
  assert.equal(target.text(), code);
  // Before the fix, the preview frames were mapped into this step, and undoing
  // it left their digits at the end of the document.
  undo(target);
  assert.equal(target.text(), before);
  redo(target);
  redo(target);
  assert.equal(target.text(), code.replace('284', '314'));
});

test('a cancelled drag leaves nothing to undo, and redoing it changes nothing', () => {
  const target = editor();
  const { gesture, end } = drag(target, ['290', '314']);
  gesture.withdraw({ from: at, to: end, insert: '284' });
  assert.equal(target.text(), code);
  assert.equal(undoDepth(target.state), 1);
  assert.equal(redoDepth(target.state), 1);
  redo(target);
  assert.equal(target.text(), code);
  // The redone step is that no-op; the earlier edit is intact beneath it.
  undo(target);
  undo(target);
  assert.equal(target.text(), before);
});

test('a drag that ends on its starting value leaves nothing to undo', () => {
  const target = editor();
  drag(target, ['290', '284']).gesture.withdraw();
  assert.equal(target.text(), code);
  assert.equal(undoDepth(target.state), 1);
  undo(target);
  assert.equal(target.text(), before);
});

test('a press without a drag never undoes an earlier edit', () => {
  const target = editor();
  scrubHistory(target).withdraw({ from: at, to: at + 3, insert: '284' });
  assert.equal(target.text(), code);
  assert.equal(undoDepth(target.state), 1);
});

test('a drag split by a selection change is restored, not partly undone', () => {
  const target = editor();
  const gesture = scrubHistory(target);
  gesture.frame({ from: at, to: at + 3, insert: '290' });
  target.dispatch(target.state.update({ selection: EditorSelection.cursor(0) }));
  gesture.frame({ from: at, to: at + 3, insert: '314' });
  gesture.withdraw({ from: at, to: at + 3, insert: '284' });
  assert.equal(target.text(), code);
  undo(target);
  undo(target);
  undo(target);
  assert.equal(target.text(), before);
});
