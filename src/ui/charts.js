/**
 * Hand-rolled SVG charts. No chart library — these are a few hundred lines of
 * geometry, which keeps the app dependency-free and installable offline.
 *
 * The specs are fixed, not per-chart taste:
 *   · bars cap at 24px thick, with a 4px rounded data-end and a square baseline
 *   · a 2px gap in the surface colour separates touching marks
 *   · lines are 2px; markers are ≥8px and carry a 2px surface ring
 *   · gridlines are hairline, solid and recessive; one axis, never two scales
 *   · ≥2 series always gets a legend; direct labels stay selective
 *   · every chart offers a table view, which is also the contrast relief for
 *     the three light-mode series colours that sit below 3:1
 */

import { h, append, mount } from './dom.js';
import { icon } from './icons.js';
import { formatMoneyCompact, formatMoney } from '../core/money.js';

const BAR_MAX = 24;
const GAP = 2;
const RADIUS = 4;

/**
 * Axis scale. The *step* is rounded to a nice number first and the maximum
 * derived from it — picking a nice maximum and dividing gives ticks like
 * "$1.3K", which read as noise.
 *
 * @returns {{max: number, ticks: number[]}}
 */
export function niceScale(value, targetTicks = 5) {
  if (!(value > 0)) return { max: 100, ticks: [0, 25, 50, 75, 100] };
  const rawStep = value / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const candidate = [1, 2, 2.5, 5, 10].find((c) => normalised <= c) ?? 10;
  // Amounts are integer cents, so a fractional step is meaningless — and
  // rounding one for display produces repeated tick labels.
  const step = Math.max(1, Math.round(candidate * magnitude));
  const max = Math.ceil(value / step) * step;
  const ticks = [];
  for (let tick = 0; tick <= max; tick += step) ticks.push(tick);
  return { max, ticks };
}

/** Bar path: rounded at the data end, square where it meets the baseline. */
function barPathHorizontal(x, y, width, height) {
  const r = Math.max(0, Math.min(RADIUS, width, height / 2));
  if (width <= 0.5) return '';
  return `M${x},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height - r} Q${x + width},${y + height} ${x + width - r},${y + height} H${x} Z`;
}

function barPathVertical(x, baseline, width, height) {
  const r = Math.max(0, Math.min(RADIUS, width / 2, height));
  if (height <= 0.5) return '';
  const top = baseline - height;
  return `M${x},${baseline} V${top + r} Q${x},${top} ${x + r},${top} H${x + width - r} Q${x + width},${top} ${x + width},${top + r} V${baseline} Z`;
}

/* ── Shared tooltip ───────────────────────────────────────────────────── */

function withTooltip(figure, svg) {
  const tip = h('div.chart-tip', { role: 'status', 'aria-live': 'polite' });
  figure.appendChild(tip);

  const show = (event, lines) => {
    mount(
      tip,
      ...lines.map((line, index) =>
        index === 0
          ? h('div.chart-tip-title', { text: line })
          : h(
              'div.chart-tip-row',
              null,
              line.color ? h('span.chart-tip-swatch', { style: { background: `var(--${line.color})` } }) : null,
              h('span.chart-tip-label', { text: line.label ?? String(line) }),
              line.value != null ? h('span.chart-tip-value', { text: line.value }) : null,
            ),
      ),
    );
    tip.classList.add('is-visible');
    const bounds = figure.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    tip.style.left = `${Math.max(8, Math.min(bounds.width - tip.offsetWidth - 8, x - tip.offsetWidth / 2))}px`;
    tip.style.top = `${Math.max(4, y - tip.offsetHeight - 14)}px`;
  };
  const hide = () => tip.classList.remove('is-visible');

  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide, true);
  return { show, hide };
}

/* ── Legend & table view ──────────────────────────────────────────────── */

export function legend(items) {
  return h(
    'ul.legend',
    { role: 'list' },
    items.map((item) =>
      h(
        'li.legend-item',
        null,
        h('span.legend-swatch', { style: { background: `var(--${item.color})` } }),
        h('span', { text: item.label }),
      ),
    ),
  );
}

