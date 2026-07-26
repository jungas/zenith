/** Dialog forms: transactions, transfers, card payments, accounts, categories. */

import { h, mount, type Child } from './dom.ts';
import { openModal, close as closeModal, confirmDialog } from './modal.ts';
import { toast } from './toast.ts';
import { field, input, moneyInput, select, segmented, statusPill } from './components.ts';
import type { SelectGroup, SelectOption } from './components.ts';
import { icon } from './icons.ts';
import { parseMoney, centsToInput, formatMoney } from '../core/money.ts';
import { todayISO } from '../core/dates.ts';
import {
  ACCOUNT_TYPES, CATEGORY_COLORS, isCredit, isWallet, paymentCategoryFor, WALLET_PROVIDERS,
} from '../core/model.ts';
import type {
  Account, AccountType, Category, Cents, ISODate, MonthKey, SeriesColor, Transaction, TxKind,
} from '../core/model.ts';
import { cardSnapshot, type CardSnapshot } from '../core/cards.ts';
import { commit, getState, moneyOpts, undo } from '../store.ts';
import * as actions from '../core/actions.ts';
import type { AccountDraft, AppState } from '../core/model.ts';

/** Which of the three shapes the transaction dialog is currently showing. */
type TransactionMode = 'expense' | 'income' | 'transfer';

export interface TransactionFormOptions {
  transaction?: Transaction | null;
  defaults?: {
    kind?: TxKind;
    date?: ISODate;
    amount?: Cents;
    accountId?: string;
    fromAccountId?: string;
    toAccountId?: string;
  };
}

export interface AccountFormOptions {
  account?: Account | null;
  presetType?: AccountType;
}

export interface CategoryFormOptions {
  category?: Category | null;
}

const money = () => moneyOpts();

function accountOptions(
  state: AppState,
  {
    selected, filter = () => true,
  }: { selected?: string | undefined; filter?: (account: Account) => boolean } = {},
): SelectOption[] {
  return state.accounts
    .filter((a) => !a.archived && filter(a))
    .map((a) => ({ value: a.id, label: a.name, selected: a.id === selected }));
}

function categoryOptions(
  state: AppState,
  { selected, includePayments = false }: { selected?: string | null; includePayments?: boolean } = {},
): SelectGroup[] {
  const groups = new Map<string, SelectOption[]>();
  for (const category of state.categories) {
    if (category.archived) continue;
    if (!includePayments && category.kind === 'ccPayment') continue;
    const option: SelectOption = {
      value: category.id,
      label: category.name,
      selected: category.id === selected,
    };
    const bucket = groups.get(category.group);
    if (bucket) bucket.push(option);
    else groups.set(category.group, [option]);
  }
  return [...groups.entries()].map(([group, options]) => ({ group, options }));
}

function undoToast(message: string): void {
  toast(message, { tone: 'success', action: { label: 'Undo', onClick: () => undo() } });
}

/* ── Transaction ──────────────────────────────────────────────────────── */

