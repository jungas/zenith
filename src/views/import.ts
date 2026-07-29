/**
 * Import a statement — the screen that turns a PDF from the bank into ledger
 * entries.
 *
 * The shape of the screen follows the shape of the risk. Reading a statement is
 * guesswork (see `core/statement.ts`), so nothing is written until every row has
 * been seen: the parse produces *proposals*, the table below is the review, and
 * the ledger only changes when the button at the bottom is pressed. Anything
 * that already looks like an existing transaction arrives unticked.
 */

import { h, append, mount } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import type { IconName } from '../ui/icons.ts';
import { sectionHeader, statusPill, field, select, input, moneyInput, emptyState } from '../ui/components.ts';
import { askForPassword } from '../ui/password.ts';
import { openAccountForm } from '../ui/forms.ts';
import { toast } from '../ui/toast.ts';
import { formatMoney, parseMoney, centsToInput } from '../core/money.ts';
import { formatDate, todayISO } from '../core/dates.ts';
import { isCredit } from '../core/model.ts';
import { readPdfText, PdfPasswordError, PdfReadError, PdfUnsupportedEncryptionError, pdfIsEncrypted, looksLikePdf } from '../core/pdf/read.ts';
import { parseStatement } from '../core/statement.ts';
import type { DateOrder, ParsedStatement } from '../core/statement.ts';
import type { TextLine } from '../core/pdf/read.ts';
import {
  applyImport, buildDrafts, importTotals, reconcileWithStatement, suggestAccountId,
} from '../core/statement-import.ts';
import type { ImportDraft } from '../core/statement-import.ts';
import * as actions from '../core/actions.ts';
import { commit, getState, moneyOpts, undo } from '../store.ts';
import { navigate } from '../router.ts';
import type { AppState, MoneyOptions } from '../core/model.ts';

type Money = Required<Pick<MoneyOptions, 'currency' | 'locale'>>;

interface Session {
  fileName: string;
  /** Kept so a change of date order can re-run the parse without re-reading the PDF. */
  lines: TextLine[];
  parsed: ParsedStatement;
  drafts: ImportDraft[];
  accountId: string;
  memo: string;
}

/**
 * The in-progress import, held outside the view function on purpose.
 *
 * Any `commit` re-renders the current route from scratch, so a session living
 * inside `importView` would be destroyed by the very buttons on this screen —
 * correcting a starting balance would throw away the review it was offered
 * from. Reviewing a statement is minutes of work; it outlives a repaint.
 */
let session: Session | null = null;

