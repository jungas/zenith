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
import { findMatchingPlan, planFromStatementRow } from '../core/installments.ts';
import type { DateOrder, ParsedStatement } from '../core/statement.ts';
import type { TextLine } from '../core/pdf/read.ts';
import {
  applyImport, buildDrafts, importTotals, matchOwnAccount, reconcileWithStatement,
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

/**
 * Which account a statement not yet chosen will import into.
 *
 * Held outside the view for the same reason `session` is: a re-render must
 * not forget it. It is set before there is anything to review, which is the
 * point — a card is a decision someone can make without the statement in
 * hand, and asking for the PDF only once that decision is made means a
 * password prompt and a parse never happen for the wrong account.
 */
let pendingAccountId: string | null = null;

/**
 * The `?account=` this view last saw, so a re-render triggered by a `commit`
 * elsewhere in the app — which calls back in with the same URL and therefore
 * the same param — can be told apart from an actual navigation to a new one.
 * Only the latter should override a choice made by hand: a card's "Import
 * statement" link is a fresh instruction ("this one"), but a stray re-render
 * mid-review is not, and must not silently swap the account back.
 */
let lastRouteAccountId: string | undefined;

export function importView({ accountId }: { accountId?: string } = {}): HTMLElement {
  const state = getState();
  if (accountId !== lastRouteAccountId) {
    lastRouteAccountId = accountId;
    if (accountId && state.accounts.some((a) => a.id === accountId && !a.archived)) {
      pendingAccountId = accountId;
    }
  }

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

    // Chosen before the file was even picked — see `pendingAccountId`. The
    // picker will not hand a file to `handleFile` without one set.
    const accountId = pendingAccountId ?? '';

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

    // A deleted or archived account cannot stay chosen.
    if (pendingAccountId && !state.accounts.some((a) => a.id === pendingAccountId && !a.archived)) {
      pendingAccountId = null;
    }
    const ready = pendingAccountId !== null;

    const accountSelect = select(
      [
        { value: '', label: 'Choose an account…' },
        ...state.accounts
          .filter((a) => !a.archived)
          .map((a) => ({ value: a.id, label: a.name, selected: a.id === pendingAccountId })),
      ],
      {
        onchange: (event: Event) => {
          pendingAccountId = (event.target as HTMLSelectElement).value || null;
          renderPicker(message);
        },
      },
    );

    const dropZone = h(
      `div.import-drop${ready ? '' : ' is-disabled'}`,
      {
        ondragover: (event: DragEvent) => {
          if (!ready) return;
          event.preventDefault();
          dropZone.classList.add('is-over');
        },
        ondragleave: () => dropZone.classList.remove('is-over'),
        ondrop: (event: DragEvent) => {
          event.preventDefault();
          dropZone.classList.remove('is-over');
          if (!ready) return;
          const file = event.dataTransfer?.files?.[0];
          if (file) void handleFile(file);
        },
      },
      h('div.import-drop-icon', null, icon('upload', { size: 26 })),
      h('p.import-drop-title', { text: ready ? 'Drop a statement here' : 'Choose an account above first' }),
      h('p.import-drop-hint', {
        text: ready ? 'or choose the PDF your bank emailed you' : 'Zenith needs to know which account these transactions belong to before it can read the file.',
      }),
      h(
        'button.btn.btn-primary',
        { type: 'button', disabled: !ready, onclick: () => fileInput.click() },
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
      h(
        'section.card.block',
        null,
        field('Import into', accountSelect, { id: 'import-account-pick', hint: 'Pick the card or account this statement belongs to.' }),
      ),
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
              text: `${totals.unassignedPayments} row${totals.unassignedPayments === 1 ? '' : 's'} still need the account on the other side, and will be skipped.`,
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
          // A correction made here is worth remembering if "Start over" is
          // pressed next — it should not undo a fix just made.
          pendingAccountId = session.accountId || null;
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
      installmentOffer(session),
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
 * Offer to track the instalment plans this statement mentions.
 *
 * A row reading `INSTALLMENT - APPLIANCE 3/12` says two things: ₱4,166.60 was
 * billed this month, and it will be billed nine more times. The first is the
 * transaction being imported; the second is invisible unless someone writes it
 * down, and it is the half that lets you plan.
 *
 * The row itself still imports as an ordinary charge — the plan records what is
 * still to come, and creates nothing.
 */
function installmentOffer(session: Session): HTMLElement | null {
  const state = getState();
  const accountId = session.accountId;
  if (!isCredit(state.accounts.find((a) => a.id === accountId))) return null;

  const candidates = session.drafts
    .filter((draft) => draft.include && draft.amount < 0)
    .map((draft) =>
      planFromStatementRow(
        { description: draft.payee, amount: Math.abs(draft.amount), date: draft.date },
        accountId,
      ),
    )
    .filter((plan): plan is NonNullable<typeof plan> => plan !== null)
    .filter((plan) => !findMatchingPlan(state, plan));

  if (!candidates.length) return null;

  return h(
    'section.card.block',
    null,
    h('h3.card-title', {
      text: candidates.length === 1 ? 'One row is an instalment' : `${candidates.length} rows are instalments`,
    }),
    h('p.card-text', {
      text: 'These look like monthly instalments of a larger purchase. Tracking them records what is still to be billed, so future months are not a surprise. The charges themselves import either way.',
    }),
    h(
      'ul.mini-list',
      { role: 'list' },
      candidates.map((plan) =>
        h(
          'li.mini-row',
          null,
          h('span.mini-name', { text: plan.description }),
          h('span.mini-meta', { text: `${plan.months} months from ${plan.startMonth}` }),
        ),
      ),
    ),
    h(
      'div.button-row',
      null,
      h(
        'button.btn',
        {
          type: 'button',
          onclick: () => {
            commit(
              (current) =>
                candidates.reduce(
                  (next, plan) =>
                    findMatchingPlan(next, plan) ? next : actions.addInstallment(next, plan),
                  current,
                ),
              { label: 'track plans' },
            );
            toast(
              `${candidates.length} instalment plan${candidates.length === 1 ? '' : 's'} tracked.`,
              { tone: 'success', action: { label: 'Undo', onClick: () => undo() } },
            );
          },
        },
        icon('calendar', { size: 16 }),
        h('span', {
          text: candidates.length === 1 ? 'Track this plan' : `Track all ${candidates.length}`,
        }),
      ),
    ),
  );
}

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
    title: 'When the money moved — the date the budget uses',
    onchange: (event: Event) => {
      draft.date = (event.target as HTMLInputElement).value || todayISO();
    },
  });

  /*
   * The date the bank posted this row. It is stored with the transaction, and it
   * is what stops this statement's rows arriving twice if it is ever imported
   * again — see `findDuplicate`. Editable, because a statement that prints only
   * one date leaves this equal to the date above, and a corrected posting date
   * is worth more to the next import than a guessed one.
   */
  const postedField = h<HTMLInputElement>('input.input.import-date', {
    type: 'date',
    value: draft.postedDate ?? '',
    'aria-label': 'Posted date',
    title: 'The date the bank posted it. Kept so this row is recognised if the statement is imported again.',
    onchange: (event: Event) => {
      draft.postedDate = (event.target as HTMLInputElement).value || null;
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

  const isTransfer = draft.role === 'transfer';
  // Named when the row itself is why this is a move, so the note can say so.
  // Nothing is claimed when the person picked the other side by hand: they know
  // why it is a transfer better than a note does.
  const own = matchOwnAccount(state, draft.payee, session.accountId);
  const recognised = own && own.id === draft.fromAccountId ? own.name : null;

  /*
   * A transfer or a card payment needs the account on the other side. Both are
   * uncategorised by nature: the money is still yours, so no envelope changes.
   */
  const secondary = isPayment || isTransfer
    ? select(
        [
          { value: '', label: isPayment ? 'Paid from…' : draft.amount < 0 ? 'Moved to…' : 'Moved from…' },
          ...state.accounts
            .filter((a) => !a.archived && a.id !== session.accountId && (!isPayment || !isCredit(a)))
            .map((a) => ({ value: a.id, label: a.name, selected: a.id === draft.fromAccountId })),
        ],
        {
          class: 'input import-category',
          'aria-label': isPayment ? 'Paid from' : 'Other account',
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

  /*
   * Nothing on a statement distinguishes money spent from money moved to your
   * own other account, so this is the one classification a person has to make.
   * It matters: recorded as spending, a transfer overstates what you spent and,
   * having no envelope, comes out of Ready to assign.
   */
  const transferToggle = draft.role === 'payment'
    ? null
    : h('button', {
        type: 'button',
        class: `import-direction${isTransfer ? ' is-in' : ''}`,
        title: isTransfer
          ? 'Recorded as moving money between your own accounts — press to record it as spending'
          : 'Press if this moved money between your own accounts rather than spending it',
        onclick: () => {
          if (isTransfer) {
            const card = isCredit(state.accounts.find((a) => a.id === session.accountId));
            draft.role = draft.amount < 0 ? (card ? 'charge' : 'expense') : card ? 'refund' : 'income';
            draft.fromAccountId = null;
            if (draft.role === 'income') draft.categoryId = null;
          } else {
            draft.role = 'transfer';
            draft.categoryId = null;
            // If the row names one of your own accounts, that is a better guess
            // at the other side than the largest cash account.
            draft.fromAccountId =
              matchOwnAccount(state, draft.payee, session.accountId)?.id
              ?? defaultPaymentSource(state, session.accountId);
          }
          repaint();
        },
      }, icon('transfer', { size: 14 }), h('span', { text: isTransfer ? 'Transfer' : 'Move' }));

  return h(
    'li',
    { class: `import-row${draft.include ? '' : ' is-excluded'}${draft.duplicateOf ? ' is-duplicate' : ''}` },
    h('label.import-check', null, includeBox),
    h('div.import-fields', null,
      h('div.import-line', null,
        dateField,
        h('label.import-posted', null,
          h('span', { text: 'Posted' }),
          postedField,
        ),
        payeeField,
      ),
      h('div.import-line', null,
        secondary,
        h('div.import-amount-group', null, transferToggle, directionButton, amountField),
      ),
      draft.duplicateOf
        ? h('p.import-note', null,
            icon('info', { size: 14 }),
            h('span', { text: duplicateNote(state, draft, money) }),
          )
        : null,
      (isPayment || isTransfer) && !draft.fromAccountId
        ? h('p.import-note', null,
            icon('warn', { size: 14 }),
            h('span', {
              text: isPayment
                ? 'A payment to a card moves real money, so Zenith needs to know which account it left.'
                : 'Moving money needs both ends. Pick the account on the other side, or switch this back to spending.',
            }),
          )
        : null,
      isTransfer
        ? h('p.import-note', null,
            icon('info', { size: 14 }),
            h('span', {
              text: recognised
                ? `This row names ${recognised}, one of your own accounts, so it is read as moving money rather than spending it: no category, and no envelope changes. Switch it back if it was spending.`
                : 'Moving money between your own accounts is not spending, so it has no category and no envelope changes.',
            }),
          )
        : null,
    ),
  );
}

function duplicateNote(state: AppState, draft: ImportDraft, money: Money): string {
  const existing = state.transactions.find((t) => t.id === draft.duplicateOf);
  if (!existing) return 'Looks like a transaction you already have.';
  const what = `${existing.payee || 'transaction'} on ${formatDate(existing.date, money.locale)} for ${formatMoney(existing.amount, money)}`;
  // A posting date agreeing exactly is the bank saying these are one row, so it
  // is reported as the fact it is rather than as a resemblance.
  if (draft.duplicateBy === 'posted' && draft.postedDate) {
    return `Already in your ledger, posted the same day (${formatDate(draft.postedDate, money.locale)}): ${what}.`;
  }
  return `Already in your ledger: ${what}.`;
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
