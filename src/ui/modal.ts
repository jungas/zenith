/**
 * A single reusable dialog. Uses <dialog> where available with a focus trap and
 * Escape handling, so forms work with a keyboard as well as a thumb.
 */

import { h, mount, focusFirst, trapFocus, type Child } from './dom.ts';
import { icon } from './icons.ts';

export interface ModalOptions {
  title: string;
  body: Child;
  footer?: Child;
  size?: 'sm' | 'md' | 'lg';
  onClose?: () => void;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

let host: HTMLDialogElement | null = null;
let onCloseHook: (() => void) | null = null;

function ensureHost(): HTMLDialogElement {
  if (host) return host;
  const dialog = h<HTMLDialogElement>('dialog.modal', {
    onclick: (event: MouseEvent) => {
      if (event.target === dialog) close();
    },
    oncancel: (event: Event) => {
      event.preventDefault();
      close();
    },
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else {
        trapFocus(dialog, event);
      }
    },
  });
  document.body.appendChild(dialog);
  host = dialog;
  return dialog;
}

export function openModal({ title, body, footer, size = 'md', onClose }: ModalOptions): HTMLDialogElement {
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

export function close(): void {
  if (!host) return;
  if (typeof host.close === 'function' && host.open) host.close();
  else host.removeAttribute('open');
  const hook = onCloseHook;
  onCloseHook = null;
  hook?.();
}

export const closeModal = close;

/** Confirmation dialog. Resolves true when confirmed. */
export function confirmDialog({
  title, message, confirmLabel = 'Confirm', danger = false,
}: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
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