export function importView(): HTMLElement {
  const root = h('div.view.view-import');
  const stage = h('div.import-stage');

  append(
    root,
    sectionHeader('Import a statement', {
      subtitle: 'Read a PDF statement and turn it into transactions',
    }),
    stage,
  );

  const fileInput = h<HTMLInputElement>('input', {
    type: 'file',
    accept: 'application/pdf,.pdf',
    style: { display: 'none' },
    onchange: (event: Event) => {
      const target = event.target as HTMLInputElement;
      const file = target.files?.[0];
      target.value = '';
      if (file) void handleFile(file);
    },
  });

  /* ── Reading the file ─────────────────────────────────────────────── */

  /**
   * Read a chosen file, asking for its password for as long as it takes.
   *
   * The loop is the point: an encrypted statement stops here until the right
   * password arrives or the person gives up. There is no path that carries on
   * without one, because there is nothing readable to carry on with.
   */
  async function handleFile(file: File): Promise<void> {
    renderBusy(`Opening ${file.name}…`);
    const bytes = new Uint8Array(await file.arrayBuffer());

    if (!looksLikePdf(bytes)) {
      renderPicker('That file is not a PDF. Statements have to be the PDF your bank sent, not a screenshot or a scan saved as an image.');
      return;
    }

    let password = '';
    let error: string | null = null;

    // A file can be encrypted and still open with an empty password, which is
    // how "no copying or printing" restrictions are usually applied. Asking for
    // a password we do not need would be a prompt with no possible answer.
    if (pdfIsEncrypted(bytes) && !opensWithoutPassword(bytes)) {
      const issuer = null; // the statement cannot be read yet, so nothing to go on
      for (;;) {
        const entered = await askForPassword({ fileName: file.name, error, issuer });
        if (entered === null) {
          renderPicker(null);
          return;
        }
        password = entered;
        renderBusy(`Unlocking ${file.name}…`);
        // Yield a frame so the busy state actually paints before the key
        // derivation — revision 6 deliberately takes a moment.
        await nextFrame();
        try {
          readPdfText(bytes, password);
          break;
        } catch (thrown) {
          if (thrown instanceof PdfPasswordError) {
            error = thrown.message;
            continue;
          }
          // Anything else is not a password problem; report it as itself.
          renderPicker(messageFor(thrown));
          return;
        }
      }
    }

    renderBusy(`Reading ${file.name}…`);
    await nextFrame();

    try {
      const text = readPdfText(bytes, password);
      const state = getState();
      const parsed = parseStatement(text.lines, {
        dateOrder: state.settings.locale === 'en-US' ? 'mdy' : 'dmy',
      });
      startReview(file.name, text.lines, parsed);
    } catch (thrown) {
      renderPicker(messageFor(thrown));
    }
  }

  function startReview(fileName: string, lines: TextLine[], parsed: ParsedStatement): void {
    const state = getState();
    if (!parsed.rows.length) {
      renderPicker(
        'No transactions could be read from that statement. It may be a scanned image rather than a text PDF, or a layout Zenith has not met before.',
      );
      return;
    }

    const accountId =
      suggestAccountId(state, {
        accountHint: parsed.summary.accountHint,
        issuer: parsed.summary.issuer,
        kind: parsed.kind,
      }) ?? '';

    const memo = statementMemo(parsed);
    session = {
      fileName,
      lines,
      parsed,
      accountId,
      memo,
      drafts: buildDrafts(state, parsed.rows, {
        accountId,
        memo,
        paymentSourceId: defaultPaymentSource(state, accountId),
      }),
    };
    renderReview();
  }

  /* ── Stages ───────────────────────────────────────────────────────── */

  function renderBusy(message: string): void {
    mount(
      stage,
      h(
        'section.card.block.import-busy',
        null,
        h('div.import-spinner', { 'aria-hidden': 'true' }),
        h('p.card-text', { text: message }),
      ),
    );
  }

  function renderPicker(message: string | null): void {
    const state = getState();
    if (!state.accounts.length) {
      mount(
        stage,
        emptyState({
          title: 'Add an account first',
          message: 'A statement has to be imported into an account, so Zenith needs one to put these transactions in.',
          iconName: 'wallet',
          action: h('button.btn.btn-primary', {
            type: 'button',
            text: 'Add an account',
            onclick: () => openAccountForm(),
          }),
        }),
      );
      return;
    }

    const dropZone = h(
      'div.import-drop',
      {
        ondragover: (event: DragEvent) => {
          event.preventDefault();
          dropZone.classList.add('is-over');
        },
        ondragleave: () => dropZone.classList.remove('is-over'),
        ondrop: (event: DragEvent) => {
          event.preventDefault();
          dropZone.classList.remove('is-over');
          const file = event.dataTransfer?.files?.[0];
          if (file) void handleFile(file);
        },
      },
      h('div.import-drop-icon', null, icon('upload', { size: 26 })),
      h('p.import-drop-title', { text: 'Drop a statement here' }),
      h('p.import-drop-hint', { text: 'or choose the PDF your bank emailed you' }),
      h(
        'button.btn.btn-primary',
        { type: 'button', onclick: () => fileInput.click() },
        icon('upload', { size: 16 }),
        h('span', { text: 'Choose PDF' }),
      ),
      fileInput,
    );

    mount(
      stage,
      message
        ? h('div.import-alert', null, icon('alert', { size: 16 }), h('p', { text: message }))
        : null,
      h('section.card.block', null, dropZone),
      h(
        'section.card.block',
        null,
        h('h3.card-title', { text: 'What Zenith does with it' }),
        h('ul.import-facts', { role: 'list' },
          fact('lock', 'Password-protected statements are expected. Zenith asks for the password, uses it to open the file, and never stores it.'),
          fact('phone', 'The PDF is read on this device. Nothing is uploaded — the app makes no network calls at all.'),
          fact('ledger', 'Nothing is saved until you review the rows and press Import. Anything matching a transaction you already have arrives unticked.'),
          fact('card', 'Charges on a credit card fund its payment envelope, exactly as if you had typed them in.'),
        ),
      ),
    );
  }

  function renderReview(): void {
    if (!session) return;
    const state = getState();
    const money = moneyOpts(state);
    const { parsed } = session;

    const rowsHost = h('ul.import-rows', { role: 'list' });
    const totalsHost = h('div.import-totals');
    const checkHost = h('div');

    const refreshTotals = (): void => {
      if (!session) return;
      const totals = importTotals(session.drafts);
      mount(
        totalsHost,
        h('div.import-totals-figures', null,
          h('span', null, h('span.muted', { text: 'selected ' }), h('strong', { text: String(totals.selected) })),
          h('span', null, h('span.muted', { text: 'in ' }), h('strong', { text: formatMoney(totals.inflow, money) })),
          h('span', null, h('span.muted', { text: 'out ' }), h('strong', { text: formatMoney(totals.outflow, money) })),
        ),
        totals.unassignedPayments
          ? h('p.import-warn', null, icon('warn', { size: 15 }), h('span', {
              text: `${totals.unassignedPayments} card payment${totals.unassignedPayments === 1 ? '' : 's'} still need an account to pay from, and will be skipped.`,
            }))
          : null,
      );
      importButton.disabled = totals.selected === 0;
      mount(checkHost, statementCheck(session as Session, money));
    };

    const paintRows = (): void => {
      if (!session) return;
      mount(
        rowsHost,
        session.drafts.map((draft) => draftRow(draft, session as Session, money, refreshTotals, paintRows)),
      );
      refreshTotals();
    };

    const importButton = h<HTMLButtonElement>('button.btn.btn-primary', {
      type: 'button',
      onclick: () => runImport(),
    }, icon('download', { size: 16 }), h('span', { text: 'Import selected' }));

    /* Which account these belong to. */
    const accountSelect = select(
      state.accounts
        .filter((a) => !a.archived)
        .map((a) => ({ value: a.id, label: a.name, selected: a.id === session?.accountId })),
      {
        onchange: (event: Event) => {
          if (!session) return;
          session.accountId = (event.target as HTMLSelectElement).value;
          // Roles, duplicate flags and category guesses all depend on which
          // account this is, so the drafts are rebuilt rather than patched.
          session.drafts = buildDrafts(getState(), session.parsed.rows, {
            accountId: session.accountId,
            memo: session.memo,
            paymentSourceId: defaultPaymentSource(getState(), session.accountId),
          });
          paintRows();
        },
      },
    );

    const memoInput = input({
      value: session.memo,
      placeholder: 'Added to every imported transaction',
      oninput: (event: Event) => {
        if (!session) return;
        session.memo = (event.target as HTMLInputElement).value;
        for (const draft of session.drafts) draft.memo = session.memo;
      },
    });

    mount(
      stage,
      summaryCard(session, money),
      checkHost,
      h(
        'section.card.block',
        null,
        h('div.form-grid', null,
          field('Import into', accountSelect, {
            id: 'import-account',
            hint: parsed.summary.accountHint
              ? `The statement ends in ${parsed.summary.accountHint}.`
              : undefined,
          }),
          field('Memo', memoInput, { id: 'import-memo' }),
        ),
        parsed.hasAmbiguousDates && !parsed.dateOrderCertain ? dateOrderRow(session, paintRows) : null,
      ),
      h(
        'section.card.block.import-list',
        null,
        h('div.import-list-head', null,
          h('h3.card-title', { text: `${parsed.rows.length} rows found` }),
          h('div.import-bulk', null,
            h('button.btn.btn-sm', { type: 'button', text: 'Select all', onclick: () => setAll(true) }),
            h('button.btn.btn-sm', { type: 'button', text: 'Select none', onclick: () => setAll(false) }),
          ),
        ),
        rowsHost,
      ),
      h('div.import-footer', null,
        totalsHost,
        h('div.import-footer-actions', null,
          h('button.btn', { type: 'button', text: 'Start over', onclick: () => { session = null; renderPicker(null); } }),
          importButton,
        ),
      ),
    );

    paintRows();

    function setAll(include: boolean): void {
      if (!session) return;
      for (const draft of session.drafts) draft.include = include;
      paintRows();
    }

    function runImport(): void {
      if (!session) return;
      const { drafts, accountId } = session;
      const totals = importTotals(drafts);
      if (!totals.selected) return;
      const account = getState().accounts.find((a) => a.id === accountId);
      commit((current) => applyImport(current, drafts, accountId), { label: 'import statement' });
      toast(
        `${totals.selected} transaction${totals.selected === 1 ? '' : 's'} imported into ${account?.name ?? 'your account'}.`,
        { tone: 'success', action: { label: 'Undo', onClick: () => undo() } },
      );
      session = null;
      navigate('#/transactions');
    }
  }

  // A re-render lands here again: pick up where the session left off.
  if (session) renderReview();
  else renderPicker(null);
  return root;
}

