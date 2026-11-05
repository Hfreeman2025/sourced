import { button, element, required } from './dom';

/** The language reference and compiled-JavaScript dialogs. A click on the
 * backdrop (outside the dialog's box) closes them, as Escape does. */
export function installDialogs(reference: string, compiled: () => string) {
  const guide = required('#guide-dialog', HTMLDialogElement),
    javascript = required('#js-dialog', HTMLDialogElement);
  required('#reference', HTMLDivElement).innerHTML = reference;
  required('#guide-open', HTMLButtonElement).addEventListener('click', () => guide.showModal());
  required('#js-open', HTMLButtonElement).addEventListener('click', () => {
    required('#compiled-code', HTMLPreElement).textContent = compiled();
    javascript.showModal();
  });
  for (const dialog of [guide, javascript]) {
    dialog.querySelector('.dialog-close')?.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      )
        dialog.close();
    });
  }
}

/** On phones, Sensitivity and Derivation share one panel behind two tabs. */
export function installAnalysisTabs() {
  const show = (lineage: boolean) => {
    document.body.classList.toggle('show-lineage', lineage);
    required('#sensitivity-tab', HTMLButtonElement).setAttribute('aria-selected', String(!lineage));
    required('#lineage-tab', HTMLButtonElement).setAttribute('aria-selected', String(lineage));
  };
  required('#sensitivity-tab', HTMLButtonElement).addEventListener('click', () => show(false));
  required('#lineage-tab', HTMLButtonElement).addEventListener('click', () => show(true));
  for (const id of ['sensitivity-tab', 'lineage-tab'])
    required(`#${id}`, HTMLButtonElement).addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      show(id === 'sensitivity-tab');
      required(
        id === 'sensitivity-tab' ? '#lineage-tab' : '#sensitivity-tab',
        HTMLButtonElement,
      ).focus();
    });
}

/** Everything runs locally, so offline only changes the notice, not what works. */
export function installNetworkStatus() {
  const update = () => {
    document.body.classList.toggle('offline', !navigator.onLine);
    required('#network-status', HTMLSpanElement).textContent = navigator.onLine
      ? 'Local calculation'
      : 'Offline · calculations available';
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

/** A brief status message beside the example actions. */
export function announce(message: string) {
  const toast = required('#toast', HTMLSpanElement);
  toast.textContent = message;
  toast.title = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 1800);
}

/** Copies the program, or says how to copy it where the clipboard is unavailable. */
export function installCopyCode(code: () => string) {
  required('#copy-code', HTMLButtonElement).addEventListener('click', () => {
    if (!navigator.clipboard) {
      announce('Select the code to copy it; clipboard access is unavailable.');
      return;
    }
    navigator.clipboard
      .writeText(code())
      .then(() => announce('Code copied.'))
      .catch(() => announce('Clipboard unavailable. Select the code to copy it.'));
  });
}

/** The examples as tabs on wide screens and a select on phones. Arrow keys,
 * Home and End move between tabs, as the ARIA tab pattern expects. */
export function installExampleChooser(titles: string[], choose: (index: number) => void) {
  const tabs = required('#examples', HTMLDivElement),
    select = required('#example-select', HTMLSelectElement);
  titles.forEach((title, index) => {
    const tab = button(title, 'example-tab', () => choose(index));
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'workbench');
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? titles.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + titles.length) % titles.length;
      choose(next);
      tabs.querySelectorAll('button')[next]?.focus();
    });
    tabs.append(tab);
    const option = element('option', '', title);
    option.value = String(index);
    select.append(option);
  });
  select.addEventListener('change', () => choose(Number(select.value)));
  return {
    /** Shows which example is open. */
    mark(index: number) {
      tabs.querySelectorAll('button').forEach((tab, i) => {
        tab.setAttribute('aria-selected', String(i === index));
        tab.tabIndex = i === index ? 0 : -1;
      });
      select.value = String(index);
    },
    enable() {
      select.disabled = false;
    },
  };
}