export function openTransactionForm({
  transaction = null, defaults = {},
}: TransactionFormOptions = {}): void {
  const state = getState();
  if (!state.accounts.length) {
    toast('Add an account first.', { tone: 'warning' });
    return openAccountForm();
  }

  const editing = Boolean(transaction);
  let mode: TransactionMode = transaction
    ? transaction.kind === 'transfer' ? 'transfer' : transaction.kind === 'income' ? 'income' : 'expense'
    : (defaults.kind === 'income' || defaults.kind === 'transfer' ? defaults.kind : 'expense');

  const body = h('form.form', { onsubmit: (event: Event) => event.preventDefault() });
  const errorSlot = h('div.form-error-slot');
  const hintSlot = h('div.hint-slot');

  // The controls are built once and re-arranged by `render`, never rebuilt.
  // Rebuilding them would discard whatever the user has already typed the
  // moment they change the account or switch to a transfer.
  const dateInput = h<HTMLInputElement>('input.input', {
    type: 'date',
    value: transaction?.date ?? defaults.date ?? todayISO(),
    required: true,
  });
  const amountInput = moneyInput({
    value: transaction ? centsToInput(transaction.amount) : defaults.amount ? centsToInput(defaults.amount) : '',
    required: true,
  });
  const payeeInput = input({
    value: transaction?.payee ?? '',
    placeholder: 'Where did it go?',
    autocomplete: 'off',
    list: 'payee-suggestions',
  });
  const memoInput = input({ value: transaction?.memo ?? '', placeholder: 'Optional note' });
  const clearedInput = h<HTMLInputElement>('input', {
    type: 'checkbox', class: 'checkbox', checked: transaction?.cleared ?? false,
  });

  const accountSelect = select(
    accountOptions(state, { selected: transaction?.accountId ?? defaults.accountId }),
  );
  const fromSelect = select(
    accountOptions(state, {
      selected: defaults.fromAccountId ?? state.accounts.find((a) => !isCredit(a))?.id,
    }),
  );
  const toSelect = select(
    accountOptions(state, {
      selected: defaults.toAccountId ?? state.accounts.find((a) => isCredit(a))?.id ?? state.accounts[1]?.id,
    }),
  );
  const categorySelect = select(
    [{ value: '', label: 'Uncategorised' }, ...categoryOptions(state, { selected: transaction?.categoryId })],
  );
  const feeInput = moneyInput({ placeholder: '0.00' });
  const feeCategorySelect = select(categoryOptions(state));
  const payeeList = h(
    'datalist#payee-suggestions',
    null,
    [...new Set(state.transactions.map((t) => t.payee).filter(Boolean))]
      .slice(0, 60)
      .map((payee) => h('option', { value: payee })),
  );

  /** Explains the card connection for whichever account is currently picked. */
  const renderHint = (): void => {
    const accountId = mode === 'transfer' ? toSelect.value : accountSelect.value;
    const account = state.accounts.find((a) => a.id === accountId);
    if (isWallet(account)) {
      mount(
        hintSlot,
        h(
          'div.inline-note',
          null,
          icon('phone', { size: 16 }),
          h('p', {
            text:
              mode === 'transfer'
                ? `Topping up ${account.name} moves money between your own accounts, so it is not spending. If the provider charges for it, put that in the fee field — that part is spending.`
                : `${account.name} holds real money, so spending from it draws down the category you pick, exactly like cash.`,
          }),
        ),
      );
      return;
    }
    if (!isCredit(account)) {
      mount(hintSlot);
      return;
    }
    mount(
      hintSlot,
      h(
        'div.inline-note',
        null,
        icon('link', { size: 16 }),
        h('p', {
          text:
            mode === 'transfer'
              ? `Counts as a card payment: this spends the "${account.name}" payment envelope, which your card spending has been filling.`
              : `Spending on ${account.name} draws down the category you pick and sets the same amount aside in its payment envelope, ready for the bill.`,
        }),
      ),
    );
  };

  accountSelect.addEventListener('change', renderHint);
  toSelect.addEventListener('change', renderHint);

  const render = (): void => {
    const isTransfer = mode === 'transfer';
    payeeInput.placeholder = mode === 'income' ? 'Employer, client…' : 'Where did it go?';

    mount(
      body,
      segmented(
        [
          { value: 'expense', label: 'Expense' },
          { value: 'income', label: 'Income' },
          { value: 'transfer', label: 'Transfer' },
        ],
        {
          name: 'Transaction type',
          value: mode,
          onChange: (next) => {
            mode = next;
            render();
          },
        },
      ),
      payeeList,
      h(
        'div.form-grid',
        null,
        field('Date', dateInput, { id: 'tx-date' }),
        field('Amount', amountInput, {
          id: 'tx-amount',
          hint: mode === 'expense' ? 'What you spent' : mode === 'income' ? 'What you received' : 'Amount to move',
        }),
      ),
      isTransfer
        ? h(
            'div.form-grid',
            null,
            field('From', fromSelect, { id: 'tx-from' }),
            field('To', toSelect, { id: 'tx-to' }),
          )
        : h(
            'div.form-grid',
            null,
            field('Account', accountSelect, { id: 'tx-account' }),
            mode === 'expense'
              ? field('Category', categorySelect, { id: 'tx-category' })
              : h('div.field-spacer'),
          ),
      // Cashing out of a wallet or wiring between banks usually costs something.
      // The fee is spending, so it needs a category like any other outflow.
      isTransfer && !editing
        ? h(
            'div.form-grid',
            null,
            field('Fee (optional)', feeInput, {
              id: 'tx-fee',
              hint: 'Charged to the sending account',
            }),
            field('Fee category', feeCategorySelect, { id: 'tx-fee-category' }),
          )
        : null,
      field(isTransfer ? 'Description' : 'Payee', payeeInput, { id: 'tx-payee' }),
      field('Memo', memoInput, { id: 'tx-memo' }),
      h('label.check-row', null, clearedInput, h('span', { text: 'Cleared — this has settled at the bank' })),
      hintSlot,
      errorSlot,
    );

    renderHint();

    submit.onclick = () => {
      const amount = Math.abs(parseMoney(amountInput.value));
      if (!amount) return showError('Enter an amount greater than zero.');
      const date = dateInput.value || todayISO();

      if (isTransfer) {
        if (fromSelect.value === toSelect.value) return showError('Pick two different accounts.');
        commit(
          (s) =>
            actions.addTransfer(s, {
              fromAccountId: fromSelect.value,
              toAccountId: toSelect.value,
              amount,
              date,
              payee: payeeInput.value.trim(),
              memo: memoInput.value.trim(),
              cleared: clearedInput.checked,
              fee: Math.abs(parseMoney(feeInput.value)),
              feeCategoryId: feeCategorySelect.value || null,
            }),
          { label: 'transfer' },
        );
        closeModal();
        undoToast('Transfer recorded.');
        return;
      }

      const signed = mode === 'income' ? amount : -amount;
      const patch: actions.TransactionDraft = {
        date,
        accountId: accountSelect.value,
        categoryId: mode === 'expense' ? categorySelect.value || null : null,
        payee: payeeInput.value.trim(),
        memo: memoInput.value.trim(),
        amount: signed,
        kind: mode,
        cleared: clearedInput.checked,
      };

      if (transaction) {
        commit((s) => actions.updateTransaction(s, transaction.id, patch), { label: 'edit transaction' });
        closeModal();
        undoToast('Transaction updated.');
      } else {
        commit((s) => actions.addTransaction(s, patch), { label: 'transaction' });
        closeModal();
        undoToast(mode === 'income' ? 'Income recorded.' : 'Expense recorded.');
      }
    };
  };

  const showError = (message: string): void => {
    mount(errorSlot, h('p.form-error', null, icon('alert', { size: 15 }), h('span', { text: message })));
  };

  const submit = h('button.btn.btn-primary', { type: 'button', text: editing ? 'Save changes' : 'Add' });
  const footer: Child[] = [
    transaction
      ? h('button.btn.btn-danger-ghost', {
          type: 'button',
          text: 'Delete',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Delete this transaction?',
              message: 'It will be removed from your budget and account balance.',
              confirmLabel: 'Delete',
              danger: true,
            });
            if (!ok) return;
            commit((s) => actions.deleteTransaction(s, transaction.id), { label: 'delete transaction' });
            closeModal();
            undoToast('Transaction deleted.');
          },
        })
      : null,
    h('div.foot-spacer'),
    h('button.btn', { type: 'button', text: 'Cancel', onclick: closeModal }),
    submit,
  ];

  render();
  openModal({ title: editing ? 'Edit transaction' : 'Add transaction', body, footer });
}