/* ── Pieces ─────────────────────────────────────────────────────────── */

/**
 * Does the result of this import match what the statement says is owed?
 *
 * The common way it does not: adding a card asks for the balance owed *today*,
 * and taking that figure from the statement you are about to import means the
 * starting balance already contains every row on it. Importing then counts the
 * same spending twice. That is worth catching here rather than leaving someone
 * to notice a wrong balance later and not know why.
 */
function statementCheck(session: Session, money: Money): HTMLElement | null {
  const state = getState();
  const check = reconcileWithStatement(state, session.drafts, session.accountId, {
    totalDue: session.parsed.summary.totalDue,
    statementDate: session.parsed.summary.statementDate,
  });
  if (!check) return null;

  const account = state.accounts.find((a) => a.id === session.accountId);
  const when = session.parsed.summary.statementDate;

  if (check.agrees) {
    return h(
      'section.card.block',
      null,
      h('h3.card-title', { text: 'Checked against the statement' }),
      h(
        'p.card-text',
        null,
        statusPill('good', 'Balances match', { size: 'sm' }),
        h('span', {
          text: `Importing these rows leaves ${account?.name ?? 'this card'} owing ${formatMoney(check.projected, money)} — exactly what the statement says.`,
        }),
      ),
    );
  }

  return h(
    'section.card.block',
    null,
    h('h3.card-title', { text: 'Checked against the statement' }),
    h(
      'p.card-text',
      null,
      statusPill('warning', `${formatMoney(Math.abs(check.difference), money)} out`, { size: 'sm' }),
      h('span', {
        text: `Importing these rows leaves ${account?.name ?? 'this card'} owing ${formatMoney(check.projected, money)}${when ? ` as of ${formatDate(when, money.locale)}` : ''}, but the statement says ${formatMoney(check.stated, money)}.`,
      }),
    ),
    check.looksLikeDoubleCount
      ? h(
          'div.inline-note',
          null,
          icon('info', { size: 16 }),
          h('p', {
            text: `The gap is exactly what these rows add up to, so the card's starting balance most likely already includes them. If you entered what you owed today, that figure was the result of this statement — importing it as well counts the same spending twice.`,
          }),
        )
      : h(
          'div.inline-note',
          null,
          icon('info', { size: 16 }),
          h('p', {
            text: 'The difference is whatever this statement does not explain — an earlier balance, or transactions already recorded by hand.',
          }),
        ),
    h(
      'div.button-row',
      null,
      h(
        'button.btn',
        {
          type: 'button',
          onclick: () => {
            const accountId = session.accountId;
            const opening = check.suggestedOpeningBalance;
            commit((current) => actions.updateAccount(current, accountId, { openingBalance: opening }), {
              label: 'starting balance',
            });
            // No repaint here: `commit` re-renders the route, which rebuilds
            // this panel from the corrected state.
            toast(
              `Starting balance set to ${formatMoney(Math.abs(opening), money)}.`,
              { tone: 'success', action: { label: 'Undo', onClick: () => undo() } },
            );
          },
        },
        icon('edit', { size: 16 }),
        h('span', {
          text: `Set the starting balance to ${formatMoney(Math.abs(check.suggestedOpeningBalance), money)}`,
        }),
      ),
    ),
    h('p.import-note', null, icon('info', { size: 14 }), h('span', {
      text: 'Or leave it — nothing here is wrong if you meant to keep both figures.',
    })),
  );
}

