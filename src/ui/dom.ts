/**
 * A small hyperscript layer. No framework, no runtime dependency: views are
 * plain functions that return DOM nodes.
 *
 * Text always goes through `textContent`, so user-entered payee names and memos
 * can never be interpreted as markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'text',
  'tspan', 'defs', 'linearGradient', 'stop', 'clipPath', 'title', 'pattern',
]);

/** Anything acceptable as a child; nullish and `false` are skipped. */
export type Child = Node | string | number | null | undefined | false | Child[];

/**
 * Element properties. Recognised keys:
 *   `text`     sets textContent (the safe default for all user data)
 *   `class`    merged with any classes in the tag string
 *   `style`    an object of CSS properties
 *   `dataset`  an object of data-* values
 *   `on*`      an event listener, e.g. `onclick`
 * Anything else becomes a property when the element has one, otherwise an
 * attribute.
 */
export interface Props {
  text?: string | number;
  class?: string;
  style?: Record<string, string>;
  dataset?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Create an element. The tag may carry an id and classes: `'span#total.muted'`.
 *
 * The element type is a caller-supplied parameter rather than something derived
 * from the tag, because the tag string is not a bare tag name. Callers needing a
 * specific element ask for it — `h<HTMLInputElement>('input.input')` — and the
 * default covers the common case.
 */
export function h<T extends Element = HTMLElement>(
  tag: string,
  props?: Props | null,
  ...children: Child[]
): T {
  const { name, id, classes } = parseTag(tag);
  const element = SVG_TAGS.has(name)
    ? document.createElementNS(SVG_NS, name)
    : document.createElement(name);
  if (id) element.id = id;
  if (classes.length) element.classList.add(...classes);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') {
      for (const cls of String(value).split(/\s+/).filter(Boolean)) element.classList.add(cls);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(element.style, value);
    } else if (key === 'dataset') {
      Object.assign((element as HTMLElement).dataset, value);
    } else if (key === 'text') {
      element.textContent = String(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key in element && !SVG_TAGS.has(name) && typeof value !== 'object') {
      try {
        (element as unknown as Record<string, unknown>)[key] = value;
      } catch {
        element.setAttribute(key, String(value));
      }
    } else {
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(element, children);
  return element as unknown as T;
}

function parseTag(tag: string): { name: string; id: string | undefined; classes: string[] } {
  const [head = '', ...classes] = tag.split('.');
  const [name, id] = head.split('#');
  // Split on whitespace too — classList.add() rejects tokens containing spaces.
  return {
    name: name || 'div',
    id,
    classes: classes.flatMap((cls) => cls.split(/\s+/)).filter(Boolean),
  };
}

/** Accepts children as an array or as varargs; nested arrays are flattened. */
export function append<T extends Node>(parent: T, ...children: Child[]): T {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, ...child);
      continue;
    }
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear<T extends Node>(node: T): T {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount<T extends Node>(node: T, ...children: Child[]): T {
  clear(node);
  return append(node, children);
}

/** `qs('.foo')` scoped to the document or a root. */
export const qs = <T extends Element = HTMLElement>(
  selector: string,
  root: Document | Element = document,
): T | null => root.querySelector<T>(selector);

export const qsa = <T extends Element = HTMLElement>(
  selector: string,
  root: Document | Element = document,
): T[] => [...root.querySelectorAll<T>(selector)];

/** Debounce for input handlers. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms = 200,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focus the first focusable element inside a container. */
export function focusFirst(container: Element | null): void {
  const target = container?.querySelector<HTMLElement>(
    'input, select, textarea, button:not([data-autofocus="skip"]), [tabindex]:not([tabindex="-1"])',
  );
  target?.focus();
}

/** Trap Tab inside a container (used by the modal). */
export function trapFocus(container: Element, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const focusables = qsa<HTMLElement>(FOCUSABLE, container).filter((el) => el.offsetParent !== null);
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
