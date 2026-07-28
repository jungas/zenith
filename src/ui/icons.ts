/**
 * Inline 24×24 stroke icons. Status is never carried by colour alone, so every
 * status cue in the app ships one of these beside its label.
 */

import { h } from './dom.ts';

const PATHS = {
  dashboard: 'M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z',
  budget: 'M4 6h16M4 12h16M4 18h10',
  card: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 3h18M7 15h4',
  ledger: 'M5 4h11l4 4v12H5V4Zm3 6h8M8 14h8M8 18h5',
  reports: 'M4 20V10m5 10V4m5 16v-7m5 7V7',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2-1.2L15 3H9l-.5 2.6a8 8 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a8 8 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2 1.2L9 21h6l.5-2.6a8 8 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2Z',
  plus: 'M12 5v14M5 12h14',
  check: 'M4 12.5 9 17.5 20 6.5',
  alert: 'M12 3 2 20h20L12 3Zm0 6v6m0 3h.01',
  warn: 'M12 8v5m0 3h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  info: 'M12 11v6m0-9h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  arrowUp: 'M12 19V5m0 0-6 6m6-6 6 6',
  arrowDown: 'M12 5v14m0 0 6-6m-6 6-6-6',
  arrowRight: 'M5 12h14m0 0-6-6m6 6-6 6',
  arrowLeft: 'M19 12H5m0 0 6 6m-6-6 6-6',
  close: 'M6 6l12 12M18 6 6 18',
  wallet: 'M3 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2m0 0h1v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8m16 0v4h-4a2 2 0 0 1 0-4h4Z',
  calendar: 'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Zm0 4h16M9 3v4m6-4v4',
  transfer: 'M4 8h13m0 0-4-4m4 4-4 4M20 16H7m0 0 4 4m-4-4 4-4',
  edit: 'M4 20h4L20 8l-4-4L4 16v4Z',
  trash: 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13',
  download: 'M12 4v11m0 0 4-4m-4 4-4-4M4 20h16',
  upload: 'M12 20V9m0 0 4 4m-4-4-8 4m8-4 4 4M4 4h16',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5 -2 5 5',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  spark: 'M12 3v4m0 10v4M3 12h4m10 0h4M6 6l3 3m6 6 3 3m0-12-3 3m-6 6-3 3',
  undo: 'M9 10H4V5m0 5 3.5-3.5a8 8 0 1 1-1.2 9.9',
  link: 'M9 15l6-6M8 8H6a4 4 0 0 0 0 8h2m8-8h2a4 4 0 0 1 0 8h-2',
  menu: 'M4 7h16M4 12h16M4 17h16',
  install: 'M12 4v9m0 0 3.5-3.5M12 13 8.5 9.5M5 16v3h14v-3',
  bell: 'M12 3a5 5 0 0 0-5 5v3.6L5 15h14l-2-3.4V8a5 5 0 0 0-5-5Zm-2 15a2 2 0 0 0 4 0',
  // The brand mark: the same rising line as the app icon, minus the end dot,
  // which would go muddy at chrome sizes.
  zenith: 'M4 16.8 9.4 11.4 13.8 14.6 19.8 6.4',
  // A phone with a balance line: a digital wallet, distinct from the physical
  // wallet used for accounts in general.
  phone: 'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm2.5 5h5m-5 3.5h5M11 17.5h2',
};

export type IconName = keyof typeof PATHS;

export interface IconOptions {
  size?: number;
  class?: string;
  label?: string;
}

export function icon(name: IconName, opts: IconOptions = {}): SVGSVGElement {
  const { size = 20, class: className = '', label } = opts;
  return h<SVGSVGElement>(
    'svg',
    {
      class: `icon ${className}`.trim(),
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.75,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': label ? null : 'true',
      role: label ? 'img' : null,
    },
    label ? h('title', { text: label }) : null,
    h('path', { d: PATHS[name] ?? PATHS.info }),
  );
}