export function tableView(headers, rows, { summary = 'Show data table' } = {}) {
  return h(
    'details.table-view',
    null,
    h('summary', null, icon('ledger', { size: 15 }), h('span', { text: summary })),
    h(
      'div.table-scroll',
      null,
      h(
        'table.data-table',
        null,
        h('thead', null, h('tr', null, headers.map((head, i) => h('th', { text: head, scope: 'col', class: i ? 'num' : '' })))),
        h(
          'tbody',
          null,
          rows.map((row) =>
            h('tr', null, row.map((cell, i) =>
              i === 0
                ? h('th', { text: String(cell), scope: 'row' })
                : h('td.num', { text: String(cell) }),
            )),
          ),
        ),
      ),
    ),
  );
}

function figureShell(title, subtitle, { className = '' } = {}) {
  return h(
    'figure',
    { class: `chart ${className}`.trim() },
    title
      ? h(
          'figcaption.chart-head',
          null,
          h('h3.chart-title', { text: title }),
          subtitle ? h('p.chart-sub', { text: subtitle }) : null,
        )
      : null,
  );
}

function emptyChart(title, subtitle, message) {
  const figure = figureShell(title, subtitle);
  figure.appendChild(h('p.chart-empty', null, icon('info', { size: 16 }), h('span', { text: message })));
  return figure;
}

/* ── Horizontal category bars ─────────────────────────────────────────── */

/**
 * Magnitude by category, one bar each, coloured by the category's own slot so
 * identity stays consistent across the app. Values are labelled at the tip —
 * that is also the relief for the light-mode contrast warning.
 *
 * @param {{label: string, value: number, color: string}[]} rows
 */
export function categoryBars(rows, { title, subtitle, money = {}, max: forcedMax, emptyMessage = 'No spending recorded yet.' } = {}) {
  const data = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  if (!data.length) return emptyChart(title, subtitle, emptyMessage);

  const figure = figureShell(title, subtitle, { className: 'chart-bars' });
  const rowHeight = 30;
  const labelWidth = 116;
  const valueWidth = 78;
  const width = 640;
  const height = data.length * rowHeight;
  const plotWidth = width - labelWidth - valueWidth;
  const max = forcedMax ?? niceScale(data[0].value).max;

  const svg = h('svg', {
    class: 'chart-svg',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMinYMin meet',
    role: 'img',
    'aria-label': `${title ?? 'Spending'} by category`,
    style: { height: `${height}px`, maxHeight: `${height}px` },
  });

  const { show } = withTooltip(figure, svg);

  data.forEach((row, index) => {
    const barHeight = Math.min(BAR_MAX, rowHeight - GAP * 3);
    const y = index * rowHeight + (rowHeight - barHeight) / 2;
    const barWidth = Math.max(0, (row.value / max) * plotWidth);

    const group = h('g', { class: 'bar-row', tabindex: '0', role: 'listitem' });
    // Track sits behind the bar at one step off the surface — it makes short
    // bars readable without adding ink to the mark itself.
    append(
      group,
      h('rect', {
        x: labelWidth, y, width: plotWidth, height: barHeight, rx: RADIUS,
        class: 'bar-track',
      }),
      h('path', { d: barPathHorizontal(labelWidth, y, barWidth, barHeight), fill: `var(--${row.color})` }),
      h('text', {
        x: labelWidth - 10, y: y + barHeight / 2, class: 'axis-label', 'text-anchor': 'end',
        'dominant-baseline': 'central', text: row.label,
      }),
      h('text', {
        x: width - valueWidth + 10, y: y + barHeight / 2, class: 'value-label',
        'dominant-baseline': 'central', text: formatMoney(row.value, { ...money, cents: false }),
      }),
    );

    const tip = (event) =>
      show(event, [row.label, { label: 'Spent', value: formatMoney(row.value, money), color: row.color }]);
    group.addEventListener('pointerenter', tip);
    group.addEventListener('pointermove', tip);
    group.addEventListener('focus', (event) => {
      const box = event.target.getBoundingClientRect();
      tip({ clientX: box.left + box.width / 2, clientY: box.top + box.height });
    });
    svg.appendChild(group);
  });

  figure.appendChild(h('div.chart-body', null, svg));
  figure.appendChild(
    tableView(
      ['Category', 'Spent'],
      data.map((row) => [row.label, formatMoney(row.value, money)]),
      { summary: 'Show spending as a table' },
    ),
  );
  return figure;
}

/* ── Grouped columns over time ────────────────────────────────────────── */

/**
 * Two measures per period, side by side on **one** scale (both are money).
 * @param {{label: string, values: number[]}[]} periods
 * @param {{label: string, color: string}[]} series
 */