/* ── Card payment ─────────────────────────────────────────────────────── */

export function openPaymentForm(cardId: string): void {
  const state = getState();
  const card = state.accounts.find((a) => a.id === cardId);
  if (!isCredit(card)) return;
  const snapshot = cardSnapshot(state, card);
  const sources = state.accounts.filter((a) => !a.archived && !isCredit(a));
  if (!sources.length) {
    toast('Add a chequing or cash account to pay from.', { tone: 'warning' });
    return;
  }

  const amountInput = moneyInput({ value: centsToInput(suggestedPayment(snapshot)), required: true });
  const dateInput = h<HTMLInputElement>('input.input', { type: 'date', value: todayISO(), required: true });
  const fromSelect = select(accountOptions(state, { selected: sources[0].id, filter: (a) => !isCredit(a) }));
  const memoInput = input({ placeholder: 'Optional note' });
  const errorSlot = h('div.form-error-slot');

  const presets = [
    { label: 'Reserved in budget', value: snapshot.reserved, hint: 'Pay exactly what the budget has set aside' },
    { label: 'Statement balance', value: snapshot.statementBalance, hint: 'What the issuer billed you' },
    { label: 'Full balance', value: snapshot.balance, hint: 'Clears the card to zero' },
    { label: 'Minimum', value: snapshot.minimumPayment, hint: 'Avoids a late fee only' },
  ].filter((preset) => preset.value > 0);

  const body = h(
    'form.form',
    { onsubmit: (event: Event) => event.preventDefault() },
    h(
      'div.pay-summary',
      null,
      h('div.pay-row', null, h('span', { text: 'Balance' }), h('strong', { text: formatMoney(snapshot.balance, money()) })),
      h('div.pay-row', null, h('span', { text: 'Set aside in budget' }), h('strong', { text: formatMoney(snapshot.reserved, money()) })),
      snapshot.uncovered > 0
        ? h(
            'div.pay-row',
            null,
            h('span', { text: 'Not yet funded' }),
            h('strong.money.is-negative', { text: formatMoney(snapshot.uncovered, money()) }),
          )
        : h('div.pay-row', null, h('span', { text: 'Coverage' }), statusPill('good', 'Fully funded', { size: 'sm' })),
    ),
    presets.length
      ? h(
          'div.preset-row',
          null,
          presets.map((preset) =>
            h(
              'button.preset',
              {
                type: 'button',
                onclick: () => {
                  amountInput.value = centsToInput(preset.value);
                  amountInput.focus();
                },
                title: preset.hint,
              },
              h('span.preset-label', { text: preset.label }),
              h('span.preset-value', { text: formatMoney(preset.value, { ...money(), cents: false }) }),
            ),
          ),
        )
      : null,
    h('div.form-grid', null, field('Amount', amountInput, { id: 'pay-amount' }), field('Date', dateInput, { id: 'pay-date' })),
    field('Pay from', fromSelect, { id: 'pay-from' }),
    field('Memo', memoInput, { id: 'pay-memo' }),
    errorSlot,
  );

  const submit = h('button.btn.btn-primary', {
    type: 'button',
    text: 'Record payment',
    onclick: () => {
      const amount = Math.abs(parseMoney(amountInput.value));
      if (!amount) {
        mount(errorSlot, h('p.form-error', null, icon('alert', { size: 15 }), h('span', { text: 'Enter an amount.' })));
        return;
      }
      commit(
        (s) => actions.payCard(s, { cardId, fromAccountId: fromSelect.value, amount, date: dateInput.value, memo: memoInput.value.trim() }),
        { label: 'card payment' },
      );
      closeModal();
      undoToast(`Payment of ${formatMoney(amount, money())} recorded.`);
    },
  });

  openModal({
    title: `Pay ${card.name}`,
    body,
    footer: [h('div.foot-spacer'), h('button.btn', { type: 'button', text: 'Cancel', onclick: closeModal }), submit],
  });
}

