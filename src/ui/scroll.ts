import { ViewPlugin } from '@codemirror/view';
/** CodeMirror 6.38 measures synchronously in its native scroll observer. Queue
 * geometry work through its public API instead: one measurement per frame,
 * outside the scroll event. This keeps Firefox's asynchronous panning intact. */
export const deferredEditorScroll = ViewPlugin.fromClass(
  class {
    private readonly scroll: (event: Event) => void;
    constructor(private readonly view: import('@codemirror/view').EditorView) {
      this.scroll = (event) => {
        event.stopImmediatePropagation();
        view.requestMeasure();
      };
      view.scrollDOM.addEventListener('scroll', this.scroll, { capture: true, passive: true });
    }
    destroy() {
      this.view.scrollDOM.removeEventListener('scroll', this.scroll, true);
    }
  },
);