export function groupedColumns(periods, series, { title, subtitle, money = {} } = {}) {
  const hasData = periods.some((p) => p.values.some((v) => v > 0));
  if (!hasData) return emptyChart(title, subtitle, 'Not enough history yet — add a few transactions.');

  const figure = figureShell(title, subtitle, { className: 'chart-columns' });
  const width = 640;
  const height = 240;
  const pad = { top: 12, right: 8, bottom: 30, left: 52 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const baseline = pad.top + plotHeight;
  const { max, ticks } = niceScale(Math.max(...periods.flatMap((p) => p.values)));
  const bandWidth = plotWidth / periods.length;
  const barWidth = Math.min(BAR_MAX, (bandWidth - GAP * 4) / series.length);

  const svg = h('svg', {
    class: 'chart-svg',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': `${title ?? 'Monthly totals'}: ${series.map((s) => s.label).join(' and ')} by month`,
  });
  const { show } = withTooltip(figure, svg);

  for (const tick of ticks) {
    const y = baseline - (tick / max) * plotHeight;
    append(
      svg,
      h('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: tick === 0 ? 'axis-line' : 'grid-line' }),
      h('text', {
        x: pad.left - 10, y, class: 'axis-label', 'text-anchor': 'end', 'dominant-baseline': 'central',
        text: formatMoneyCompact(tick, money),
      }),
    );
  }

  periods.forEach((period, index) => {
    const bandStart = pad.left + index * bandWidth;
    const groupWidth = barWidth * series.length + GAP * (series.length - 1);
    const start = bandStart + (bandWidth - groupWidth) / 2;

    const group = h('g', { class: 'column-group', tabindex: '0' });
    series.forEach((serie, sIndex) => {
      const value = period.values[sIndex] || 0;
      const barHeight = (value / max) * plotHeight;
      const x = start + sIndex * (barWidth + GAP);
      group.appendChild(
        h('path', { d: barPathVertical(x, baseline, barWidth, barHeight), fill: `var(--${serie.color})` }),
      );
    });
    // Hit target spans the whole band, not just the marks.
    group.appendChild(
      h('rect', { x: bandStart, y: pad.top, width: bandWidth, height: plotHeight, class: 'hit-area' }),
    );
    svg.appendChild(group);
    svg.appendChild(
      h('text', {
        x: bandStart + bandWidth / 2, y: baseline + 18, class: 'axis-label', 'text-anchor': 'middle',
        text: period.label,
      }),
    );

    const tip = (event) =>
      show(event, [
        period.fullLabel ?? period.label,
        ...series.map((serie, sIndex) => ({
          label: serie.label,
          value: formatMoney(period.values[sIndex] || 0, money),
          color: serie.color,
        })),
      ]);
    group.addEventListener('pointerenter', tip);
    group.addEventListener('pointermove', tip);
    group.addEventListener('focus', (event) => {
      const box = event.target.getBoundingClientRect();
      tip({ clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 });
    });
  });

  figure.appendChild(h('div.chart-body', null, svg));
  figure.appendChild(legend(series));
  figure.appendChild(
    tableView(
      ['Month', ...series.map((s) => s.label)],
      periods.map((p) => [p.fullLabel ?? p.label, ...p.values.map((v) => formatMoney(v, money))]),
      { summary: 'Show monthly totals as a table' },
    ),
  );
  return figure;
}

/* ── Line chart ───────────────────────────────────────────────────────── */

/**
 * One series over time — no legend needed, the title says what is plotted.
 * @param {{label: string, value: number}[]} points
 */
export function lineChart(points, { title, subtitle, money = {}, color = 'series-1', valueLabel = 'Balance' } = {}) {
  if (points.length < 2) return emptyChart(title, subtitle, 'Not enough data to plot a trend.');

  const figure = figureShell(title, subtitle, { className: 'chart-line' });
  const width = 640;
  const height = 220;
  const pad = { top: 14, right: 20, bottom: 28, left: 56 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const baseline = pad.top + plotHeight;
  const { max, ticks } = niceScale(Math.max(...points.map((p) => p.value)));
  const stepX = plotWidth / (points.length - 1);
  const px = (i) => pad.left + i * stepX;
  const py = (value) => baseline - (value / max) * plotHeight;

  const svg = h('svg', {
    class: 'chart-svg',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': `${title ?? valueLabel} over time`,
  });
  const { show } = withTooltip(figure, svg);

  for (const tick of ticks) {
    const y = py(tick);
    append(
      svg,
      h('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: tick === 0 ? 'axis-line' : 'grid-line' }),
      h('text', {
        x: pad.left - 10, y, class: 'axis-label', 'text-anchor': 'end', 'dominant-baseline': 'central',
        text: formatMoneyCompact(tick, money),
      }),
    );
  }

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${px(i)},${py(p.value)}`).join(' ');
  const area = `${line} L${px(points.length - 1)},${baseline} L${px(0)},${baseline} Z`;
  append(
    svg,
    h('path', { d: area, fill: `var(--${color})`, 'fill-opacity': '0.1' }),
    h('path', {
      d: line, fill: 'none', stroke: `var(--${color})`, 'stroke-width': '2',
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }),
  );

  // Label the endpoint only — a number on every point goes unread.
  const lastIndex = points.length - 1;
  append(
    svg,
    h('circle', {
      cx: px(lastIndex), cy: py(points[lastIndex].value), r: 5,
      fill: `var(--${color})`, stroke: 'var(--surface-1)', 'stroke-width': '2',
    }),
  );

  const crosshair = h('line', { class: 'crosshair', y1: pad.top, y2: baseline, x1: 0, x2: 0, opacity: '0' });
  svg.appendChild(crosshair);

  const xTickEvery = Math.ceil(points.length / 6);
  points.forEach((point, index) => {
    if (index % xTickEvery !== 0 && index !== lastIndex) return;
    svg.appendChild(
      h('text', {
        x: px(index), y: baseline + 18, class: 'axis-label', 'text-anchor': 'middle', text: point.label,
      }),
    );
  });

  svg.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const xInViewBox = ((event.clientX - box.left) / box.width) * width;
    const index = Math.max(0, Math.min(lastIndex, Math.round((xInViewBox - pad.left) / stepX)));
    const point = points[index];
    crosshair.setAttribute('x1', px(index));
    crosshair.setAttribute('x2', px(index));
    crosshair.setAttribute('opacity', '1');
    show(event, [point.fullLabel ?? point.label, { label: valueLabel, value: formatMoney(point.value, money), color }]);
  });
  svg.addEventListener('pointerleave', () => crosshair.setAttribute('opacity', '0'));

  figure.appendChild(h('div.chart-body', null, svg));
  figure.appendChild(
    tableView(
      ['Period', valueLabel],
      points.map((p) => [p.fullLabel ?? p.label, formatMoney(p.value, money)]),
      { summary: 'Show projection as a table' },
    ),
  );
  return figure;
}

/* ── Meters & sparklines ──────────────────────────────────────────────── */

/**
 * A meter's fill carries severity; the track is a lighter step of the same
 * ramp so the state reads across the whole bar.
 * @param {{ratio: number, status?: string, label?: string, caption?: string}} opts
 */
export function meter({ ratio, status = 'accent', label, caption, ariaLabel }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const over = ratio > 1;
  return h(
    'div',
    { class: `meter meter-${status}${over ? ' is-over' : ''}` },
    label || caption
      ? h(
          'div.meter-head',
          null,
          label ? h('span.meter-label', { text: label }) : null,
          caption ? h('span.meter-caption', { text: caption }) : null,
        )
      : null,
    h(
      'div.meter-track',
      {
        role: 'meter',
        'aria-valuenow': Math.round(clamped * 100),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-label': ariaLabel ?? label ?? 'progress',
      },
      h('div.meter-fill', { style: { width: `${clamped * 100}%` } }),
    ),
  );
}

/** 12-point sparkline for stat tiles; the last point carries the accent. */
export function sparkline(values, { color = 'series-1', width = 96, height = 28 } = {}) {
  const points = values.filter((v) => Number.isFinite(v));
  if (points.length < 2) return h('span.spark-empty');
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const path = points
    .map((value, i) => `${i ? 'L' : 'M'}${i * stepX},${height - ((value - min) / span) * height}`)
    .join(' ');
  const lastX = (points.length - 1) * stepX;
  const lastY = height - ((points[points.length - 1] - min) / span) * height;
  return h(
    'svg',
    {
      class: 'sparkline', viewBox: `0 0 ${width} ${height}`, width, height,
      'aria-hidden': 'true', preserveAspectRatio: 'none',
    },
    h('path', {
      d: path, fill: 'none', stroke: 'var(--spark-line)', 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke',
    }),
    h('circle', { cx: lastX, cy: lastY, r: 2.5, fill: `var(--${color})` }),
  );
}