function suggestedPayment(snapshot: CardSnapshot): Cents {
  if (snapshot.reserved > 0) return Math.min(snapshot.reserved, snapshot.balance);
  if (snapshot.statementBalance > 0) return snapshot.statementBalance;
  return snapshot.minimumPayment;
}

/* ── Account ──────────────────────────────────────────────────────────── */

export function openAccountForm({ account = null, presetType }: AccountFormOptions = {}): void {
  /** Const alias so the null check narrows inside the deferred handlers below. */
  const existing = account;
  const editing = Boolean(existing);
  let type: AccountType = account?.type ?? presetType ?? 'checking';

  const body = h('form.form', { onsubmit: (event: Event) => event.preventDefault() });
  const errorSlot = h('div.form-error-slot');
  const nameInput = input({ value: account?.name ?? '', placeholder: 'Everyday Checking', required: true });

  const render = (): void => {
    const credit = type === 'credit';
    const wallet = type === 'wallet';
    const providerInput = input({
      value: existing?.provider ?? '',
      placeholder: 'GCash',
      list: 'wallet-providers',
      autocomplete: 'off',
    });
    const openingInput = moneyInput({
      value: account ? centsToInput(account.openingBalance) : '',
      placeholder: '0.00',
    });
    openingInput.dataset.role = 'opening';

    // Card terms only exist on a card, so read them through the narrowed value.
    const terms = isCredit(account) ? account : null;
    const limitInput = moneyInput({ value: terms?.creditLimit ? centsToInput(terms.creditLimit) : '' });
    const aprInput = h<HTMLInputElement>('input.input', {
      type: 'number', step: '0.01', min: '0', max: '99',
      value: terms?.apr ? (terms.apr * 100).toFixed(2) : '',
      placeholder: '19.99',
    });
    const statementInput = h<HTMLInputElement>('input.input', {
      type: 'number', min: '1', max: '31', value: terms?.statementDay ?? 18,
    });
    const dueInput = h<HTMLInputElement>('input.input', {
      type: 'number', min: '1', max: '31', value: terms?.dueDay ?? 12,
    });
    const minRateInput = h<HTMLInputElement>('input.input', {
      type: 'number', step: '0.1', min: '0', max: '100',
      value: ((terms?.minPaymentRate ?? 0.02) * 100).toFixed(1),
    });
    const minFloorInput = moneyInput({ value: centsToInput(terms?.minPaymentFloor ?? 2500) });

    mount(
      body,
      field(
        'Account type',
        select(
          Object.entries(ACCOUNT_TYPES).map(([value, meta]) => ({
            value, label: meta.label, selected: value === type,
          })),
          {
            onchange: (event: Event) => {
              type = (event.target as HTMLSelectElement).value as AccountType;
              render();
            },
            disabled: editing || null,
          },
        ),
        { id: 'acct-type', hint: editing ? 'Type cannot change after creation.' : undefined },
      ),
      field('Name', nameInput, { id: 'acct-name' }),
      wallet
        ? h(
            'div',
            null,
            h('datalist#wallet-providers', null, WALLET_PROVIDERS.map((n) => h('option', { value: n }))),
            field('Provider', providerInput, {
              id: 'acct-provider',
              hint: 'Who runs the wallet. Shown beside the account so two wallets never look alike.',
            }),
          )
        : null,
      field(credit ? 'Balance owed today' : 'Current balance', openingInput, {
        id: 'acct-opening',
        hint: credit
          ? 'Existing debt. Nothing was budgeted for it, so it shows as unfunded until you assign money to the card.'
          : 'Money already in the account — this becomes your starting funds to budget.',
      }),
      credit
        ? h(
            'div.form-section',
            null,
            h('h3.form-section-title', { text: 'Card terms' }),
            h(
              'div.form-grid',
              null,
              field('Credit limit', limitInput, { id: 'acct-limit' }),
              field('APR %', aprInput, { id: 'acct-apr', hint: 'Used for interest projections' }),
            ),
            h(
              'div.form-grid',
              null,
              field('Statement closes on day', statementInput, { id: 'acct-statement' }),
              field('Payment due on day', dueInput, { id: 'acct-due' }),
            ),
            h(
              'div.form-grid',
              null,
              field('Minimum payment %', minRateInput, { id: 'acct-min-rate' }),
              field('Minimum payment floor', minFloorInput, { id: 'acct-min-floor' }),
            ),
            h(
              'div.inline-note',
              null,
              icon('link', { size: 16 }),
              h('p', { text: 'A payment envelope is created for this card automatically, so every charge sets cash aside for the bill.' }),
            ),
          )
        : null,
      errorSlot,
    );

    submit.onclick = () => {
      const name = nameInput.value.trim();
      if (!name) {
        mount(errorSlot, h('p.form-error', null, icon('alert', { size: 15 }), h('span', { text: 'Give the account a name.' })));
        return;
      }
      const openingRaw = Math.abs(parseMoney(openingInput.value));
      const patch: AccountDraft = {
        name,
        type,
        openingBalance: credit ? -openingRaw : openingRaw,
        ...(wallet ? { provider: providerInput.value.trim() } : {}),
      };
      if (credit) {
        Object.assign(patch, {
          creditLimit: Math.abs(parseMoney(limitInput.value)),
          apr: Math.max(0, Number.parseFloat(aprInput.value || '0')) / 100,
          statementDay: clampDay(statementInput.value, 18),
          dueDay: clampDay(dueInput.value, 12),
          minPaymentRate: Math.max(0, Number.parseFloat(minRateInput.value || '2')) / 100,
          minPaymentFloor: Math.abs(parseMoney(minFloorInput.value)),
        });
      }

      if (account) {
        commit((s) => actions.updateAccount(s, account.id, patch), { label: 'edit account' });
        closeModal();
        undoToast('Account updated.');
      } else {
        commit((s) => actions.addAccount(s, patch), { label: 'add account' });
        closeModal();
        undoToast(credit ? 'Card added — payment envelope created.' : 'Account added.');
      }
    };
  };

  const submit = h('button.btn.btn-primary', { type: 'button', text: editing ? 'Save changes' : 'Add account' });
  const footer: Child[] = [
    existing
      ? h('button.btn.btn-danger-ghost', {
          type: 'button',
          text: 'Delete',
          onclick: async () => {
            const ok = await confirmDialog({
              title: `Delete ${existing.name}?`,
              message: 'Its transactions will be removed too. This cannot be undone from another device.',
              confirmLabel: 'Delete account',
              danger: true,
            });
            if (!ok) return;
            commit((s) => actions.deleteAccount(s, existing.id), { label: 'delete account' });
            closeModal();
            undoToast('Account deleted.');
          },
        })
      : null,
    h('div.foot-spacer'),
    h('button.btn', { type: 'button', text: 'Cancel', onclick: closeModal }),
    submit,
  ];

  render();
  openModal({ title: account ? `Edit ${account.name}` : 'Add account', body, footer });
}

