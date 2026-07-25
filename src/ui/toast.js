/** Transient status messages, announced to assistive tech. */

import { h, append } from './dom.js';
import { icon } from './icons.js';

let region = null;

function ensureRegion() {
  if (region) return region;
  region = h('div.toast-region', { role: 'status', 'aria-live': 'polite' });
  document.body.appendChild(region);
  return region;
}

const ICONS = { info: 'info', success: 'check', warning: 'warn', error: 'alert' };

/**
 * @param {string} message
 * @param {{tone?: 'info'|'success'|'warning'|'error', action?: {label: string, onClick: Function}, duration?: number}} [opts]
 */
export function toast(message, opts = {}) {
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