function fact(iconName: IconName, text: string): HTMLElement {
  return h('li.import-fact', null, icon(iconName, { size: 16 }), h('span', { text }));
}

function summaryCard(session: Session, money: Money): HTMLElement {
  const { summary, kind } = session.parsed;
  const entries: Array<[string, string]> = [];
  if (summary.issuer) entries.push(['Bank', summary.issuer]);
  if (summary.accountHint) entries.push(['Account ends in', summary.accountHint]);
  if (summary.periodFrom && summary.periodTo) {
    entries.push([
      'Period',
      `${formatDate(summary.periodFrom, money.locale)} – ${formatDate(summary.periodTo, money.locale)}`,
    ]);
  }
  if (summary.statementDate) entries.push(['Statement date', formatDate(summary.statementDate, money.locale)]);
  if (summary.dueDate) entries.push(['Payment due', formatDate(summary.dueDate, money.locale)]);
  if (summary.totalDue != null) entries.push(['Total amount due', formatMoney(summary.totalDue, money)]);
  if (summary.minimumDue != null) entries.push(['Minimum due', formatMoney(summary.minimumDue, money)]);

  return h(
    'section.card.block',
    null,
    h('div.import-file', null,
      icon('ledger', { size: 18 }),
      h('div', null,
        h('p.import-file-name', { text: session.fileName }),
        h('p.import-file-meta', {
          text: kind === 'card' ? 'Read as a credit card statement' : kind === 'bank' ? 'Read as a bank account statement' : 'Statement type not certain',
        }),
      ),
      summary.currency && summary.currency !== money.currency
        ? statusPill('warning', `Statement is in ${summary.currency}`, { size: 'sm' })
        : null,
    ),
    entries.length
      ? h('dl.about-list.block', null,
          entries.map(([label, value]) =>
            h('div.about-row', null, h('dt', { text: label }), h('dd', { text: value })),
          ),
        )
      : null,
  );
}

