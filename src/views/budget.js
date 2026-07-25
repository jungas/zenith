/**
 * Budget view — assign every dollar a job, month by month.
 *
 * Card payment envelopes appear in their own group at the bottom, with a
 * "Reserved" column that no other group has: money that arrived there because
 * you spent on a card rather than because you assigned it.
 */

import { h, append } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { statusPill, moneyText, emptyState } from '../ui/components.js';
import { openCategoryForm, openMoveMoneyForm } from '../ui/forms.js';
import { formatMoney, parseMoney, centsToInput } from '../core/money.js';
import { addMonths, currentMonth, monthLabel } from '../core/dates.js';
import { categoryRow, monthSummary, suggestBudget } from '../core/budget.js';
import { categoryGroups } from '../core/model.js';
import { commit, getState, moneyOpts } from '../store.js';
import * as actions from '../core/actions.js';
import { navigate } from '../router.js';

export function budgetView({ month = currentMonth() } = {}) {
  const state = getState();
  const money = moneyOpts(state);
  const root = h('div.view.view-budget');

  if (!state.categories.length) {
    append(
      root,
      emptyState({
        title: 'No categories yet',
        message: 'Categories are the envelopes you assign money to. Add a few to get started.',
        iconName: 'budget',
        action: h('button.btn.btn-primary', {
          type: 'button', text: 'Add a category', onclick: () => openCategoryForm(),
        }),
      }),
    );
    return root;
  }

  const summary = monthSummary(state, month);
  const groups = categoryGroups(state);

  /* Month switcher + Ready to assign. */
  const rta = summary.readyToAssign;
  append(
    root,
    h(
      'div.budget-bar',
      null,
      h(
        'div.month-nav',
        null,
        h(
          'button.icon-btn',
          { type: 'button', 'aria-label': 'Previous month', onclick: () => navigate(`#/budget/${addMonths(month, -1)}`) },
          icon('arrowLeft', { size: 18 }),
        ),
        h('span.month-label', { text: monthLabel(month, money.locale) }),
        h(
          'button.icon-btn',
          { type: 'button', 'aria-label': 'Next month', onclick: () => navigate(`#/budget/${addMonths(month, 1)}`) },
          icon('arrowRight', { size: 18 }),
        ),
        month !== currentMonth()
          ? h('button.btn.btn-sm.btn-ghost', {
              type: 'button', text: 'Today', onclick: () => navigate(`#/budget/${currentMonth()}`),
            })
          : null,
      ),
      h(
        'div',
        { class: `rta rta-${rta < 0 ? 'over' : rta === 0 ? 'zero' : 'left'}` },
        h('span.rta-label', { text: 'Ready to assign' }),
        h('span.rta-value', { text: formatMoney(rta, money) }),
        rta < 0
          ? statusPill('critical', 'Over-assigned', { size: 'sm' })
          : rta === 0
            ? statusPill('good', 'Balanced', { size: 'sm' })
            : null,
      ),
    ),
  );

  /* Summary strip. */
  append(
    root,
    h(
      'div.budget-summary',
      null,
      summaryCell('Income', summary.income, money),
      summaryCell('Assigned', summary.budgeted, money),
      summaryCell('Spent', -summary.spending, money),
      summaryCell('Available', totalAvailable(state, summary), money),
    ),
  );

  /* The envelope table. */
  for (const [groupName, categories] of groups) {
    const isCards = groupName === 'Credit card payments';
    const table = h('div', { class: `budget-group${isCards ? ' is-cards' : ''}` });

    append(
      table,
      h(
        'div.budget-group-head',
        null,
        h('h3.budget-group-title', { text: groupName }),
        isCards
          ? h(
              'p.budget-group-note',
              null,
              icon('link', { size: 14 }),
              h('span', { text: 'Funded automatically when you spend on a card' }),
            )
          : null,
        h(
          'span.budget-group-total',
          { text: formatMoney(groupTotal(summary, categories), { ...money, cents: false }) },
        ),
      ),
      h(
        'div.budget-rows',
        { role: 'table', 'aria-label': `${groupName} envelopes` },
        h(
          'div.budget-row.budget-head',
          { role: 'row' },
          h('span.col-name', { role: 'columnheader', text: 'Category' }),
          h('span.col-num.col-assigned', { role: 'columnheader', text: 'Assigned' }),
          isCards ? h('span.col-num.col-reserved', { role: 'columnheader', text: 'Reserved' }) : null,
          h('span.col-num.col-activity', { role: 'columnheader', text: 'Activity' }),
          h('span.col-num.col-available', { role: 'columnheader', text: 'Available' }),
        ),
        categories.map((category) => budgetRow(state, summary, category, month, money, isCards)),
      ),
    );
    append(root, table);
  }

  append(
    root,
    h(
      'div.budget-foot',
      null,
      h(
        'button.btn',
        { type: 'button', onclick: () => openCategoryForm() },
        icon('plus', { size: 16 }),
        h('span', { text: 'New category' }),
      ),
      summary.overspent > 0
        ? h(
            'p.budget-warning',
            null,
            icon('warn', { size: 16 }),
            h('span', {
              text: `${formatMoney(summary.overspent, money)} overspent this month. It will come out of next month's Ready to assign.`,
            }),
          )
        : null,
    ),
  );

  return root;
}

