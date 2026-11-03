export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function required<T extends HTMLElement>(
  selector: string,
  type: { new (...args: never[]): T },
): T {
  const node = document.querySelector(selector);
  if (!(node instanceof type)) throw new Error(`Missing UI element: ${selector}`);
  return node;
}
export function button(label: string, className: string, action: () => void): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