/**
 * The day/month switch.
 *
 * Only offered when the statement itself did not settle the question — if some
 * date in it has a day above the twelfth, the order is known and inviting
 * someone to change it would only let them make it wrong.
 */
function dateOrderRow(session: Session, repaint: () => void): HTMLElement {
  const options: Array<{ value: DateOrder; label: string }> = [
    { value: 'dmy', label: 'Day first (18/06/2026)' },
    { value: 'mdy', label: 'Month first (06/18/2026)' },
  ];
  return h(
    'div.block',
    null,
    field(
      'Dates are written',
      select(
        options.map((option) => ({ ...option, selected: option.value === session.parsed.dateOrder })),
        {
          onchange: (event: Event) => {
            const order = (event.target as HTMLSelectElement).value as DateOrder;
            session.parsed = parseStatement(session.lines, { dateOrder: order });
            session.drafts = buildDrafts(getState(), session.parsed.rows, {
              accountId: session.accountId,
              memo: session.memo,
              paymentSourceId: defaultPaymentSource(getState(), session.accountId),
            });
            repaint();
          },
        },
      ),
      {
        id: 'import-date-order',
        hint: 'This statement never writes a day above the twelfth, so the order cannot be worked out from it. Check a row against the statement.',
      },
    ),
  );
}

