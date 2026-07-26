/** Transient status messages, announced to assistive tech. */

import { h, append } from './dom.ts';
import { icon, type IconName } from './icons.ts';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
  duration?: number;
}

let region: HTMLElement | null = null;

function ensureRegion(): HTMLElement {
  if (region) return region;
  region = h('div.toast-region', { role: 'status', 'aria-live': 'polite' });
  document.body.appendChild(region);
  return region;
}

const ICONS: Record<ToastTone, IconName> = {
  info: 'info', success: 'check', warning: 'warn', error: 'alert',
};

/** Show a transient message. Returns a function that dismisses it early. */
export function toast(message: string, opts: ToastOptions = {}): () => void {
  const { tone = 'info', action, duration = action ? 7000 : 3800 } = opts;
  const node = h(
    'div',
    { class: `toast toast-${tone}` },
    icon(ICONS[tone] ?? 'info', { size: 17 }),
    h('span.toast-text', { text: message }),
    action
      ? h('button.toast-action', {
          type: 'button',
          text: action.label,
          onclick: () => {
            action.onClick();
            dismiss();
          },
        })
      : null,
  );

  const dismiss = () => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 200);
  };

  append(ensureRegion(), node);
  requestAnimationFrame(() => node.classList.add('is-visible'));
  setTimeout(dismiss, duration);
  return dismiss;
}