function clampDay(value: string, fallback: number): number {
  const day = Number.parseInt(value, 10);
  if (!Number.isFinite(day)) return fallback;
  return Math.min(31, Math.max(1, day));
}

/* ── Category ─────────────────────────────────────────────────────────── */

export function openCategoryForm({ category = null }: CategoryFormOptions = {}): void {
  const state = getState();
  /** Const alias so the null check narrows inside the deferred handlers below. */
  const existing = category;
  const editing = Boolean(existing);
  if (category?.kind === 'ccPayment') {
    toast('Card payment envelopes are managed with their card.', { tone: 'info' });
    return;
  }

  const nameInput = input({ value: category?.name ?? '', placeholder: 'Groceries', required: true });
  const groups = [...new Set(state.categories.filter((c) => c.kind === 'spending').map((c) => c.group))];
  const groupInput = input({
    value: category?.group ?? groups[0] ?? 'Everyday',
    list: 'group-suggestions',
    placeholder: 'Everyday',
  });
  let color: SeriesColor =
    category?.color ?? CATEGORY_COLORS[state.categories.length % CATEGORY_COLORS.length] ?? 'series-1';

  const swatches = h('div.swatch-row', { role: 'radiogroup', 'aria-label': 'Colour' });
  const paintSwatches = (): void => {
    mount(
      swatches,
      ...CATEGORY_COLORS.map((slot) =>
        h('button', {
          type: 'button',
          class: `swatch${slot === color ? ' is-active' : ''}`,
          role: 'radio',
          'aria-checked': String(slot === color),
          'aria-label': `Colour ${slot.split('-')[1]}`,
          style: { background: `var(--${slot})` },
          onclick: () => {
            color = slot;
            paintSwatches();
          },
        }),
      ),
    );
  };
  paintSwatches();

  const errorSlot = h('div.form-error-slot');
  const body = h(
    'form.form',
    { onsubmit: (event: Event) => event.preventDefault() },
    h('datalist#group-suggestions', null, groups.map((g) => h('option', { value: g }))),
    field('Name', nameInput, { id: 'cat-name' }),
    field('Group', groupInput, { id: 'cat-group', hint: 'Categories are shown grouped in the budget.' }),
    field('Colour', swatches, { hint: 'Used consistently in every chart.' }),
    errorSlot,
  );

  const submit = h('button.btn.btn-primary', {
    type: 'button',
    text: editing ? 'Save changes' : 'Add category',
    onclick: () => {
      const name = nameInput.value.trim();
      if (!name) {
        mount(errorSlot, h('p.form-error', null, icon('alert', { size: 15 }), h('span', { text: 'Give the category a name.' })));
        return;
      }
      const patch = { name, group: groupInput.value.trim() || 'Everyday', color };
      if (category) commit((s) => actions.updateCategory(s, category.id, patch), { label: 'edit category' });
      else commit((s) => actions.addCategory(s, patch), { label: 'add category' });
      closeModal();
      undoToast(category ? 'Category updated.' : 'Category added.');
    },
  });

  const footer: Child[] = [
    existing
      ? h('button.btn.btn-danger-ghost', {
          type: 'button',
          text: 'Delete',
          onclick: async () => {
            const ok = await confirmDialog({
              title: `Delete ${existing.name}?`,
              message: 'Transactions keep their history but become uncategorised.',
              confirmLabel: 'Delete',
              danger: true,
            });
            if (!ok) return;
            commit((s) => actions.deleteCategory(s, existing.id), { label: 'delete category' });
            closeModal();
            undoToast('Category deleted.');
          },
        })
      : null,
    h('div.foot-spacer'),
    h('button.btn', { type: 'button', text: 'Cancel', onclick: closeModal }),
    submit,
  ];

  openModal({ title: category ? `Edit ${category.name}` : 'New category', body, footer, size: 'sm' });
}

