import { isolateHistory, undo, undoDepth } from '@codemirror/commands';
import { type ChangeSpec, type EditorState, Transaction } from '@codemirror/state';

/** An editor to dispatch to: an EditorView, or a bare state holder in tests. */
export interface HistoryTarget {
  readonly state: EditorState;
  dispatch(transaction: Transaction): void;
}

/**
 * The undo history of one drag on a number.
 *
 * Every frame of the drag edits the document inside history, stamped with the
 * time the drag began, so CodeMirror joins the frames into one undo step however
 * long the drag lasts. Frames kept out of history would instead be mapped into
 * every earlier undo step, and undoing an earlier edit that covered the number
 * (Reset, or typing it) would then leave the preview's digits behind.
 */
export function scrubHistory(target: HistoryTarget) {
  const startedAt = Date.now();
  const depth = undoDepth(target.state);
  let edited = false;
  const frame = (changes: ChangeSpec) => {
    target.dispatch(
      target.state.update({
        changes,
        annotations: [
          Transaction.time.of(startedAt),
          Transaction.userEvent.of('input.type.scrub'),
          ...(edited ? [] : [isolateHistory.of('before')]),
        ],
      }),
    );
    edited = true;
  };
  const close = () =>
    target.dispatch(target.state.update({ annotations: isolateHistory.of('after') }));
  return {
    /** Shows one frame of the drag. */
    frame,
    /** Keeps the drag as one undo step. */
    keep: close,
    /**
     * Takes back a cancelled drag, or one that ended on its starting value:
     * `restore`, if given, puts the number back inside the drag's own step, and
     * that step is then undone, so the drag leaves nothing to undo and redoing
     * it changes nothing visible. If something split the drag into several steps,
     * the restore stays as a step of its own rather than undoing only part of it.
     */
    withdraw(restore?: ChangeSpec) {
      if (edited) {
        if (restore) frame(restore);
        if (undoDepth(target.state) === depth + 1) undo(target);
      }
      close();
    },
  };
}
