/** Dialog forms: transactions, transfers, card payments, accounts, categories. */

import { h, mount, type Child } from './dom.ts';
import { openModal, close as closeModal, confirmDialog } from './modal.ts';
import { toast } from './toast.ts';
import { field, input, moneyInput, select, segmented, statusPill } from './components.ts';
import type { SelectGroup, SelectOption } from './components.ts';
import { icon } from './icons.ts';
import { parseMoney, centsToInput, formatMoney } from '../core/money.ts';
import { addMonths, currentMonth, formatDate, monthLabel, monthOf, todayISO } from '../core/dates.ts';
import {
  ACCOUNT_TYPES, BILL_CADENCES, CARD_ISSUERS, CATEGORY_COLORS, isCredit, isLoan, isWallet,
  LOAN_KINDS, paymentCategoryFor, sameBank, sharedLimitFor, sharedLimitMembers, WALLET_PROVIDERS,
} from '../core/model.ts';
import type {
  Account, AccountType, Bill, BillCadence, Category, Cents, CreditAccount, Installment, ISODate,
  MonthKey, SeriesColor, Transaction, TxKind,
} from '../core/model.ts';
import { billById, billSnapshot } from '../core/bills.ts';
import { categoryRow, monthSummary } from '../core/budget.ts';
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

  /**
   * Which limit this card draws on: '' for its own, `card:<id>` to share with a
   * card that has no group yet, `limit:<id>` to join an existing one. Held out
   * here because choosing it re-renders the form, and a value that lived inside
   * `render` would be thrown away by the render it triggers.
   */
  let sharedChoice = isCredit(account) && account.sharedLimitId ? `limit:${account.sharedLimitId}` : '';
  /** The limit figure, likewise preserved across those re-renders. */
  let limitDraft = isCredit(account) && account.creditLimit ? centsToInput(account.creditLimit) : '';
  if (isCredit(account)) {
    const joined = sharedLimitFor(getState(), account);
    if (joined) limitDraft = centsToInput(joined.creditLimit);
  }
  /** The bank as currently typed, which decides who this card may share with. */
  let providerDraft = existing?.provider ?? '';
  /** Whether the rate is being entered per year or per month. */
  let rateBasis: 'annual' | 'monthly' =
    isCredit(account) && account.rateBasis === 'monthly' ? 'monthly' : 'annual';

  const render = (): void => {
    const credit = type === 'credit';
    const wallet = type === 'wallet';
    const loan = type === 'loan';
    // One field, two vocabularies: a wallet has a provider, a card has an
    // issuing bank. They are the same fact — who runs the account — so they
    // share `provider` rather than growing a second nearly-identical column.
    const providerInput = input({
      value: providerDraft,
      placeholder: credit ? 'BPI' : loan ? 'Pag-IBIG' : 'GCash',
      list: credit ? 'card-issuers' : 'wallet-providers',
      autocomplete: 'off',
      oninput: (event: Event) => {
        providerDraft = (event.target as HTMLInputElement).value;
      },
      // Who this card may share a limit with depends entirely on the bank, so
      // just that field is rebuilt once this one settles. Re-rendering the whole
      // form from inside a change handler would tear out the element currently
      // losing focus.
      onchange: () => {
        if (credit) mount(sharedSlot, sharedLimitField());
      },
    });
    const openingInput = moneyInput({
      value: account ? centsToInput(account.openingBalance) : '',
      placeholder: '0.00',
    });
    openingInput.dataset.role = 'opening';

    // Card terms only exist on a card, so read them through the narrowed value.
    const terms = isCredit(account) ? account : null;
    const limitInput = moneyInput({
      value: limitDraft,
      oninput: (event: Event) => {
        limitDraft = (event.target as HTMLInputElement).value;
      },
    });
    // Philippine banks quote a monthly rate — a BDO statement says 3.5%, not
    // 42% — so the unit is part of the field rather than something to convert
    // in your head. `apr` is stored annually either way.
    const shownRate = terms?.apr
      ? (rateBasis === 'monthly' ? (terms.apr / 12) * 100 : terms.apr * 100)
      : null;
    const aprInput = h<HTMLInputElement>('input.input', {
      type: 'number', step: '0.01', min: '0', max: '99',
      value: shownRate == null ? '' : shownRate.toFixed(2),
      placeholder: rateBasis === 'monthly' ? '3.50' : '19.99',
      oninput: () => renderRateHint(),
    });
    aprInput.id = 'acct-apr';
    const rateBasisSelect = select(
      [
        { value: 'annual', label: 'per year', selected: rateBasis === 'annual' },
        { value: 'monthly', label: 'per month', selected: rateBasis === 'monthly' },
      ],
      {
        class: 'input rate-basis',
        'aria-label': 'Rate period',
        onchange: (event: Event) => {
          // The typed digits are left exactly as they are. Someone copying a
          // figure off a statement and then setting the unit means "this number
          // is monthly", not "convert my number" — rewriting 3.5 to 0.29 under
          // them would be a change they did not ask for and might not notice.
          // The hint below states the equivalent immediately instead.
          rateBasis = (event.target as HTMLSelectElement).value === 'monthly' ? 'monthly' : 'annual';
          aprInput.placeholder = rateBasis === 'monthly' ? '3.50' : '19.99';
          renderRateHint();
        },
      },
    );
    const rateHint = h('span.field-hint');
    const renderRateHint = (): void => {
      const typed = Number.parseFloat(aprInput.value || '0');
      if (!Number.isFinite(typed) || !typed) {
        rateHint.textContent = 'Used for interest projections.';
        return;
      }
      rateHint.textContent =
        rateBasis === 'monthly'
          ? `${typed.toFixed(2)}% a month is ${(typed * 12).toFixed(2)}% a year.`
          : `${typed.toFixed(2)}% a year is ${(typed / 12).toFixed(2)}% a month.`;
    };
    renderRateHint();
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

    // Loan terms. A loan is repaid, never spent on, so what it needs is the
    // monthly amortisation and how long it runs — not a limit.
    const loanTerms = isLoan(account) ? account : null;
    const loanKindInput = input({
      value: loanTerms?.kind ?? '',
      placeholder: 'Auto loan',
      list: 'loan-kinds',
      autocomplete: 'off',
    });
    const principalInput = moneyInput({
      value: loanTerms?.principal ? centsToInput(loanTerms.principal) : '',
    });
    const monthlyPaymentInput = moneyInput({
      value: loanTerms?.monthlyPayment ? centsToInput(loanTerms.monthlyPayment) : '',
    });
    const termInput = h<HTMLInputElement>('input.input', {
      type: 'number', min: '1', max: '600', step: '1',
      value: loanTerms?.termMonths ? String(loanTerms.termMonths) : '',
      placeholder: '48',
    });
    const loanDueInput = h<HTMLInputElement>('input.input', {
      type: 'number', min: '1', max: '31', value: loanTerms?.dueDay ?? 5,
    });
    const loanStartInput = h<HTMLInputElement>('input.input', {
      type: 'month', value: loanTerms?.startMonth || currentMonth(),
    });

    /**
     * Who this card shares its limit with.
     *
     * A shared limit only exists within one bank, so the options are drawn from
     * cards carrying the same `provider` — and with no bank typed there is
     * nothing to draw from, which the hint says rather than showing an empty
     * list. Existing groups are named by the cards on them, because that is how
     * someone recognises which limit is which.
     */
    const sharedLimitField = (): HTMLElement | null => {
      if (!credit) return null;
      const state = getState();
      const bank = providerDraft.trim();

      if (!bank) {
        return h(
          'div.inline-note',
          null,
          icon('info', { size: 16 }),
          h('p', {
            text: 'Some banks issue two cards that draw on one limit. Name the issuing bank above and Zenith can link them.',
          }),
        );
      }

      const sameBankCards = state.accounts.filter(
        (a): a is CreditAccount => isCredit(a) && !a.archived && a.id !== account?.id && sameBank(a.provider, bank),
      );
      const groups = (state.sharedLimits ?? []).filter((limit) => sameBank(limit.provider, bank));

      if (!sameBankCards.length && !groups.length) {
        return h(
          'div.inline-note',
          null,
          icon('info', { size: 16 }),
          h('p', {
            text: `This is your only ${bank} card. Add a second one and you can put them both on a single shared limit.`,
          }),
        );
      }

      const options: SelectOption[] = [
        { value: '', label: 'It has its own limit', selected: sharedChoice === '' },
      ];
      for (const limit of groups) {
        const names = sharedLimitMembers(state, limit.id)
          .filter((member) => member.id !== account?.id)
          .map((member) => member.name)
          .join(' + ');
        options.push({
          value: `limit:${limit.id}`,
          label: names ? `Shared with ${names}` : limit.name,
          selected: sharedChoice === `limit:${limit.id}`,
        });
      }
      for (const other of sameBankCards) {
        if (other.sharedLimitId) continue; // already offered as a group above
        options.push({
          value: `card:${other.id}`,
          label: `Shared with ${other.name}`,
          selected: sharedChoice === `card:${other.id}`,
        });
      }

      return field(
        'Credit limit is',
        select(options, {
          onchange: (event: Event) => {
            sharedChoice = (event.target as HTMLSelectElement).value;
            paintLimitLabel();
          },
        }),
        {
          id: 'acct-shared',
          hint: `Only ${bank} cards can share a limit — a shared limit is one the bank granted across its own cards.`,
        },
      );
    };
    const limitLabel = h('span.field-label');
    const limitHint = h('span.field-hint');
    const paintLimitLabel = (): void => {
      const sharing = sharedChoice !== '';
      limitLabel.textContent = sharing ? 'Shared credit limit' : 'Credit limit';
      limitHint.textContent = sharing
        ? 'One limit for every card sharing it — changing it here changes it for all of them.'
        : '';
    };
    paintLimitLabel();
    limitInput.id = 'acct-limit';

    const sharedSlot = h('div');
    if (credit) mount(sharedSlot, sharedLimitField());

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
      wallet || credit || loan
        ? h(
            'div',
            null,
            credit || loan
              ? h(
                  'datalist#card-issuers',
                  null,
                  CARD_ISSUERS.map((issuer) => h('option', { value: issuer.name, label: issuer.region })),
                )
              : h('datalist#wallet-providers', null, WALLET_PROVIDERS.map((n) => h('option', { value: n }))),
            field(credit ? 'Issuing bank' : loan ? 'Lender' : 'Provider', providerInput, {
              id: 'acct-provider',
              hint: credit
                ? 'The bank behind the card. Philippine issuers are listed first; anything else can be typed.'
                : loan
                  ? 'Who lent the money — a bank, Pag-IBIG, SSS, a dealership.'
                  : 'Who runs the wallet. Shown beside the account so two wallets never look alike.',
            }),
          )
        : null,
      field(credit || loan ? 'Balance owed today' : 'Current balance', openingInput, {
        id: 'acct-opening',
        hint: credit
          ? 'Existing debt. Nothing was budgeted for it, so it shows as unfunded until you assign money to the card.'
          : loan
            ? 'What is still outstanding. It was never income, so it does not add to what you have to budget.'
            : 'Money already in the account — this becomes your starting funds to budget.',
      }),
      loan
        ? h(
            'div.form-section',
            null,
            h('datalist#loan-kinds', null, LOAN_KINDS.map((name) => h('option', { value: name }))),
            h('h3.form-section-title', { text: 'Loan terms' }),
            field('What kind of loan', loanKindInput, { id: 'acct-loan-kind' }),
            h(
              'div.form-grid',
              null,
              field('Amount borrowed', principalInput, {
                id: 'acct-principal',
                hint: 'The original amount, for tracking progress.',
              }),
              field('Monthly payment', monthlyPaymentInput, { id: 'acct-monthly' }),
            ),
            h(
              'div.form-grid',
              null,
              field('Number of months', termInput, { id: 'acct-term' }),
              field('Payment due on day', loanDueInput, { id: 'acct-loan-due' }),
            ),
            field('First payment', loanStartInput, { id: 'acct-loan-start' }),
            h(
              'div.inline-note',
              null,
              icon('link', { size: 16 }),
              h('p', {
                text: 'A payment envelope is created for this loan. Budget the monthly amount into it and paying the loan spends it — which is what keeps your accounts and your budget in step.',
              }),
            ),
          )
        : null,
      credit
        ? h(
            'div.form-section',
            null,
            h('h3.form-section-title', { text: 'Card terms' }),
            h(
              'div.form-grid',
              null,
              h(
                'label.field',
                { for: 'acct-limit' },
                limitLabel,
                limitInput,
                limitHint,
              ),
              h(
                'label.field',
                { for: 'acct-apr' },
                h('span.field-label', { text: 'Interest rate %' }),
                h('div.rate-row', null, aprInput, rateBasisSelect),
                rateHint,
              ),
            ),
            sharedSlot,
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
        openingBalance: credit || loan ? -openingRaw : openingRaw,
        ...(wallet || credit || loan ? { provider: providerInput.value.trim() } : {}),
      };
      if (loan) {
        Object.assign(patch, {
          kind: loanKindInput.value.trim(),
          principal: Math.abs(parseMoney(principalInput.value)),
          monthlyPayment: Math.abs(parseMoney(monthlyPaymentInput.value)),
          termMonths: Math.max(0, Number.parseInt(termInput.value, 10) || 0),
          dueDay: clampDay(loanDueInput.value, 5),
          startMonth: loanStartInput.value || currentMonth(),
        });
      }
      if (credit) {
        const typedRate = Math.max(0, Number.parseFloat(aprInput.value || '0')) / 100;
        Object.assign(patch, {
          creditLimit: Math.abs(parseMoney(limitInput.value)),
          // Stored annually whatever was typed, so every projection has one basis.
          apr: rateBasis === 'monthly' ? typedRate * 12 : typedRate,
          rateBasis,
          statementDay: clampDay(statementInput.value, 18),
          dueDay: clampDay(dueInput.value, 12),
          minPaymentRate: Math.max(0, Number.parseFloat(minRateInput.value || '2')) / 100,
          minPaymentFloor: Math.abs(parseMoney(minFloorInput.value)),
        });
      }

      const limitCents = Math.abs(parseMoney(limitInput.value));

      /**
       * Apply the sharing choice to a card that now exists.
       *
       * Deliberately after the account itself is written: a brand-new card has
       * no id to link until `addAccount` has given it one.
       */
      const applySharing = (state: AppState, cardId: string): AppState => {
        if (!credit) return state;
        if (sharedChoice === '') return actions.leaveSharedLimit(state, cardId);
        if (sharedChoice.startsWith('card:')) {
          return actions.shareLimitWith(state, cardId, sharedChoice.slice(5), { creditLimit: limitCents });
        }
        const limitId = sharedChoice.slice(6);
        return actions.updateSharedLimit(
          actions.joinSharedLimit(state, cardId, limitId),
          limitId,
          { creditLimit: limitCents },
        );
      };

      if (account) {
        commit((s) => applySharing(actions.updateAccount(s, account.id, patch), account.id), {
          label: 'edit account',
        });
        closeModal();
        undoToast('Account updated.');
      } else {
        commit(
          (s) => {
            const before = new Set(s.accounts.map((a) => a.id));
            const next = actions.addAccount(s, patch);
            const created = next.accounts.find((a) => !before.has(a.id));
            return created ? applySharing(next, created.id) : next;
          },
          { label: 'add account' },
        );
        closeModal();
        undoToast(
          credit ? 'Card added — payment envelope created.'
            : loan ? 'Loan added — payment envelope created.'
            : 'Account added.',
        );
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

/* ── Instalment plan ──────────────────────────────────────────────────── */

export interface InstallmentFormOptions {
  cardId: string;
  installment?: Installment | null;
  /** Prefilled when the plan was read off a statement row. */
  draft?: Partial<Installment>;
}

/**
 * Add or edit an instalment plan.
 *
 * The form asks for the monthly billing and the term rather than the purchase
 * price, because those are the two figures the statement actually shows — and
 * they are what the budget needs. The price is optional, and only earns its
 * place by revealing what a "0%" plan really costs.
 */
export function openInstallmentForm({
  cardId, installment = null, draft = {},
}: InstallmentFormOptions): void {
  const state = getState();
  const card = state.accounts.find((a) => a.id === cardId);
  if (!isCredit(card)) return;
  const existing = installment;

  const start = installment?.startMonth ?? draft.startMonth ?? currentMonth();
  const descriptionInput = input({
    value: installment?.description ?? draft.description ?? '',
    placeholder: 'Appliance — SM Megamall',
    required: true,
  });
  const monthlyInput = moneyInput({
    value: centsToInput(installment?.monthlyAmount ?? draft.monthlyAmount ?? 0),
    required: true,
  });
  const monthsInput = h<HTMLInputElement>('input.input', {
    type: 'number', min: '2', max: '60', step: '1',
    value: String(installment?.months ?? draft.months ?? 12),
  });
  const startInput = h<HTMLInputElement>('input.input', { type: 'month', value: start });
  const principalInput = moneyInput({
    value: installment?.principal ? centsToInput(installment.principal) : '',
    placeholder: 'Optional',
  });

  const summarySlot = h('div.hint-slot');
  const renderSummary = (): void => {
    const monthly = Math.abs(parseMoney(monthlyInput.value));
    const months = Math.max(0, Number.parseInt(monthsInput.value, 10) || 0);
    const principal = Math.abs(parseMoney(principalInput.value));
    if (!monthly || !months) {
      mount(summarySlot);
      return;
    }
    const total = monthly * months;
    const cost = principal ? total - principal : null;
    mount(
      summarySlot,
      h(
        'div.inline-note',
        null,
        icon('info', { size: 16 }),
        h('p', {
          text:
            `${months} × ${formatMoney(monthly, money())} is ${formatMoney(total, money())} in total` +
            (cost == null
              ? ', ending ' + monthLabel(addMonths(startInput.value || start, months - 1), money().locale) + '.'
              : cost > 0
                ? `, which is ${formatMoney(cost, money())} more than the ${formatMoney(principal, money())} price — not 0%.`
                : `, the same as the ${formatMoney(principal, money())} price. A genuine 0% plan.`),
        }),
      ),
    );
  };
  for (const control of [monthlyInput, monthsInput, principalInput, startInput]) {
    control.addEventListener('input', renderSummary);
  }
  renderSummary();

  const errorSlot = h('div.form-error-slot');
  const body = h(
    'form.form',
    { onsubmit: (event: Event) => event.preventDefault() },
    field('What was bought', descriptionInput, { id: 'inst-what' }),
    h(
      'div.form-grid',
      null,
      field('Billed each month', monthlyInput, { id: 'inst-monthly' }),
      field('Number of months', monthsInput, { id: 'inst-months' }),
    ),
    h(
      'div.form-grid',
      null,
      field('First instalment', startInput, {
        id: 'inst-start',
        hint: 'The month the first one was billed.',
      }),
      field('Purchase price', principalInput, {
        id: 'inst-principal',
        hint: 'Optional — reveals what the plan costs.',
      }),
    ),
    summarySlot,
    h('div.inline-note', null, icon('info', { size: 16 }), h('p', {
      text: 'Tracking a plan does not create any transactions. Each month\u2019s instalment still arrives as an ordinary charge — this is here so you can see what is still to come.',
    })),
    errorSlot,
  );

  const submit = h('button.btn.btn-primary', {
    type: 'button',
    text: existing ? 'Save changes' : 'Track plan',
    onclick: () => {
      const description = descriptionInput.value.trim();
      const monthlyAmount = Math.abs(parseMoney(monthlyInput.value));
      const months = Math.max(0, Number.parseInt(monthsInput.value, 10) || 0);
      if (!description || !monthlyAmount || months < 2) {
        mount(errorSlot, h('p.form-error', null, icon('alert', { size: 15 }), h('span', {
          text: 'A plan needs a description, a monthly amount and at least two months.',
        })));
        return;
      }
      const patch: Partial<Installment> = {
        accountId: cardId,
        description,
        monthlyAmount,
        months,
        startMonth: startInput.value || currentMonth(),
        principal: Math.abs(parseMoney(principalInput.value)) || null,
      };
      if (existing) commit((s) => actions.updateInstallment(s, existing.id, patch), { label: 'edit plan' });
      else commit((s) => actions.addInstallment(s, patch), { label: 'track plan' });
      closeModal();
      undoToast(existing ? 'Plan updated.' : 'Plan tracked.');
    },
  });

  const footer: Child[] = [
    existing
      ? h('button.btn.btn-danger-ghost', {
          type: 'button',
          text: 'Stop tracking',
          onclick: () => {
            commit((s) => actions.deleteInstallment(s, existing.id), { label: 'delete plan' });
            closeModal();
            undoToast('Plan removed. The charges it billed are untouched.');
          },
        })
      : null,
    h('div.foot-spacer'),
    h('button.btn', { type: 'button', text: 'Cancel', onclick: closeModal }),
    submit,
  ];

  openModal({ title: existing ? 'Edit instalment plan' : `Instalment plan on ${card.name}`, body, footer });
}

/* ── Recurring bills ──────────────────────────────────────────────────── */

export interface BillFormOptions {
  bill?: Bill | null;
  /** Prefilled when the bill was guessed from repeated payments. */
  draft?: Partial<Bill>;
}

/**
 * Add or edit a recurring bill.
 *
 * The form asks for one real due date rather than "which day of the month",
 * because that is the only anchor that works for every cadence: a fortnightly
 * bill has no day of the month, and a quarterly one has three. Everything else
 * — every past and future occurrence — is derived from it.
 */
export function openBillForm({ bill = null, draft = {} }: BillFormOptions = {}): void {
  const state = getState();
  const existing = bill;

  const nameInput = input({
    value: bill?.name ?? draft.name ?? '',
    placeholder: 'Electricity',
    required: true,
  });
  const payeeInput = input({
    value: bill?.payee ?? draft.payee ?? '',
    placeholder: 'Who it is paid to — optional',
    autocomplete: 'off',
  });
  const amountInput = moneyInput({
    value: centsToInput(bill?.amount ?? draft.amount ?? 0),
    required: true,
  });
  const variableInput = h<HTMLInputElement>('input', {
    type: 'checkbox',
    class: 'checkbox',
    checked: bill?.variable ?? draft.variable ?? false,
  });
  const cadenceSelect = select(
    Object.entries(BILL_CADENCES).map(([value, spec]) => ({
      value,
      label: spec.label,
      selected: value === (bill?.cadence ?? draft.cadence ?? 'monthly'),
    })),
  );
  const startInput = h<HTMLInputElement>('input.input', {
    type: 'date',
    value: bill?.startDate ?? draft.startDate ?? todayISO(),
    required: true,
  });
  const endInput = h<HTMLInputElement>('input.input', {
    type: 'date',
    value: bill?.endDate ?? draft.endDate ?? '',
  });
  const categorySelect = select([
    { value: '', label: 'No envelope' },
    ...categoryOptions(state, { selected: bill?.categoryId ?? draft.categoryId ?? null }),
  ]);
  const accountSelect = select([
    { value: '', label: 'Ask each time' },
    ...accountOptions(state, { selected: bill?.accountId ?? draft.accountId ?? undefined }),
  ]);
  const autopayInput = h<HTMLInputElement>('input', {
    type: 'checkbox',
    class: 'checkbox',
    checked: bill?.autopay ?? draft.autopay ?? false,
  });
  const noteInput = input({ value: bill?.note ?? '', placeholder: 'Optional note' });

  const summarySlot = h('div.hint-slot');
  const renderSummary = (): void => {
    const amount = Math.abs(parseMoney(amountInput.value));
    const cadence = cadenceSelect.value as BillCadence;
    const spec = BILL_CADENCES[cadence] ?? BILL_CADENCES.monthly;
    if (!amount || !startInput.value) {
      mount(summarySlot);
      return;
    }
    const perMonth = Math.round((amount * spec.perYear) / 12);
    const next = formatDate(startInput.value, money().locale);
    mount(
      summarySlot,
      h(
        'div.inline-note',
        null,
        icon('repeat', { size: 16 }),
        h('p', {
          text:
            `${formatMoney(amount, money())} ${spec.label.toLowerCase()}, from ${next}` +
            (cadence === 'monthly'
              ? '.'
              : ` — ${formatMoney(perMonth, money())} a month set aside.`) +
            (variableInput.checked
              ? ' Zenith will forecast from what you actually pay.'
              : ''),
        }),
      ),
    );
  };
  for (const control of [amountInput, cadenceSelect, startInput, variableInput]) {
    control.addEventListener('change', renderSummary);
    control.addEventListener('input', renderSummary);
  }
  renderSummary();

  const errorSlot = h('div.form-error-slot');
  const body = h(
    'form.form',
    { onsubmit: (event: Event) => event.preventDefault() },
    h('div.form-grid', null, field('Bill', nameInput, { id: 'bill-name' }), field('Paid to', payeeInput, { id: 'bill-payee' })),
    h(
      'div.form-grid',
      null,
      field('Amount', amountInput, { id: 'bill-amount', hint: 'What it usually costs' }),
      field('How often', cadenceSelect, { id: 'bill-cadence' }),
    ),
    h('label.check-row', null, variableInput, h('span', { text: 'The amount varies — forecast it from what I pay' })),
    h(
      'div.form-grid',
      null,
      field('Next due', startInput, { id: 'bill-start', hint: 'Any real due date; the rest follow from it.' }),
      field('Ends', endInput, { id: 'bill-end', hint: 'Optional — for a fixed-term commitment.' }),
    ),
    h(
      'div.form-grid',
      null,
      field('Budgeted to', categorySelect, { id: 'bill-category' }),
      field('Paid from', accountSelect, { id: 'bill-account' }),
    ),
    h('label.check-row', null, autopayInput, h('span', { text: 'Pays automatically — remind me, but do not ask me to pay it' })),
    field('Note', noteInput, { id: 'bill-note' }),
    summarySlot,
    h('div.inline-note', null, icon('info', { size: 16 }), h('p', {
      text: 'Tracking a bill records no transactions. It says when money is expected to leave; a bill counts as paid once you record the payment against it.',
    })),
    errorSlot,
  );

  const submit = h('button.btn.btn-primary', {
    type: 'button',
    text: existing ? 'Save changes' : 'Track bill',
    onclick: () => {
      const name = nameInput.value.trim();
      const amount = Math.abs(parseMoney(amountInput.value));
      const startDate = startInput.value;
      if (!name || !startDate) {
        mount(errorSlot, h('p.form-error', null, icon('alert', { size: 15 }), h('span', {
          text: 'A bill needs a name and a due date to count from.',
        })));
        return;
      }
      const endDate = endInput.value || null;
      if (endDate && endDate < startDate) {
        mount(errorSlot, h('p.form-error', null, icon('alert', { size: 15 }), h('span', {
          text: 'The end date falls before the first due date.',
        })));
        return;
      }
      const patch: Partial<Bill> = {
        name,
        payee: payeeInput.value.trim(),
        amount,
        variable: variableInput.checked,
        cadence: cadenceSelect.value as BillCadence,
        startDate,
        endDate,
        categoryId: categorySelect.value || null,
        accountId: accountSelect.value || null,
        autopay: autopayInput.checked,
        note: noteInput.value.trim(),
      };
      if (existing) commit((s) => actions.updateBill(s, existing.id, patch), { label: 'edit bill' });
      else commit((s) => actions.addBill(s, patch), { label: 'track bill' });
      closeModal();
      undoToast(existing ? 'Bill updated.' : `${name} is now tracked.`);
    },
  });

  const footer: Child[] = [
    existing
      ? h('button.btn.btn-danger-ghost', {
          type: 'button',
          text: 'Stop tracking',
          onclick: async () => {
            const ok = await confirmDialog({
              title: `Stop tracking ${existing.name}?`,
              message: 'The payments you have recorded stay in the ledger — only the schedule goes.',
              confirmLabel: 'Stop tracking',
              danger: true,
            });
            if (!ok) return;
            commit((s) => actions.deleteBill(s, existing.id), { label: 'delete bill' });
            closeModal();
            undoToast('Bill removed. Its payments are untouched.');
          },
        })
      : null,
    h('div.foot-spacer'),
    h('button.btn', { type: 'button', text: 'Cancel', onclick: closeModal }),
    submit,
  ];

  openModal({ title: existing ? `Edit ${existing.name}` : 'Track a bill', body, footer });
}

/**
 * Record one occurrence of a bill as paid.
 *
 * The amount is the bill's expectation, not a fact, so it is offered and left
 * editable — a metered bill is never what the estimate said. What the dialog
 * insists on is which occurrence is being settled, because that is what turns
 * an ordinary expense into a receipt for this month's electricity.
 */
export function openPayBillForm(billId: string, dueDate: string): void {
  const state = getState();
  const bill = billById(state, billId);
  if (!bill) return;
  const snapshot = billSnapshot(state, bill);
  const expected = snapshot.thisMonth.find((entry) => entry.dueDate === dueDate)?.amount
    ?? snapshot.expected;

  if (!state.accounts.filter((a) => !a.archived).length) {
    toast('Add an account to pay from first.', { tone: 'warning' });
    return openAccountForm();
  }

  const amountInput = moneyInput({ value: centsToInput(expected), required: true });
  const dateInput = h<HTMLInputElement>('input.input', { type: 'date', value: todayISO(), required: true });
  const fromSelect = select(
    accountOptions(state, { selected: bill.accountId ?? undefined }),
  );
  const memoInput = input({ placeholder: 'Optional note' });
  const clearedInput = h<HTMLInputElement>('input', { type: 'checkbox', class: 'checkbox', checked: true });
  const errorSlot = h('div.form-error-slot');

  // Whether the envelope can actually take this hit, said before the money
  // moves rather than after — an overspent envelope is much easier to prevent.
  const available = bill.categoryId
    ? categoryRow(monthSummary(state, monthOf(dueDate)), bill.categoryId).available
    : 0;
  const category = state.categories.find((c) => c.id === bill.categoryId) ?? null;

  const body = h(
    'form.form',
    { onsubmit: (event: Event) => event.preventDefault() },
    h(
      'div.pay-summary',
      null,
      h('div.pay-row', null, h('span', { text: 'Due' }), h('strong', { text: formatDate(dueDate, money().locale) })),
      h(
        'div.pay-row',
        null,
        h('span', { text: bill.variable ? 'Usually' : 'Amount' }),
        h('strong', { text: formatMoney(expected, money()) }),
      ),
      category
        ? h(
            'div.pay-row',
            null,
            h('span', { text: `${category.name} envelope` }),
            available >= expected
              ? statusPill('good', `${formatMoney(available, money())} available`, { size: 'sm' })
              : statusPill('warning', `${formatMoney(available, money())} available`, { size: 'sm' }),
          )
        : null,
    ),
    h('div.form-grid', null, field('Amount paid', amountInput, { id: 'billpay-amount' }), field('Date paid', dateInput, { id: 'billpay-date' })),
    field('Paid from', fromSelect, { id: 'billpay-from' }),
    field('Memo', memoInput, { id: 'billpay-memo' }),
    h('label.check-row', null, clearedInput, h('span', { text: 'Cleared — this has settled at the bank' })),
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
      if (!fromSelect.value) {
        mount(errorSlot, h('p.form-error', null, icon('alert', { size: 15 }), h('span', { text: 'Pick an account to pay from.' })));
        return;
      }
      commit(
        (s) =>
          actions.payBill(s, {
            billId: bill.id,
            dueDate,
            date: dateInput.value || todayISO(),
            amount,
            accountId: fromSelect.value,
            memo: memoInput.value.trim(),
            cleared: clearedInput.checked,
          }),
        { label: 'bill payment' },
      );
      closeModal();
      undoToast(`${bill.name} paid — ${formatMoney(amount, money())}.`);
    },
  });

  openModal({
    title: `Pay ${bill.name}`,
    body,
    footer: [
      h('button.btn.btn-ghost', {
        type: 'button',
        text: 'Skip this one',
        title: 'Nothing is owed this time',
        onclick: () => {
          commit((s) => actions.skipBillOccurrence(s, bill.id, dueDate), { label: 'skip bill' });
          closeModal();
          undoToast(`${bill.name} skipped for this cycle.`);
        },
      }),
      h('div.foot-spacer'),
      h('button.btn', { type: 'button', text: 'Cancel', onclick: closeModal }),
      submit,
    ],
  });
}