/* ── Move money between envelopes ─────────────────────────────────────── */

export function openMoveMoneyForm(
  { month, fromCategoryId, available }: { month: MonthKey; fromCategoryId: string; available: Cents },
): void {
  const state = getState();
  const from = state.categories.find((c) => c.id === fromCategoryId);
  if (!from) return;
  const targets = state.categories.filter((c) => !c.archived && c.id !== fromCategoryId);
  if (!targets.length) return;

  const amountInput = moneyInput({ value: centsToInput(Math.max(0, available)) });
  const toSelect = select(categoryOptions(state, { includePayments: true }).map((group) => ({
    group: group.group,
    options: group.options.filter((o) => o.value !== fromCategoryId),
  })));

  const body = h(
    'form.form',
    { onsubmit: (event: Event) => event.preventDefault() },
    h('p.modal-text', { text: `${from.name} has ${formatMoney(available, money())} available.` }),
    field('Move', amountInput, { id: 'move-amount' }),
    field('To', toSelect, { id: 'move-to' }),
  );

  openModal({
    title: 'Move money',
    size: 'sm',
    body,
    footer: [
      h('div.foot-spacer'),
      h('button.btn', { type: 'button', text: 'Cancel', onclick: closeModal }),
      h('button.btn.btn-primary', {
        type: 'button',
        text: 'Move',
        onclick: () => {
          const amount = Math.abs(parseMoney(amountInput.value));
          if (!amount) return;
          commit((s) => actions.moveBudget(s, month, fromCategoryId, toSelect.value, amount), {
            label: 'move money',
          });
          closeModal();
          undoToast('Money moved.');
        },
      }),
    ],
  });
}

