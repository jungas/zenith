/** Accounts — balances, net worth, and where cash sits. */

import { h, append } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { statTile, sectionHeader, emptyState, moneyText } from '../ui/components.js';
import { openAccountForm, openTransactionForm } from '../ui/forms.js';
import { formatMoney } from '../core/money.js';
import { accountBalances, cashOnHand, netWorth, totalDebt } from '../core/budget.js';
import { ACCOUNT_TYPES, isCredit } from '../core/model.js';
import { getState, moneyOpts } from '../store.js';
import { navigate } from '../router.js';

export function accountsView() {
  const state = getState();
  const money = moneyOpts(state);
  const root = h('div.view.view-accounts');

  if (!state.accounts.length) {
    append(
      root,
      emptyState({
        title: 'No accounts yet',
        message: 'Add the accounts you actually use — chequing, savings, cash and any credit cards.',
        iconName: 'wallet',
        action: h('button.btn.btn-primary', {
          type: 'button', text: 'Add an account', onclick: () => openAccountForm(),
        }),
      }),
    );
    return root;
  }

  const balances = accountBalances(state);

  append(
    root,
    sectionHeader('Accounts', {
      actions: h(
        'button.btn.btn-primary',
        { type: 'button', onclick: () => openAccountForm() },
        icon('plus', { size: 16 }),
        h('span', { text: 'Add account' }),
      ),
    }),
    h(
      'div.tile-grid',
      null,
      statTile({ label: 'Net worth', value: formatMoney(netWorth(state), { ...money, cents: false }) }),
      statTile({ label: 'Cash', value: formatMoney(cashOnHand(state), { ...money, cents: false }) }),
      statTile({
        label: 'Debt',
        value: formatMoney(totalDebt(state), { ...money, cents: false }),
        tone: totalDebt(state) > 0 ? 'warning' : 'good',
        href: '#/cards',
      }),
    ),
  );

  const byType = new Map();
  for (const account of state.accounts) {
    if (!byType.has(account.type)) byType.set(account.type, []);
    byType.get(account.type).push(account);
  }

  for (const [type, accounts] of byType) {
    const meta = ACCOUNT_TYPES[type] ?? { label: type };
    append(
      root,
      h(
        'section.block',
        null,
        h(
          'div.account-group-head',
          null,
          h('h3.account-group-title', { text: meta.label }),
          h('span.account-group-total', {
            text: formatMoney(
              accounts.reduce((total, a) => total + (balances.get(a.id) || 0), 0),
              { ...money, cents: false },
            ),
          }),
        ),
        h(
          'ul.account-list',
          { role: 'list' },
          accounts.map((account) => {
            const balance = balances.get(account.id) || 0;
            const credit = isCredit(account);
            return h(
              'li.account-row',
              null,
              h(
                'button.account-main',
                {
                  type: 'button',
                  onclick: () =>
                    credit ? navigate(`#/cards/${account.id}`) : navigate(`#/transactions?account=${account.id}`),
                },
                h('span.account-icon', null, icon(credit ? 'card' : 'wallet', { size: 17 })),
                h(
                  'span.account-body',
                  null,
                  h('span.account-name', { text: account.name }),
                  h('span.account-meta', {
                    text: credit
                      ? `${formatMoney(Math.max(0, (account.creditLimit || 0) + balance), { ...money, cents: false })} available of ${formatMoney(account.creditLimit || 0, { ...money, cents: false })}`
                      : meta.label,
                  }),
                ),
                h(
                  'span.account-balance',
                  null,
                  credit
                    ? moneyText(-balance, { money, className: balance < 0 ? 'is-negative' : '' })
                    : moneyText(balance, { money }),
                  credit && balance < 0 ? h('span.account-owed', { text: 'owed' }) : null,
                ),
              ),
              h(
                'span.account-actions',
                null,
                h('button.icon-btn', {
                  type: 'button',
                  'aria-label': `Edit ${account.name}`,
                  onclick: () => openAccountForm({ account }),
                }, icon('edit', { size: 16 })),
              ),
            );
          }),
        ),
      ),
    );
  }

  append(
    root,
    h(
      'div.budget-foot',
      null,
      h(
        'button.btn',
        { type: 'button', onclick: () => openTransactionForm({ defaults: { kind: 'transfer' } }) },
        icon('transfer', { size: 16 }),
        h('span', { text: 'Move money between accounts' }),
      ),
      state.accounts.some((a) => isCredit(a))
        ? null
        : h(
            'p.muted-note',
            null,
            icon('info', { size: 15 }),
            h('span', { text: 'Add a credit card to connect card spending to your budget.' }),
          ),
    ),
  );

  return root;
}