function draftRow(
  draft: ImportDraft,
  session: Session,
  money: Money,
  refreshTotals: () => void,
  repaint: () => void,
): HTMLElement {
  const state = getState();
  const isPayment = draft.role === 'payment';
  const outgoing = draft.amount < 0;

  const includeBox = h<HTMLInputElement>('input', {
    type: 'checkbox',
    class: 'checkbox',
    checked: draft.include,
    'aria-label': `Import ${draft.payee}`,
    onchange: (event: Event) => {
      draft.include = (event.target as HTMLInputElement).checked;
      refreshTotals();
    },
  });

  const dateField = h<HTMLInputElement>('input.input.import-date', {
    type: 'date',
    value: draft.date,
    'aria-label': 'Date',
    onchange: (event: Event) => {
      draft.date = (event.target as HTMLInputElement).value || todayISO();
    },
  });

  const payeeField = input({
    value: draft.payee,
    'aria-label': 'Payee',
    class: 'input import-payee',
    oninput: (event: Event) => {
      draft.payee = (event.target as HTMLInputElement).value;
    },
  });

  const amountField = moneyInput({
    value: centsToInput(draft.amount),
    class: 'input input-money import-amount',
    'aria-label': 'Amount',
    onchange: (event: Event) => {
      const magnitude = Math.abs(parseMoney((event.target as HTMLInputElement).value));
      draft.amount = draft.amount < 0 ? -magnitude : magnitude;
      refreshTotals();
    },
  });

  const directionButton = h('button', {
    type: 'button',
    class: `import-direction ${outgoing ? 'is-out' : 'is-in'}`,
    title: outgoing ? 'Money out — press to switch to money in' : 'Money in — press to switch to money out',
    onclick: () => {
      draft.amount = -draft.amount;
      // The role follows the direction: flipping a charge on a card makes it a
      // refund, and flipping spending on a bank account makes it income.
      const account = state.accounts.find((a) => a.id === session.accountId);
      if (isCredit(account)) draft.role = draft.amount < 0 ? 'charge' : 'refund';
      else draft.role = draft.amount < 0 ? 'expense' : 'income';
      if (draft.role === 'income') draft.categoryId = null;
      repaint();
    },
  }, icon(outgoing ? 'arrowUp' : 'arrowDown', { size: 14 }), h('span', { text: outgoing ? 'Out' : 'In' }));

  /* A payment to a card is a transfer, so it needs a source account. */
  const secondary = isPayment
    ? select(
        [
          { value: '', label: 'Paid from…' },
          ...state.accounts
            .filter((a) => !a.archived && !isCredit(a))
            .map((a) => ({ value: a.id, label: a.name, selected: a.id === draft.fromAccountId })),
        ],
        {
          class: 'input import-category',
          'aria-label': 'Paid from',
          onchange: (event: Event) => {
            draft.fromAccountId = (event.target as HTMLSelectElement).value || null;
            refreshTotals();
          },
        },
      )
    : draft.role === 'income'
      ? h('span.import-role-note', { text: 'Income — not budgeted to a category' })
      : select(
          [
            { value: '', label: 'Uncategorised' },
            ...state.categories
              .filter((c) => !c.archived && c.kind === 'spending')
              .map((c) => ({ value: c.id, label: c.name, selected: c.id === draft.categoryId })),
          ],
          {
            class: 'input import-category',
            'aria-label': 'Category',
            onchange: (event: Event) => {
              draft.categoryId = (event.target as HTMLSelectElement).value || null;
            },
          },
        );

  return h(
    'li',
    { class: `import-row${draft.include ? '' : ' is-excluded'}${draft.duplicateOf ? ' is-duplicate' : ''}` },
    h('label.import-check', null, includeBox),
    h('div.import-fields', null,
      h('div.import-line', null, dateField, payeeField),
      h('div.import-line', null,
        secondary,
        h('div.import-amount-group', null, directionButton, amountField),
      ),
      draft.duplicateOf
        ? h('p.import-note', null,
            icon('info', { size: 14 }),
            h('span', { text: duplicateNote(state, draft, money) }),
          )
        : null,
      isPayment && !draft.fromAccountId
        ? h('p.import-note', null,
            icon('warn', { size: 14 }),
            h('span', { text: 'A payment to a card moves real money, so Zenith needs to know which account it left.' }),
          )
        : null,
    ),
  );
}

function duplicateNote(state: AppState, draft: ImportDraft, money: Money): string {
  const existing = state.transactions.find((t) => t.id === draft.duplicateOf);
  if (!existing) return 'Looks like a transaction you already have.';
  return `Already in your ledger: ${existing.payee || 'transaction'} on ${formatDate(existing.date, money.locale)} for ${formatMoney(existing.amount, money)}.`;
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function statementMemo(parsed: ParsedStatement): string {
  const issuer = parsed.summary.issuer;
  const when = parsed.summary.statementDate ?? parsed.summary.periodTo;
  if (issuer && when) return `${issuer} statement ${when}`;
  if (issuer) return `${issuer} statement`;
  return 'Imported from statement';
}

/** The account a card payment most likely came from: the largest cash account. */
function defaultPaymentSource(state: AppState, accountId: string): string | null {
  const candidates = state.accounts.filter(
    (a) => !a.archived && !isCredit(a) && a.id !== accountId,
  );
  const preferred = candidates.find((a) => a.type === 'checking') ?? candidates[0];
  return preferred?.id ?? null;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** Does this open with no password at all? */
function opensWithoutPassword(bytes: Uint8Array): boolean {
  try {
    readPdfText(bytes, '');
    return true;
  } catch {
    return false;
  }
}

function messageFor(thrown: unknown): string {
  if (thrown instanceof PdfUnsupportedEncryptionError) return thrown.message;
  if (thrown instanceof PdfReadError) return thrown.message;
  if (thrown instanceof PdfPasswordError) return thrown.message;
  return 'That statement could not be read. If it opens in a PDF viewer, it may use a layout Zenith cannot follow yet.';
}