/**
 * Assign the budget's spare cash straight to a card's payment envelope — the
 * one-click fix for unfunded card debt.
 */
export function openFundCardForm(cardId: string, { month }: { month: MonthKey }): void {
  const state = getState();
  const card = state.accounts.find((a) => a.id === cardId);
  const paymentCategory = paymentCategoryFor(state, cardId);
  if (!isCredit(card) || !paymentCategory) return;
  const snapshot = cardSnapshot(state, card, { month });

  const amountInput = moneyInput({ value: centsToInput(snapshot.uncovered) });
  const body = h(
    'form.form',
    { onsubmit: (event: Event) => event.preventDefault() },
    h('p.modal-text', {
      text: `${formatMoney(snapshot.uncovered, money())} of this card's balance has no cash set aside. Assigning money to its payment envelope turns that debt into a funded plan.`,
    }),
    field('Assign to payment envelope', amountInput, { id: 'fund-amount' }),
  );

  openModal({
    title: `Fund ${card.name}`,
    size: 'sm',
    body,
    footer: [
      h('div.foot-spacer'),
      h('button.btn', { type: 'button', text: 'Cancel', onclick: closeModal }),
      h('button.btn.btn-primary', {
        type: 'button',
        text: 'Assign',
        onclick: () => {
          const amount = Math.abs(parseMoney(amountInput.value));
          if (!amount) return;
          const existing = getState().budgets[month]?.[paymentCategory.id] || 0;
          commit((s) => actions.setBudget(s, month, paymentCategory.id, existing + amount), {
            label: 'fund card',
          });
          closeModal();
          undoToast(`${formatMoney(amount, money())} assigned to ${card.name}.`);
        },
      }),
    ],
  });
}
