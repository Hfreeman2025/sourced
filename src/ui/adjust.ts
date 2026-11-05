import type { InputLiteral } from '../analysis/inputs';
import { element, required } from './dom';

/** The Adjust bar: the keyboard and touch alternative to dragging a number.
 * It lists the program's quantities and edits the selected one by value. */
export function createAdjustBar(actions: {
  /** Shows a quantity's place in the code. */
  reveal: (input: InputLiteral) => void;
  /** Sets a quantity to a typed, finite value. */
  apply: (input: InputLiteral, value: number) => void;
}) {
  const select = required('#input-select', HTMLSelectElement),
    field = required('#quantity-input', HTMLInputElement),
    unit = required('#input-unit', HTMLSpanElement),
    error = required('#quantity-error', HTMLSpanElement);
  let inputs: InputLiteral[] = [],
    selected = '';
  const current = () => inputs.find((input) => input.id === selected);

  function show(next: InputLiteral[]) {
    inputs = next;
    if (!inputs.some((input) => input.id === selected)) selected = inputs[0]?.id ?? '';
    // Rebuild the options only when the set of quantities changes, so a drag
    // that rewrites one number never resets the list under the pointer.
    const signature = inputs.map((input) => input.id).join('|');
    if (select.dataset.signature !== signature) {
      select.replaceChildren(
        ...inputs.map((input) => {
          const option = element('option', '', input.label);
          option.value = input.id;
          return option;
        }),
      );
      select.dataset.signature = signature;
    }
    select.value = selected;
    const input = current();
    field.disabled = !input;
    select.disabled = !input;
    if (input) {
      if (document.activeElement !== field) field.value = String(input.value);
      field.step = String(input.step);
      unit.textContent = input.unit || 'ratio';
    } else {
      field.value = '';
      unit.textContent = '';
    }
  }

  select.addEventListener('change', () => {
    selected = select.value;
    show(inputs);
    const input = current();
    if (input) actions.reveal(input);
  });
  required('#adjust-form', HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    field.blur();
  });
  field.addEventListener('input', () => {
    const input = current(),
      value = field.valueAsNumber,
      valid = Number.isFinite(value);
    field.setAttribute('aria-invalid', String(!valid));
    error.textContent = valid ? '' : 'Enter a finite value.';
    if (input && valid) actions.apply(input, value);
  });
  field.addEventListener('blur', () => {
    if (!Number.isFinite(field.valueAsNumber)) show(inputs);
  });
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    field.value = String(current()?.value ?? '');
    field.removeAttribute('aria-invalid');
    error.textContent = '';
    field.blur();
  });

  return {
    show,
    /** Selects a quantity by id; the next `show` falls back to the first if it is gone. */
    choose(id: string) {
      selected = id;
    },
    focus() {
      field.focus({ preventScroll: true });
    },
  };
}
