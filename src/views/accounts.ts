/** Accounts — balances, net worth, and where cash sits. */

import { h, append } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { statTile, sectionHeader, emptyState, moneyText } from '../ui/components.ts';
import { openAccountForm, openTransactionForm } from '../ui/forms.ts';
import { formatMoney } from '../core/money.ts';
import { accountBalances, cashOnHand, netWorth, totalDebt } from '../core/budget.ts';
import { ACCOUNT_TYPES, isCredit } from '../core/model.ts';
import { getState, moneyOpts } from '../store.ts';
import { navigate } from '../router.ts';
import type { Account, AccountType, Cents } from '../core/model.ts';
import { isWallet } from '../core/model.ts';

export function accountsView(): HTMLElement {
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

  const byType = new Map<AccountType, Account[]>();
  for (const account of state.accounts) {
    const bucket = byType.get(account.type);
    if (bucket) bucket.push(account);
    else byType.set(account.type, [account]);
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
              accounts.reduce((total: Cents, a) => total + (balances.get(a.id) ?? 0), 0),
              { ...money, cents: false },
            ),
          }),
        ),
        h(
          'ul.account-list',
          { role: 'list' },
          accounts.map((account) => {
            const balance = balances.get(account.id) ?? 0;
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
                h(
                  'span.account-icon',
                  null,
                  icon(credit ? 'card' : isWallet(account) ? 'phone' : 'wallet', { size: 17 }),
                ),
                h(
                  'span.account-body',
                  null,
                  h('span.account-name', { text: account.name }),
                  h('span.account-meta', {
                    // Who runs the account leads: it is what you look for when
                    // two cards or two wallets sit side by side. The type is
                    // already the group heading above, so it only fills in when
                    // there is no issuer or provider to name.
                    text: [
                      account.provider || (isCredit(account) ? null : meta.label),
                      isCredit(account)
                        ? `${formatMoney(Math.max(0, account.creditLimit + balance), { ...money, cents: false })} available of ${formatMoney(account.creditLimit, { ...money, cents: false })}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  }),
                ),
                h(
                  'span.account-balance',
                  null,
                  // An amount owed is shown in plain ink: it is neither a gain
                  // nor a loss, and `moneyText` would paint it green for being a
                  // positive number. (Passing 'is-negative' alongside its own
                  // 'is-positive' just left both classes fighting in the cascade.)
                  credit
                    ? h('span.money', { text: formatMoney(-balance, money) })
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
