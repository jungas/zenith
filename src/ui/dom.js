/**
 * A ~80-line hyperscript layer. No framework, no build step: views are plain
 * functions that return DOM nodes.
 *
 * Text always goes through `textContent`, so user-entered payee names and memos
 * can never be interpreted as markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'text',
  'tspan', 'defs', 'linearGradient', 'stop', 'clipPath', 'title', 'pattern',
]);

/**
 * @param {string} tag  'div', 'button.primary', 'span#total.muted'
 * @param {object|null} [props]
 * @param {...any} children
 */
export function h(tag, props, ...children) {
  const { name, id, classes } = parseTag(tag);
  const element = SVG_TAGS.has(name)
    ? document.createElementNS(SVG_NS, name)
    : document.createElement(name);
  if (id) element.id = id;
  if (classes.length) element.classList.add(...classes);

  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') {
      for (const cls of String(value).split(/\s+/).filter(Boolean)) element.classList.add(cls);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(element.style, value);
    } else if (key === 'dataset') {
      Object.assign(element.dataset, value);
    } else if (key === 'text') {
      element.textContent = String(value);
    } else if (key === 'html') {
      // Only ever called with literals from this codebase (icon paths).
      element.innerHTML = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in element && !SVG_TAGS.has(name) && typeof value !== 'object') {
      try { element[key] = value; } catch { element.setAttribute(key, String(value)); }
    } else {
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(element, children);
  return element;
}

function parseTag(tag) {
  const [head, ...classes] = String(tag).split('.');
  const [name, id] = head.split('#');
  // Split on whitespace too — classList.add() rejects tokens containing spaces.
  return {
    name: name || 'div',
    id,
    classes: classes.flatMap((cls) => cls.split(/\s+/)).filter(Boolean),
  };
}

/** Accepts children as an array or as varargs; nested arrays are flattened. */
export function append(parent, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

export const frag = (...children) => append(document.createDocumentFragment(), children);

/** `qs('.foo')` scoped to document or a root. */
export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Debounce for input handlers. */
export function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Focus the first focusable element inside a container. */
export function focusFirst(container) {
  const target = container.querySelector(
    'input, select, textarea, button:not([data-autofocus="skip"]), [tabindex]:not([tabindex="-1"])',
  );
  target?.focus();
}

/** Trap Tab inside a container (used by the modal). */
export function trapFocus(container, event) {
  if (event.key !== 'Tab') return;
  const focusables = qsa(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    container,
  ).filter((el) => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