function summaryCell(label, cents, money) {
  return h(
    'div.summary-cell',
    null,
    h('span.summary-label', { text: label }),
    h('span.summary-value', null, moneyText(cents, { money, compact: false })),
  );
}

function groupTotal(summary, categories) {
  return categories.reduce((total, category) => total + categoryRow(summary, category.id).available, 0);
}

function totalAvailable(state, summary) {
  return state.categories.reduce((total, category) => total + categoryRow(summary, category.id).available, 0);
}

function budgetRow(state, summary, category, month, money, isCards) {
  const row = categoryRow(summary, category.id);
  const available = row.available;
  const tone = available < 0 ? 'is-over' : available === 0 ? 'is-zero' : 'is-funded';

  const assignedInput = h('input.cell-input', {
    type: 'text',
    inputmode: 'decimal',
    'aria-label': `Assigned to ${category.name}`,
    value: row.budgeted ? centsToInput(row.budgeted) : '',
    placeholder: '0.00',
    onfocus: (event) => event.target.select(),
    onchange: (event) => {
      const cents = Math.abs(parseMoney(event.target.value));
      commit((s) => actions.setBudget(s, month, category.id, cents), { label: 'assign' });
    },
    onkeydown: (event) => {
      if (event.key === 'Enter') event.target.blur();
    },
  });

  const suggestion = !row.budgeted && !isCards ? suggestBudget(state, category.id, month) : 0;

  return h(
    'div',
    { class: `budget-row ${tone}`, role: 'row' },
    h(
      'span.col-name',
      { role: 'cell' },
      // Swatch and name stay on one line; the rollover caption sits beneath, so
      // a long name never leaves the swatch stranded on its own row.
      h(
        'span.row-title',
        null,
        h('span.row-swatch', { style: { background: `var(--${category.color})` } }),
        h(
          'button.row-name',
          {
            type: 'button',
            onclick: () =>
              isCards
                ? navigate(`#/cards/${category.accountId}`)
                : navigate(`#/transactions?category=${category.id}&month=${month}`),
            title: isCards ? 'Open card' : 'Show transactions',
          },
          h('span', { text: category.name }),
        ),
      ),
      row.rollover
        ? h('span.row-rollover', { text: `${formatMoney(row.rollover, { ...money, cents: false })} rolled over` })
        : null,
      // Narrow screens drop the Reserved column and show it here instead, so
      // the card link stays visible without squeezing the name to three letters.
      isCards
        ? h('span.row-reserved-note', {
            text: `${formatMoney(row.reserved, { ...money, cents: false })} reserved by card spending`,
          })
        : null,
    ),
    h(
      'span.col-num.col-assigned',
      { role: 'cell' },
      assignedInput,
      suggestion
        ? h('button.suggest', {
            type: 'button',
            text: `avg ${formatMoney(suggestion, { ...money, cents: false })}`,
            title: 'Assign your 3-month average',
            onclick: () => commit((s) => actions.setBudget(s, month, category.id, suggestion), { label: 'assign' }),
          })
        : null,
    ),
    isCards
      ? h(
          'span.col-num.col-reserved',
          { role: 'cell', title: 'Set aside automatically by card spending' },
          moneyText(row.reserved, { money, zeroDash: true }),
        )
      : null,
    h(
      'span.col-num.col-activity',
      { role: 'cell' },
      moneyText(row.activity, { money, zeroDash: true }),
    ),
    h(
      'span.col-num.col-available',
      { role: 'cell' },
      h(
        'button.available-chip',
        {
          type: 'button',
          class: `available-chip ${tone}`,
          title: available > 0 ? 'Move this money somewhere else' : 'Available balance',
          disabled: available <= 0 || null,
          onclick: () =>
            available > 0 && openMoveMoneyForm({ month, fromCategoryId: category.id, available }),
        },
        h('span', { text: formatMoney(available, money) }),
      ),
      available < 0
        ? h('span.row-flag', null, icon('alert', { size: 13 }), h('span', { text: 'Overspent' }))
        : null,
    ),
  );
}
