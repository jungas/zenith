/** Shared building blocks used across views. */

import { h, type Child } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { sparkline } from './charts.ts';
import { formatMoney, formatMoneyCompact } from '../core/money.ts';
import type { Cents, MoneyOptions } from '../core/model.ts';

export type Tone = 'neutral' | 'accent' | 'good' | 'warning' | 'serious' | 'critical';

export interface StatTileOptions {
  label: string;
  value: string;
  /** Signed change vs the previous period; `deltaLabel` carries the formatting. */
  delta?: Cents | null;
  deltaLabel?: string | null;
  trend?: number[];
  tone?: Tone;
  hint?: string | undefined;
  /** False when a rise is bad, e.g. spending. */
  upIsGood?: boolean;
  href?: string;
}

export interface SelectOption {
  value: string;
  label: string;
  selected?: boolean;
}

export interface SelectGroup {
  group: string;
  options: SelectOption[];
}

export interface FieldOptions {
  hint?: string | undefined;
  id?: string;
  error?: string;
}

export interface SegmentedOption<T> {
  value: T;
  label: string;
}

/**
 * Stat tile: label · value · optional delta · optional 12-point trend.
 * The value uses proportional figures (tabular-nums is reserved for columns).
 */
export function statTile({
  label, value, delta, deltaLabel, trend, tone = 'neutral', hint, upIsGood = true, href,
}: StatTileOptions): HTMLElement {
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

  const inner: Child[] = [
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

function deltaDirection(delta: number, upIsGood: boolean): string {
  if (delta === 0) return 'is-flat';
  const good = delta > 0 ? upIsGood : !upIsGood;
  return good ? 'is-good' : 'is-bad';
}

/** Status chip — always an icon plus a word, never colour alone. */
export function statusPill(
  status: Tone,
  label: string,
  { size = 'md' }: { size?: 'sm' | 'md' } = {},
): HTMLElement {
  const icons: Record<Tone, IconName> = {
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
export function moneyText(
  cents: Cents,
  opts: {
    money?: MoneyOptions; signed?: boolean; zeroDash?: boolean;
    compact?: boolean; className?: string;
  } = {},
): HTMLElement {
  const { money = {}, signed = false, zeroDash = false, compact = false, className = '' } = opts;
  if (zeroDash && !cents) return h('span', { class: `money is-zero ${className}`.trim(), text: '—' });
  const text = compact ? formatMoneyCompact(cents, money) : formatMoney(cents, { ...money, signed });
  const sign = cents > 0 ? 'is-positive' : cents < 0 ? 'is-negative' : 'is-zero';
  return h('span', { class: `money ${sign} ${className}`.trim(), text });
}

export function sectionHeader(
  title: string,
  { subtitle, actions }: { subtitle?: string; actions?: Child } = {},
): HTMLElement {
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

export function emptyState({
  title, message, action, iconName = 'wallet',
}: { title: string; message: string; action?: Child; iconName?: IconName }): HTMLElement {
  return h(
    'div.empty-state',
    null,
    h('div.empty-icon', null, icon(iconName, { size: 26 })),
    h('h3.empty-title', { text: title }),
    h('p.empty-message', { text: message }),
    action ?? null,
  );
}

export function card(
  children: Child,
  { className = '', as = 'section' }: { className?: string; as?: string } = {},
): HTMLElement {
  return h(as, { class: `card ${className}`.trim() }, children);
}

/** Labelled form field. `control` is any input node. */
export function field(label: string, control: HTMLElement, { hint, id, error }: FieldOptions = {}): HTMLElement {
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

export function input(props: Record<string, unknown> = {}): HTMLInputElement {
  return h<HTMLInputElement>('input.input', { type: 'text', ...props });
}

export function moneyInput(props: Record<string, unknown> = {}): HTMLInputElement {
  return h<HTMLInputElement>('input.input.input-money', {
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    placeholder: '0.00',
    ...props,
  });
}

export function select(
  options: Array<SelectOption | SelectGroup>,
  props: Record<string, unknown> = {},
): HTMLSelectElement {
  return h<HTMLSelectElement>(
    'select.input',
    props,
    options.map((option) =>
      'group' in option
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

export function segmented<T extends string | number>(
  options: Array<SegmentedOption<T>>,
  { name, value, onChange }: { name: string; value: T; onChange: (value: T) => void },
): HTMLElement {
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

export function button(
  label: string,
  {
    onClick, variant = '', iconName, type = 'button', ...rest
  }: {
    onClick?: () => void; variant?: string; iconName?: IconName;
    type?: string; [key: string]: unknown;
  } = {},
): HTMLElement {
  return h(
    'button',
    { type, class: `btn ${variant}`.trim(), onclick: onClick, ...rest },
    iconName ? icon(iconName, { size: 16 }) : null,
    h('span', { text: label }),
  );
}
