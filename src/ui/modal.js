/**
 * A single reusable dialog. Uses <dialog> where available with a focus trap and
 * Escape handling, so forms work with a keyboard as well as a thumb.
 */

import { h, mount, focusFirst, trapFocus } from './dom.js';
import { icon } from './icons.js';

let host = null;
let onCloseHook = null;

function ensureHost() {
  if (host) return host;
  host = h('dialog.modal', {
    onclick: (event) => {
      if (event.target === host) close();
    },
    oncancel: (event) => {
      event.preventDefault();
      close();
    },
    onkeydown: (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else {
        trapFocus(host, event);
      }
    },
  });
  document.body.appendChild(host);
  return host;
}

/**
 * @param {{title: string, body: Node|Node[], footer?: Node|Node[], size?: 'sm'|'md'|'lg', onClose?: Function}} opts
 */
export function openModal({ title, body, footer, size = 'md', onClose }) {
  const node = ensureHost();
  node.className = `modal modal-${size}`;
  onCloseHook = onClose ?? null;

  mount(
    node,
    h(
      'div.modal-panel',
      { role: 'document' },
      h(
        'header.modal-head',
        null,
        h('h2.modal-title', { text: title }),
        h(
          'button.icon-btn',
          { type: 'button', 'aria-label': 'Close', onclick: close, 'data-autofocus': 'skip' },
          icon('close', { size: 18 }),
        ),
      ),
      h('div.modal-body', null, body),
      footer ? h('footer.modal-foot', null, footer) : null,
    ),
  );

  if (typeof node.showModal === 'function') {
    if (!node.open) node.showModal();
  } else {
    node.setAttribute('open', '');
  }
  focusFirst(node.querySelector('.modal-body'));
  return node;
}

export function close() {
  if (!host) return;
  if (typeof host.close === 'function' && host.open) host.close();
  else host.removeAttribute('open');
  const hook = onCloseHook;
  onCloseHook = null;
  hook?.();
}

export const closeModal = close;

/** Confirmation dialog. Resolves true when confirmed. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openModal({
      title,
      size: 'sm',
      body: h('p.modal-text', { text: message }),
      footer: [
        h('button.btn', {
          type: 'button',
          text: 'Cancel',
          onclick: () => {
            finish(false);
            close();
          },
        }),
        h('button', {
          type: 'button',
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          text: confirmLabel,
          onclick: () => {
            finish(true);
            close();
          },
        }),
      ],
      onClose: () => finish(false),
    });
  });
}
