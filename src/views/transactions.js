/** Transactions — one searchable ledger across every account. */

import { h, append, mount, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { sectionHeader, emptyState, moneyText, select, input } from '../ui/components.js';
import { openTransactionForm } from '../ui/forms.js';
import { currentMonth, formatDateShort, monthLabel } from '../core/dates.js';
import { ledgerMonths, queryTransactions } from '../core/budget.js';
import { isCredit } from '../core/model.js';
import { getState, moneyOpts } from '../store.js';
import { setQuery } from '../router.js';

export function transactionsView(params = {}) {
  const state = getState();
  const money = moneyOpts(state);
  const root = h('div.view.view-transactions');

  if (!state.transactions.length) {
    append(
      root,
      emptyState({
        title: 'No transactions yet',
        message: 'Record what you spend and earn — the budget and your cards update together.',
        iconName: 'ledger',
        action: h('button.btn.btn-primary', {
          type: 'button',
          text: 'Add a transaction',
          onclick: () => openTransactionForm(),
        }),
      }),
    );
    return root;
  }

  const filters = {
    accountId: params.account || '',
    categoryId: params.category || '',
    month: params.month || '',
    search: params.q || '',
  };

  const listHost = h('div.tx-host');

  const searchInput = input({
    type: 'search',
    placeholder: 'Search payee or memo',
    value: filters.search,
    'aria-label': 'Search transactions',
  });
  searchInput.addEventListener(
    'input',
    debounce((event) => {
      filters.search = event.target.value;
      setQuery({ q: filters.search || null });
      renderList();
    }, 200),
  );

  const months = ledgerMonths(state, currentMonth()).slice().reverse();
  const accountSelect = select(
    [
      { value: '', label: 'All accounts' },
      ...state.accounts.map((a) => ({ value: a.id, label: a.name, selected: a.id === filters.accountId })),
    ],
    {
      'aria-label': 'Filter by account',
      onchange: (event) => {
        filters.accountId = event.target.value;
        setQuery({ account: filters.accountId || null });
        renderList();
      },
    },
  );
  const categorySelect = select(
    [
      { value: '', label: 'All categories' },
      ...state.categories
        .filter((c) => !c.archived)
        .map((c) => ({ value: c.id, label: c.name, selected: c.id === filters.categoryId })),
    ],
    {
      'aria-label': 'Filter by category',
      onchange: (event) => {
        filters.categoryId = event.target.value;
        setQuery({ category: filters.categoryId || null });
        renderList();
      },
    },
  );
  const monthSelect = select(
    [
      { value: '', label: 'All time' },
      ...months.map((m) => ({ value: m, label: monthLabel(m, money.locale), selected: m === filters.month })),
    ],
    {
      'aria-label': 'Filter by month',
      onchange: (event) => {
        filters.month = event.target.value;
        setQuery({ month: filters.month || null });
        renderList();
      },
    },
  );

  append(
    root,
    sectionHeader('Transactions', {
      actions: h(
        'button.btn.btn-primary',
        { type: 'button', onclick: () => openTransactionForm() },
        icon('plus', { size: 16 }),
        h('span', { text: 'Add' }),
      ),
    }),
    // Filters live in one row above the list.
    h(
      'div.filter-row',
      null,
      h('div.search-wrap', null, icon('search', { size: 16 }), searchInput),
      accountSelect,
      categorySelect,
      monthSelect,
    ),
    listHost,
  );

  function renderList() {
    const current = getState();
    const rows = queryTransactions(current, filters);
    const inflow = rows.filter((r) => r.amount > 0).reduce((t, r) => t + r.amount, 0);
    const outflow = rows.filter((r) => r.amount < 0).reduce((t, r) => t + r.amount, 0);

    mount(
      listHost,
      h(
        'div.tx-summary',
        null,
        h('span', { text: `${rows.length} transaction${rows.length === 1 ? '' : 's'}` }),
        h('span.tx-summary-figures', null,
          h('span', null, h('span.muted', { text: 'in ' }), moneyText(inflow, { money, compact: true })),
          h('span', null, h('span.muted', { text: 'out ' }), moneyText(outflow, { money, compact: true })),
          h('span', null, h('span.muted', { text: 'net ' }), moneyText(inflow + outflow, { money, compact: true })),
        ),
      ),
      rows.length
        ? h('ul.tx-list', { role: 'list' }, groupByDate(rows, current, money))
        : h('p.muted-note', { text: 'No transactions match these filters.' }),
    );
  }

  renderList();
  return root;
}

function groupByDate(rows, state, money) {
  const nodes = [];
  let lastDate = null;
  for (const tx of rows) {
    if (tx.date !== lastDate) {
      lastDate = tx.date;
      nodes.push(
        h('li.tx-date-head', { role: 'presentation' }, h('span', { text: formatDateShort(tx.date, money.locale) })),
      );
    }
    nodes.push(transactionRow(tx, state, money));
  }
  return nodes;
}

/** One ledger row. Shared with the dashboard and card detail views. */
export function transactionRow(tx, state, money) {
  const account = state.accounts.find((a) => a.id === tx.accountId);
  const category = state.categories.find((c) => c.id === tx.categoryId);
  const onCard = account && isCredit(account);

  const meta = [account?.name ?? 'Unknown account'];
  if (category) meta.push(category.name);
  else if (tx.kind === 'income') meta.push('Income');
  else if (tx.kind === 'transfer') meta.push('Transfer');
  else if (tx.kind === 'adjustment') meta.push('Starting balance');
  else meta.push('Uncategorised');

  const editable = !tx.system;

  return h(
    'li',
    { class: `tx-row${tx.cleared ? ' is-cleared' : ''}` },
    h(
      'button.tx-main',
      {
        type: 'button',
        disabled: !editable || null,
        onclick: () => editable && openTransactionForm({ transaction: tx }),
        title: editable ? 'Edit transaction' : 'Opening balance — edit the account to change it',
      },
      h(
        'span',
        { class: `tx-icon kind-${tx.kind}` },
        icon(tx.kind === 'transfer' ? 'transfer' : tx.kind === 'income' ? 'arrowDown' : onCard ? 'card' : 'arrowUp', {
          size: 16,
        }),
      ),
      h(
        'span.tx-body',
        null,
        h('span.tx-payee', { text: tx.payee || (tx.kind === 'income' ? 'Income' : 'Transaction') }),
        h(
          'span.tx-meta',
          null,
          h('span', { text: meta.join(' · ') }),
          onCard && tx.kind === 'expense'
            ? h('span.tx-tag', null, icon('link', { size: 11 }), h('span', { text: 'reserved for payment' }))
            : null,
          tx.memo ? h('span.tx-memo', { text: tx.memo }) : null,
        ),
      ),
      h('span.tx-amount', null, moneyText(tx.amount, { money, signed: true })),
    ),
    h('span.tx-date', { text: formatDateShort(tx.date, money.locale) }),
  );
}
