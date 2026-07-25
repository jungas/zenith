/** Shared building blocks used across views. */

import { h } from './dom.js';
import { icon } from './icons.js';
import { sparkline } from './charts.js';
import { formatMoney, formatMoneyCompact, formatPercent } from '../core/money.js';

/**
 * Stat tile: label · value · optional delta · optional 12-point trend.
 * The value uses proportional figures (tabular-nums is reserved for columns).
 */
export function statTile({
  label, value, delta, deltaLabel, trend, tone = 'neutral', hint, upIsGood = true, href,
}) {
  const deltaNode =
    delta == null
      ? null
      : h(
          'div',
          { class: `stat-delta ${deltaDirection(delta, upIsGood)}` },
          icon(delta >= 0 ? 'arrowUp' : 'arrowDown', { size: 14 }),
          h('span', { text: `${delta >= 0 ? '+' : '−'}${deltaLabel ?? Math.abs(delta)}` }),
          deltaLabel && hint ? null : null,
        );

  const inner = [
    h('div.stat-label', { text: label }),
    h('div.stat-value', { text: value }),
    deltaNode,
    hint ? h('div.stat-hint', { text: hint }) : null,
    trend?.length ? h('div.stat-trend', null, sparkline(trend)) : null,
  ];

  return href
    ? h('a', { class: `stat-tile tone-${tone} is-link`, href }, ...inner, icon('arrowRight', { size: 15, class: 'stat-chevron' }))
    : h('div', { class: `stat-tile tone-${tone}` }, ...inner);
}

function deltaDirection(delta, upIsGood) {
  if (delta === 0) return 'is-flat';
  const good = delta > 0 ? upIsGood : !upIsGood;
  return good ? 'is-good' : 'is-bad';
}

/** Status chip — always an icon plus a word, never colour alone. */
export function statusPill(status, label, { size = 'md' } = {}) {
  const icons = {
    good: 'check', warning: 'warn', serious: 'warn', critical: 'alert', neutral: 'info', accent: 'info',
  };
  return h(
    'span',
    { class: `pill pill-${status} pill-${size}` },
    icon(icons[status] ?? 'info', { size: size === 'sm' ? 13 : 14 }),
    h('span', { text: label }),
  );
}

/** Money in ink, with a sign class so gains and losses differ by more than hue. */
export function moneyText(cents, opts = {}) {
  const { money = {}, signed = false, zeroDash = false, compact = false, className = '' } = opts;
  if (zeroDash && !cents) return h('span', { class: `money is-zero ${className}`.trim(), text: '—' });
  const text = compact ? formatMoneyCompact(cents, money) : formatMoney(cents, { ...money, signed });
  const sign = cents > 0 ? 'is-positive' : cents < 0 ? 'is-negative' : 'is-zero';
  return h('span', { class: `money ${sign} ${className}`.trim(), text });
}

export function sectionHeader(title, { subtitle, actions } = {}) {
  return h(
    'div.section-head',
    null,
    h(
      'div',
      null,
      h('h2.section-title', { text: title }),
      subtitle ? h('p.section-sub', { text: subtitle }) : null,
    ),
    actions ? h('div.section-actions', null, actions) : null,
  );
}

export function emptyState({ title, message, action, iconName = 'wallet' }) {
  return h(
    'div.empty-state',
    null,
    h('div.empty-icon', null, icon(iconName, { size: 26 })),
    h('h3.empty-title', { text: title }),
    h('p.empty-message', { text: message }),
    action ?? null,
  );
}

export function card(children, { className = '', as = 'section' } = {}) {
  return h(as, { class: `card ${className}`.trim() }, children);
}

/** Labelled form field. `control` is any input node. */
export function field(label, control, { hint, id, error } = {}) {
  if (id) control.id = id;
  return h(
    'label.field',
    { for: id },
    h('span.field-label', { text: label }),
    control,
    hint ? h('span.field-hint', { text: hint }) : null,
    error ? h('span.field-error', null, icon('alert', { size: 13 }), h('span', { text: error })) : null,
  );
}

export function input(props = {}) {
  return h('input.input', { type: 'text', ...props });
}

export function moneyInput(props = {}) {
  return h('input.input.input-money', {
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    placeholder: '0.00',
    ...props,
  });
}

export function select(options, props = {}) {
  return h(
    'select.input',
    props,
    options.map((option) =>
      option.group
        ? h(
            'optgroup',
            { label: option.group },
            option.options.map((child) =>
              h('option', { value: child.value, text: child.label, selected: child.selected || null }),
            ),
          )
        : h('option', { value: option.value, text: option.label, selected: option.selected || null }),
    ),
  );
}

export function segmented(options, { name, value, onChange }) {
  const group = h('div.segmented', { role: 'radiogroup', 'aria-label': name });
  for (const option of options) {
    const active = option.value === value;
    group.appendChild(
      h('button', {
        type: 'button',
        class: `segment${active ? ' is-active' : ''}`,
        role: 'radio',
        'aria-checked': String(active),
        text: option.label,
        onclick: () => onChange(option.value),
      }),
    );
  }
  return group;
}

export function button(label, { onClick, variant = '', iconName, type = 'button', ...rest } = {}) {
  return h(
    'button',
    { type, class: `btn ${variant}`.trim(), onclick: onClick, ...rest },
    iconName ? icon(iconName, { size: 16 }) : null,
    h('span', { text: label }),
  );
}

/** Utilisation / coverage readout used on card tiles. */
export function ratioCaption(ratio) {
  return ratio == null ? 'No limit set' : formatPercent(ratio, ratio < 0.1 ? 1 : 0);
}
