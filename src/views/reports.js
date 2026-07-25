/** Reports — spending trends, category mix, and how card debt is tracking. */

import { h, append, mount } from '../ui/dom.js';
import { statTile, sectionHeader, emptyState, segmented } from '../ui/components.js';
import { categoryBars, groupedColumns, lineChart, tableView } from '../ui/charts.js';
import { formatMoney, formatPercent } from '../core/money.js';
import { addMonths, currentMonth, monthLabel, monthLabelShort, monthRange } from '../core/dates.js';
import { ledgerMonths, monthlyTotals, spendingByCategory, totalDebt } from '../core/budget.js';
import { getState, moneyOpts } from '../store.js';
import { foldToOther, toCategoryRows } from './chart-data.js';

const RANGES = [
  { value: 3, label: '3 months' },
  { value: 6, label: '6 months' },
  { value: 12, label: '12 months' },
];

export function reportsView() {
  const state = getState();
  const money = moneyOpts(state);
  const root = h('div.view.view-reports');

  if (!state.transactions.length) {
    append(
      root,
      emptyState({
        title: 'Nothing to report yet',
        message: 'Once you have a few weeks of transactions, trends and category mix show up here.',
        iconName: 'reports',
      }),
    );
    return root;
  }

  let range = 6;
  const body = h('div.report-body');

  const render = () => {
    const current = getState();
    const thisMonth = currentMonth();
    const available = ledgerMonths(current, thisMonth);
    const from = addMonths(thisMonth, -(range - 1));
    const months = monthRange(
      available[0] > from ? available[0] : from,
      thisMonth,
    );

    const totals = monthlyTotals(current, months);
    const totalIncome = totals.reduce((t, m) => t + m.income, 0);
    const totalSpending = totals.reduce((t, m) => t + m.spending, 0);
    const saved = totalIncome - totalSpending;
    const savingsRate = totalIncome ? saved / totalIncome : 0;

    const spending = spendingByCategory(current, months[0], months[months.length - 1]);
    const byId = new Map(current.categories.map((c) => [c.id, c]));
    const categoryRows = foldToOther(toCategoryRows(spending, byId), 8);

    // Card debt at each month end, so the trend is real history not a guess.
    const debtPoints = months.map((month) => {
      const [y, m] = month.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      return {
        label: monthLabelShort(month, money.locale),
        fullLabel: monthLabel(month, money.locale),
        value: totalDebt(current, `${month}-${String(lastDay).padStart(2, '0')}`),
      };
    });

    mount(
      body,
      h(
        'div.tile-grid',
        null,
        statTile({
          label: 'Income',
          value: formatMoney(totalIncome, { ...money, cents: false }),
          hint: `over ${months.length} month${months.length === 1 ? '' : 's'}`,
          trend: totals.map((t) => t.income),
        }),
        statTile({
          label: 'Spending',
          value: formatMoney(totalSpending, { ...money, cents: false }),
          hint: `${formatMoney(Math.round(totalSpending / months.length), { ...money, cents: false })} a month on average`,
          trend: totals.map((t) => t.spending),
        }),
        statTile({
          label: 'Kept',
          value: formatMoney(saved, { ...money, cents: false }),
          tone: saved >= 0 ? 'good' : 'critical',
          hint: `${formatPercent(savingsRate)} of income`,
        }),
        statTile({
          label: 'Card debt now',
          value: formatMoney(totalDebt(current), { ...money, cents: false }),
          tone: totalDebt(current) > 0 ? 'warning' : 'good',
          trend: debtPoints.map((p) => p.value),
          hint: debtChangeHint(debtPoints, money),
        }),
      ),

      h(
        'section.block',
        null,
        groupedColumns(
          totals.map((entry) => ({
            label: monthLabelShort(entry.month, money.locale),
            fullLabel: monthLabel(entry.month, money.locale),
            values: [entry.income, entry.spending],
          })),
          [
            { label: 'Income', color: 'series-1' },
            { label: 'Spending', color: 'series-2' },
          ],
          { title: 'Income and spending', subtitle: `Last ${months.length} months`, money },
        ),
      ),

      h('section.block', null, categoryBars(categoryRows, {
        title: 'Spending by category',
        subtitle: `${monthLabel(months[0], money.locale)} – ${monthLabel(months[months.length - 1], money.locale)}`,
        money,
      })),

      h(
        'section.block',
        null,
        debtPoints.length > 1
          ? lineChart(debtPoints, {
              title: 'Card debt over time',
              subtitle: 'Balance owed at each month end',
              money,
              color: 'series-8',
              valueLabel: 'Owed',
            })
          : h('p.muted-note', { text: 'Not enough history for a debt trend yet.' }),
      ),

      h(
        'section.block',
        null,
        sectionHeader('Month by month', { subtitle: 'The same figures as a table' }),
        tableView(
          ['Month', 'Income', 'Spending', 'Net'],
          totals.map((entry) => [
            monthLabel(entry.month, money.locale),
            formatMoney(entry.income, money),
            formatMoney(entry.spending, money),
            formatMoney(entry.net, money),
          ]),
          { summary: 'Show monthly figures' },
        ),
      ),
    );
  };

  // Filters sit in one row above the charts; changing one re-renders both the
  // control (so the active segment moves) and the report body.
  const filterRow = h('div.filter-row');
  const renderFilters = () => {
    mount(
      filterRow,
      segmented(RANGES, {
        name: 'Time range',
        value: range,
        onChange: (next) => {
          range = next;
          renderFilters();
          render();
        },
      }),
    );
  };

  append(
    root,
    sectionHeader('Reports', { subtitle: 'Where the money goes, and whether debt is shrinking' }),
    filterRow,
    body,
  );

  renderFilters();
  render();
  return root;
}

function debtChangeHint(points, money) {
  if (points.length < 2) return undefined;
  const change = points[points.length - 1].value - points[0].value;
  if (change === 0) return 'unchanged over the period';
  const direction = change < 0 ? 'down' : 'up';
  return `${direction} ${formatMoney(Math.abs(change), { ...money, cents: false })} over the period`;
}
