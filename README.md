# Zenith

An installable, offline-first **envelope budgeting** PWA where **credit cards are
part of the budget** rather than a separate ledger you reconcile by hand.

Written in **TypeScript** under `strict`, with **no runtime dependencies** — no
framework, no bundler, no chart library. TypeScript is the only build-time
dependency.

```bash
npm install
npm start         # builds, then serves http://localhost:4173
npm test          # type-checks, then runs 221 tests
npm run typecheck # types only
npm run build     # dist/*.js + sw.js, stamped with a shell version
npm run icons     # regenerate the app icons
npm run build:artifact   # the whole app as one HTML file
```

Open Settings → **Load sample data** for a worked example: four months of
budgeting across two Philippine credit cards, a digital wallet and five
recurring bills.

---

## The idea: cards wired into the budget

Most budgeting apps treat a credit card as either "just another account" (so
spending on it never touches your budget) or as a debt tracker off to one side
(so the statement is a monthly surprise). Zenith does neither.

**Every credit card owns a payment envelope**, and three rules keep the two
halves in step:

1. **Spending on a card is budgeted like any other spending.** A $50 grocery
   charge draws $50 out of the Groceries envelope — the same as paying by debit.
2. **That same $50 moves into the card's payment envelope.** The cash never left
   your chequing account, so the budget parks it against the debt you just
   created.
3. **Paying the card spends that envelope, not a category.** The payment is a
   transfer out of chequing categorised to the card's payment envelope. The
   spending was already budgeted; paying the bill just settles up.

The consequence is the number the app leads with on every card:

> **Funded by budget: $479 of $479 — payable in full**

Coverage, not balance, is the honest measure of a credit card. A $2,000 balance
with $2,000 set aside is a payment method. A $2,000 balance with $760 set aside
is $1,240 of debt that will start accruing interest — and Zenith says so, in
those words, with the monthly interest cost attached.

### The same wiring carries loans

A loan is the mirror image of a card. A card's balance grows when you spend, and
its payment envelope fills itself as you do; a **loan's** balance only falls, and
its envelope has to be filled deliberately — month by month, before the due date.

What they share is the part that matters: paying either one moves cash out of an
asset account into a liability, so both own a payment envelope and both draw it
down when paid. Without one, cash would leave with no envelope falling to match
it, and the identity below would not hold.

Money already owed on a loan is not income, exactly as a card's opening balance
is not: it moves the account's balance without ever having been money you could
budget. Borrowed cash that actually lands in your chequing account *is* income,
because it is real money you can now assign — the loan account records the
matching liability.

A loan carries what it needs to plan around: the amount borrowed, the monthly
amortisation, the term, the due day, and the rate. From those it reports where it
is (*1 of 48 paid*), what is left to pay, and what the whole thing costs — 48 ×
₱12,000 against ₱500,000 borrowed is ₱76,000 of interest. Payments due lists it
beside the cards, because missing a loan payment costs more than missing a card's.

### The invariant

Because reserves cancel the debt that created them, the whole system collapses to
one identity, checked live in Settings → **Budget integrity**:

```
readyToAssign + Σ available  ===  Σ cash in asset accounts
```

Debt does not appear in it. That is the point: every envelope balance is
backed by real money sitting in a real account.

Two kinds of movement are **deliberately uncategorised**, and neither disturbs it:

- **Moving money between your own accounts** — chequing to savings, a wallet
  top-up. Nothing was spent, so no envelope changes and the total you hold is
  unchanged. Both legs carry no category, and should not.
- **Spending with no envelope behind it** is the opposite case: the cash has
  gone. It comes straight out of Ready to assign, which is the pool of money that
  has not been given a job yet. Leaving it out — which an earlier version did —
  made cash fall while the budget went on claiming the money was still there, and
  the integrity check would report a gap it could not explain.

  The same charge on a *credit card* moves no cash, so it does not touch Ready to
  assign; it simply grows the balance.

The one thing with no reserve behind it is debt that **predates** the budget. It
moves a card's balance without ever having been income, so it drops out of the
identity and surfaces instead as *uncovered* — the first thing the app nudges you
to fund. (`tests/budget.test.ts` pins all of this, including the pre-existing
debt case that a naïve version of the identity gets wrong.)

---

## What's in it

| Screen | What it does |
|---|---|
| **Home** | Ready-to-assign hero, cash vs card debt, per-card coverage, payments due, envelopes closest to the limit, spending mix, recent activity |
| **Budget** | Month-by-month envelope table with inline assigning, rollover, overspend flags, move-money, 3-month-average suggestions — and card payment envelopes in their own group with a **Reserved** column |
| **Cards** | Per card: balance, utilisation band, available credit, statement balance, minimum payment, statement/due dates, funding coverage, interest cost — with limits shared across cards from one bank; imports a PDF statement straight from the header |
| **Card detail** | Statement-cycle timeline, a plain-language walkthrough of the budget connection, and a payoff planner (amortisation, total interest, months saved vs paying the minimum) |
| **Bills** | Every recurring commitment: what is still to leave this month, what each one works out to per month, which envelopes are short of the dates coming, and a one-click assign to close the gap |
| **Ledger** | One searchable list across every account, filterable by account, category and month |
| **Reports** | Income vs spending, spending by category, card debt over time, savings rate — 3/6/12-month ranges |
| **Accounts** | Net worth, cash, debt, per-account balances — chequing, savings, cash, digital wallets, cards and loans |
| **Import** | Read a PDF statement — including a password-protected one — and turn it into transactions, with every row reviewable before anything is saved |
| **Settings** | Currency (26, including PHP) and locale, theme, utilisation warning threshold, payment reminders, install, JSON backup import/export, CSV export, sample data, integrity check |

Also: one-level-deep **undo** on every mutation (`u`), `n` to add a transaction,
full keyboard navigation, and a focus-trapped dialog.

### Credit-card specifics

- **Statement cycle** — `statementDay` and `dueDay` per card. Balances are
  computed *as of the last close*, so the statement figure excludes charges made
  after it. A due date of the 31st clamps to the last day of a short month
  instead of rolling into the next.
- **Shared credit limits** — a bank that issues you a second card usually does
  not extend a second limit: it hands you two cards drawing on the same one. Put
  them on a shared limit and utilisation, available credit and the portfolio
  total are all measured against the combined balance, so spending on either
  card correctly reduces what the other can use.

  **Only cards from the same bank can share a limit.** A shared limit is
  something an issuer grants across its own products, so the group carries the
  bank and every member has to match it. The rule lives in the actions rather
  than only in the form, because a form cannot guard a hand-edited backup — one
  spanning two issuers is repaired on import. Change a card's bank and it leaves
  the group; leave a group with one card and it dissolves, handing the limit back
  to the survivor rather than taking the figure with it.

  What is shared is the *limit*, not the debt: each card keeps its own balance,
  statement, due date, minimum payment and payment envelope.

- **Interest rates are quoted the way the issuer quotes them.** Philippine banks
  state a **monthly** rate — a BDO statement says 3.5%, and BSP words its own
  ceiling as "3% per month, 36% per annum" — while most other markets quote an
  annual APR. The card form takes either, with the unit beside the figure, and
  says what it works out to: *3.50% a month is 42.00% a year*. Internally `apr`
  is always annual so every projection has one basis, and changing the unit
  **relabels** what you typed rather than converting it, because someone copying
  a figure off a statement means "this number is monthly", not "rewrite my
  number".

- **Instalment plans** — ubiquitous in the Philippines: a ₱24,000 appliance
  becomes `3/12` on the statement, the third of twelve monthly billings. What
  the statement shows is the instalment; what you have committed to is the whole
  remaining run of them, and that is the part a budget needs to see coming.

  A tracked plan says what is still to be billed and when it stops — *4 of 12
  billed · ₱33,332.80 left · ends March 2027* — and the card leads with the
  figure a budget actually asks for: how much of next month's bill is already
  decided. Progress is **derived from the calendar**, not stored, so nothing has
  to be advanced by hand and nothing is wrong the month somebody forgets.

  **Tracking a plan creates no transactions.** Each month's instalment already
  reaches the ledger as an ordinary charge, typed in or imported; generating
  them here would bill every purchase twice. A plan is a schedule of what is
  still to come, not a second copy of what has happened.

  It still counts against what you can spend, though: the whole remaining run
  is held against the card's **available credit** the moment the plan is
  tracked, not one instalment at a time — the same way the issuer's own app
  shows it. A ₱22,000 balance still owed on an appliance eats ₱22,000 of
  headroom whether or not eleven more statements have printed it yet, and on a
  shared limit it takes the same bite out of every card drawing on it.

  Give it the purchase price and it will also say what the plan costs — a "0%"
  plan that bills ₱26,400 for a ₱24,000 purchase is not 0%. When the issuer
  breaks the billing itself into principal and interest, giving the interest
  portion is more precise still: the plan reports exactly how much of each
  billing pays down the price and how much is the cost of the plan, rather than
  inferring a whole-plan total from the purchase price alone.

  Every plan carries **edit** and **stop tracking** buttons on its own row.
  Removing one destroys nothing — the charges it billed are ordinary
  transactions and stay exactly where they are — so it takes no confirmation
  dialog, just `u` to undo like everything else.

- **Minimum payment** — `max(floor, rate × balance)`, never more than the balance.
- **Payoff planner** — amortises at a chosen monthly payment and reports months,
  total interest and what paying more than the minimum saves. A payment that
  does not clear the monthly interest is reported honestly as *never pays off*
  rather than looping.
- **Utilisation bands** — healthy / above target / high / very high / over limit,
  each with an icon and a word, so state never rides on colour alone.
- **Cash advances** — paying *from* a card draws on its own credit, so nothing is
  categorised and the debt simply grows.
- **Issuing bank** — a card names the bank behind it, shown on the card, in the
  accounts list and on the card detail page, so two Visas are never confused.
  The suggestions lead with Philippine issuers (BDO, BPI, Metrobank, Security
  Bank, UnionBank, RCBC, PNB, EastWest, China Bank, AUB, Landbank, HSBC
  Philippines) followed by international ones, and the field is a suggestion
  list rather than a closed set — any issuer can be typed. It is the same
  `provider` field a wallet uses: one fact, "who runs this account", rather than
  two nearly identical columns.

### Digital wallets

GCash, Maya, GrabPay, PayPal, Wise and the rest are **asset accounts**, not cards:
a wallet holds your money, so it gets no payment envelope and no credit terms.
The money in it is budgetable cash and counts towards `cashOnHand`, which means
it takes part in the same reconciliation identity as chequing and savings.

- **Provider** — a wallet carries a `provider` alongside its name (`GCash`,
  `Wise`, …), shown beside the account type. The field offers the common
  providers through a `datalist` but accepts anything.
- **Top-ups are transfers, not spending.** Moving money from chequing into a
  wallet changes where your cash sits and nothing else — no category is touched
  and the total you hold is unchanged.
- **Transfer fees are spending.** Cash-out and remittance fees are real money
  leaving, so a transfer takes an optional fee *and a category for it*. The fee
  is recorded as a third transaction — a categorised expense on the source
  account — which is what keeps the identity holding: cash falls by the fee, and
  the fee's envelope falls with it. A fee entered without a category is dropped
  rather than moved somewhere the budget cannot see it, because the alternative
  is an unexplained gap between your accounts and your envelopes.
- **Editing and deleting** treat the fee as part of the transfer: deleting the
  transfer takes the fee with it, a date change carries it along, and changing
  the transferred amount leaves the fee's own amount alone.
- **Editing a transfer edits the transfer**, not the leg you opened. One movement
  is recorded in two accounts, so the dialog fills itself from the pair — From is
  the account the money left, To is the one it arrived in, the amount is the
  movement rather than one leg's signed share of it — and saving rewrites both
  legs at once, keeping their ids. Recording a *second* pair instead, which an
  earlier version did, doubled every total the first one had already moved.

  Because the destination is what decides the category, redirecting a transfer at
  a card turns it into a card payment and the outflow leg picks up that card's
  payment envelope; redirecting it away gives the envelope back up. The same is
  true across kinds: something recorded as spending that was really a transfer
  *replaces* the expense rather than joining it, and a transfer reclassified as
  spending takes its other leg with it — that leg recorded money arriving
  somewhere it never did.

---

## Bills that come round again

Rent, electricity, the phone, the streaming subscription you forgot about: the
part of a month that is decided before the month starts. Zenith tracks them as
**schedules, not ledger entries**, and the distinction is the whole design.

A bill stores one real due date and a cadence — weekly, fortnightly, monthly,
quarterly, half-yearly, yearly. Every occurrence, past and future, is that
anchor stepped by the cadence, so nothing is rolled over at the end of a month
and a due date of the 31st lands on the 28th of February and goes *back* to the
31st in March. The schedule starts at its anchor and never runs earlier: a bill
entered with its next due date would otherwise sprout a history of dates nobody
was ever billed for, every one of them reading as missed.

### Paid is something the ledger says

**Tracking a bill creates no transactions.** Nothing is marked paid on the bill
itself either. An occurrence is settled when a transaction carries that bill's
id *and the due date it settles*:

```ts
{ payee: 'Municipal Power', amount: -16_440, categoryId: 'cat_utilities',
  billId: 'bill_x9…', billDue: '2026-07-08' }
```

Storing the due date rather than inferring it from the payment's own date is
what lets a bill be paid three days early and still settle the occurrence it was
meant for. And because the tag is the only record, deleting the payment un-pays
the month, editing it re-prices the month, and untracking a bill entirely leaves
the spending exactly where it was — real money that really moved, still in its
category.

The three rules that keep it honest fall out of that:

1. **A schedule moves no money.** Adding a bill leaves every balance, envelope
   and Ready-to-assign figure untouched.
2. **A bill paid on a credit card is card spending.** It draws down its category
   and reserves the same cash in that card's payment envelope, through exactly
   the wiring above — `core/budget.ts` has no special case for bills.
3. **An occurrence can be skipped.** Intent is the one thing the ledger cannot
   hold, so a deliberately unpaid cycle is recorded on the bill by its due date.
   Paying one that was marked skipped settles the argument and clears the mark.

### Coverage, again

Cards ask whether the budget covers the debt. Bills ask the same question about
a date:

> **$1,240 of this month's bills isn't funded** — Housing and Utilities do not
> hold enough to meet what is still due.

Bills sharing an envelope are added up first, because they share one envelope
and will empty it in turn. **Assign what they need** tops the envelopes up
soonest-due-first, and stops at what is genuinely unassigned — a budget that
funds its bills by going over-assigned has not funded anything, it has moved the
problem into next month. Whatever is left short stays visibly short.

The budget table says the same thing on the row that can act on it: *"$1,650 of
bills due · $410 short"* under the envelope's name.

### Variable bills forecast themselves

A metered utility bill is not what the figure you typed in last winter says it
is, so a bill marked **varies** is forecast from the average of its last three
actual payments, falling back to the stated amount until there is history. The
forecast is labelled an estimate everywhere it appears — `~$128.44`, *"about
$128.44"* — because a number presented as certain and then wrong costs more
credibility than it saves.

Whatever the cadence, every bill also reports a **monthly equivalent** (a yearly
$300 insurance is $25 a month), which is what makes "your standing commitment is
$2,132 a month" a figure you can compare against income.

### Recognising one

Zenith will point at payees you already pay on a rhythm — *"You have paid these
on a regular rhythm"* — with the cadence, amount and category filled in. The
detection is deliberately strict: monthly at the shortest, every gap within a
fifth of the median, and stable amounts before it will guess anything longer
than monthly. Three visits to the same restaurant average out to an interval
too; what they do not do is repeat it within a few days each time. Suggestions
are **offered, never created** — the figures are handed to the form and a person
decides.

---

## Reminders

A bill you meant to pay is the most expensive thing an offline budget can miss,
so Zenith raises **system notifications** before a card payment or a recurring
bill is due.

They are real notifications — the same surface a messaging app uses — but they
are **not push notifications**, and the distinction is the whole design. Push
means a server holds a subscription and sends you something. Zenith has no
server, no account and no subscription to hold, so instead each device works out
its own reminders from the budget already in front of it. Nothing is sent
anywhere, and turning them on adds no network call to an app that makes none.

What that buys, and what it costs:

- **No infrastructure, and no new privacy story.** The "everything stays in your
  browser" claim survives the feature intact.
- **Delivery depends on the browser waking the app.** Where periodic background
  sync exists (installed PWAs on Chromium) the worker is woken on its own and
  the reminder arrives on time. Everywhere else — Safari, Firefox, iOS — the
  reminder is raised the next time Zenith is opened. Settings says which of the
  two you are getting rather than leaving you to find out.
- **Figures are as of the last time the app was open.** A reminder delivered in
  the background quotes the statement it was planned against.

### What it says, and when

Reminders are derived, never stored: the same budget on the same day always
produces the same list, with the same ids. That is what makes "show this once"
possible with nothing but a set of ids to remember — the id *is* the receipt.

| Reminder | Fires | Default |
|---|---|---|
| Payment due | `leadDays` before the due date, and again on the day | on |
| Overdue | the day after the due date, repeating | on |
| Unfunded debt | the day the statement closes, while coverage is short | on |
| Bill due | `leadDays` before a recurring bill's due date, and again on the day | on |
| Bill past due | the day after, repeating, until it is paid or skipped | on |
| Statement closing | the day the statement closes | off |

A bill reminder is only ever about the occurrence actually outstanding, so
paying one — or skipping it — silences it with no state kept anywhere. A bill
marked **automatic** is still announced (the money has to be there) but never
interrupts: nothing is being asked of you.

Two windows keep them honest. A reminder may be delivered up to **two days
late** — a phone that was off should still say "your bill is due" the next
morning — but no later, because by then it is news rather than a reminder.
Overdue is the exception in kind: being late is a *state*, not a moment, so it
repeats, spaced to exactly the grace window, so that every day a card is late is
covered by one repeat and no day is covered by two. It gives up after three
weeks, and hands over entirely once the next statement closes and the missed
payment becomes part of a new bill.

Because reminders are computed from the budget rather than the balance, they
carry the thing the balance cannot say — *"$1,240.00 of it is not funded yet"*
against *"Your budget covers it in full"*. On a card used inside the budget it
is always the second: spending funded its own payment envelope as it happened.

### How the worker gets them

A service worker cannot read `localStorage`, so it cannot recompute anything.
The app instead writes a precomputed schedule into the **Cache API** — the one
store both sides can reach — and the worker only compares dates. The delivery
receipts live in that same document, so a reminder shown in the background is
not shown again when the app opens, and vice versa.

The worker deliberately duplicates the handful of shapes it needs rather than
importing `core/reminders.ts`: the worker is built to the repo root, and one
import would drag the whole app tree out there with it. `tests/pwa.test.ts`
checks the two copies still agree on the cache entry, the tag and the grace
window — a silent disagreement there means reminders that simply never arrive.

That cache is also the one `zenith-` cache `activate` does **not** delete. It is
data, not code: naming it after the shell version would throw away every pending
reminder, and every receipt, on each deploy.

---

## Importing a statement

A budget you have to type in twice is a budget you stop keeping, so Zenith reads
the PDF your bank emails you and proposes the transactions in it.

**Which account it belongs to is asked before the file is.** A card is a
decision someone can make without the statement in hand, and asking for the
PDF only once it is made means a password prompt and a parse never happen for
the wrong account. Opening **Import statement** from a specific card arrives
with that account already chosen; opening it anywhere else drops you straight
into the picker, and the file chooser stays disabled until an account is.

Statements from Philippine banks arrive **password protected**, so that is the
next thing the flow handles rather than the last. Choosing a file that turns out
to be encrypted stops everything and asks:

> **Password required** — "bdo-card-aes256.pdf" is password protected. Zenith
> needs the password to read it — it is used here and now, and never saved.

Nothing continues until the password is right. A wrong one says so and asks
again; cancelling abandons the import. The password is passed straight to the
parser and is never put in the state, which is what keeps it out of
localStorage and out of a backup export.

### It reads the PDF itself

There is no PDF library. `src/core/pdf/` is a reader written for this app,
because a runtime dependency is the one thing this repo does not have and a
statement reader is not a good reason to acquire one:

| Module | What it does |
|---|---|
| `inflate.ts` | DEFLATE and zlib, synchronously — `DecompressionStream` is async and would spread `await` through the whole parser |
| `crypt.ts` | MD5, SHA-256/384/512, RC4 and AES. WebCrypto has neither MD5 nor RC4, and its AES-CBC always pads |
| `security.ts` | The standard security handler, revisions 2–6: RC4-40, RC4-128, AES-128, AES-256, user **and** owner passwords |
| `objects.ts` · `document.ts` | The object layer, and a document assembled by *scanning* for `N G obj` rather than trusting the cross-reference table — a broken xref is the most common way a real statement resists being read |
| `filters.ts` | Flate, LZW, ASCII85, ASCIIHex, RunLength, and PNG/TIFF predictors |
| `fonts.ts` · `text.ts` | Glyph decoding (ToUnicode, WinAnsi, MacRoman, Identity-H) and the content-stream interpreter that turns drawing instructions back into positioned lines |

The cryptography is only ever used to *open* a file the person already has the
password for, on their own device.

### When the text itself is the thing being protected

Encryption is not the only way a statement resists being read. Some portals
generate a PDF where every glyph is its own unlabelled bitmap — a `Type3`
font whose `CharProc` is a tiny inline image and whose glyph name is nothing
but its own code in hex (`C40`, `Cd7`, …), with no `/ToUnicode` anywhere. The
shapes still print correctly — copy the text out and it is noise. A BPI
"Statement of Account" downloaded from their web portal reads exactly this
way, and so, for the same reason, does `pdftotext`.

`fonts.ts` recovers a fixed substitution table for that specific scheme —
recovered by hand, cross-referencing what a real statement's rendered pages
say against the codes its content stream actually draws, not guessed from
glyph shape. It held identically across every font resource that one
statement used, header to fine print, which is what a single table baked
into the generator looks like rather than one re-rolled per document. A font
is only read through it when its `/Differences` names are *all* of that
`Cxx` shape over a real sample size — a coincidence would have to repeat
across the whole array — and a code the table does not cover decodes to
nothing rather than a guess, same as any other undecodable glyph.

### Columns, not spacing

A PDF contains no rows and no columns — only instructions to place runs of
glyphs at coordinates, frequently in an order that has nothing to do with
reading order. `core/statement.ts` recovers the table from the geometry: runs
are grouped into lines by baseline, and each amount is matched to a column
heading by its **right edge**, because that is what right-aligned numbers share.

That is what tells a debit from a credit on a layout like RCBC's, where the only
difference between money arriving and money leaving is which of two columns the
figure sits in — a distinction that vanishes the moment the line is flattened
into text.

Getting the widths right matters more than it sounds: a heading set in
Helvetica-Bold with no `/Widths` array comes out 26 points narrow under a
"half an em per character" guess, and stops matching its own column. The
standard-14 metrics are in `fonts.ts` for exactly that reason.

### Which banks

Layouts modelled on **BDO**, **BPI**, **UnionBank** and **RCBC** are covered by
fixtures in `tests/fixtures/`, and each is asserted row by row — a parser that
finds the right *number* of transactions and puts half of them on the wrong side
of the ledger is worse than one that finds none. Between them they exercise
`MM/DD/YYYY` against `DD MMM YY`, one amount column against split
`PURCHASES/CHARGES` and `PAYMENTS/CREDITS` columns, `CR` markers against column
position, and four vocabularies for "total amount due".

The parser carries **no per-bank layout rules**, and that is deliberate. A
statement's own columns and dates describe it better than a guess about what a
bank's template looked like when this was written — and a template that changed
would then quietly produce *wrong* figures rather than none. What is per-bank is
only recognition of the name, shown against the account you picked once the
statement is read — *"The statement ends in 4821"* — so a mismatch is caught
before anything is saved rather than guessed away.

Other banks are not excluded; they are simply not proven. The parse is generic,
so a statement from anywhere may well work — the review table is where you find
out.

### Rows become the right kind of transaction

The arithmetic is the easy part. The hard part is which *shape* each row has to
take so the invariant above still holds afterwards:

| Row | Recorded as | Why |
|---|---|---|
| Charge on a card | negative expense, categorised | draws the envelope down and reserves the same cash for the bill |
| Refund on a card | **positive expense**, categorised | returns money to the envelope *and* releases the reserve, because the debt fell too |
| Payment to a card | a **transfer** from an asset account | the cash genuinely moved; recording it on the card alone would invent money |
| Spending or income on a bank account | negative expense / positive income | the ordinary case |

The one that most wants to be wrong is the card refund: recording it as income
would add to Ready to assign without a peso arriving anywhere, and Settings →
Budget integrity would start reporting a difference. `tests/statement-import.test.ts`
runs the reconciliation identity against every one of these shapes.

A payment with no source account chosen is **skipped rather than approximated**.
The money came out of somewhere, and guessing where would unbalance that account.

### Instalments are recognised

A row reading `INSTALLMENT - APPLIANCE 3/12` says two things: ₱4,166.60 was
billed this month, and it will be billed nine more times. The import offers to
track the second half, deriving the term and the start month from the marker —
the third of twelve on a June statement began in April — so a plan is
recoverable from *any* statement, not only the one that started it.

A bare `3/12` is only read as an instalment when the row says it is one.
`PAYMENT 06/18` is a date, and it reads perfectly well as "the sixth of
eighteen"; numbers alone cannot separate the two, and inventing a nine-month
commitment out of a date is a worse failure than missing one. `3 of 12` is
unambiguous and needs no such wording.

### Moving money is not spending

Nothing on a statement distinguishes money you spent from money you moved to
your own other account — `TRANSFER TO SAVINGS` looks exactly like a purchase. So
any row can be switched to a **transfer**, which asks for the account on the
other side and records the linked pair.

It matters more than it looks. Imported as spending, a transfer overstates what
you spent, and with no envelope behind it the amount comes out of Ready to
assign. Imported as a transfer it is correctly uncategorised and changes nothing
but where the money sits. A transfer with no account chosen on the other side is
**skipped rather than approximated**, for the same reason a card payment is.

**Moving money between your own accounts needs no category, so it is never asked
for one.** Both legs are uncategorised — nothing was spent, so no envelope
changes — and the import recognises the case itself when the statement gives it
away. Two things have to be true: wording that means a movement (`TRANSFER`,
`TOP-UP`, `AUTO DEBIT`, `PAYMENT TO`…) *and* the name or bank of an account you
actually hold. So `FUND TRANSFER TO BPI SAVINGS` is read as a move to that
account, with the other side already filled in and no category guessed for it,
while `TRANSFER TO 09171234567` is not — nothing in it names an account you keep
here — and neither is `BPI SAVINGS ACCOUNT FEE`, because nothing about it moved.
Both halves are required precisely because either alone is a guess: an account
name turns up on plenty of ordinary charges, and plenty of transfers go to other
people.

It stays a proposal. The row says which account it picked and why — *"This row
names GCash, one of your own accounts, so it is read as moving money rather than
spending it"* — and one press turns it back into spending, which is what a `GCASH
TRANSFER TO 09171234567` that went to somebody else's number needs.

The same signal improves a card payment rather than reclassifying it: a statement
that says `AUTO DEBIT PAYMENT FROM BPI SAVINGS` has named the account the money
left, which is better than the default the app would otherwise offer.

The one movement between your own accounts that *is* categorised is paying a card
or a loan, and only on the leg that leaves the asset account: it spends the
payment envelope your card spending filled. Without that the cash would leave
with no envelope falling to match it — see § The invariant.

### It checks its own work

A statement states what you owe. After an import, the card should agree with it
— so the review screen says whether it will:

> **Balances match** — importing these rows leaves BDO Gold owing ₱9,843.23,
> exactly what the statement says.

When it does not, the gap is named along with its most likely cause. There is
one mistake that is very easy to make and hard to spot afterwards: adding a card
asks for the balance owed *today*, and taking that figure from the statement you
are about to import means the starting balance **already contains every row on
it**. Importing then counts the same spending twice, and the card ends up wrong
by exactly the net movement of the statement.

> **₱1,722.78 out** — importing these rows leaves BDO Gold owing ₱11,566.01 as
> of 18 Jun 2026, but the statement says ₱9,843.23.
>
> The gap is exactly what these rows add up to, so the card's starting balance
> most likely already includes them.
>
> [ Set the starting balance to ₱8,120.45 ]

The figure offered is the one that makes the two agree — which, for a statement
whose own numbers add up, is its previous balance. Nothing is corrected
automatically: an opening balance is a number someone entered on purpose, and
rewriting it silently would be worse than the discrepancy.

### Nothing is saved until you say so

The parse produces *proposals*. Every row is shown with its date, its posted
date, payee, category and amount all editable, and anything that looks like a
transaction already in the ledger arrives unticked, naming the one it matched.
Categories are guessed from your own history — the category that payee went to
last time — rather than from a shipped merchant list that would be wrong for
anyone whose spending does not look like the author's.

### The same statement twice is a no-op

Statements get re-sent, re-downloaded and re-imported, so every transaction
carries a **posted date** alongside the date the money moved:

```ts
{ date: '2026-05-21', postedDate: '2026-05-22', payee: 'SM Supermarket Sucat', … }
```

`date` is when the money moved and is the only date the budget uses. `postedDate`
is the bank's own date for the row — the posting date when a statement prints
both, otherwise the single date it prints — and it is stored even when the two are
equal, because it is the anchor a second import matches on. Every shape gets one:
charges, refunds, ordinary spending and income, and **both legs of a transfer**,
including a card payment and any fee riding along, because one movement was posted
once. A posting date corrected on either leg travels to the other.

That gives the duplicate check a fact instead of a resemblance:

1. **Same account, same amount, same posted date** — the statement said this row
   was posted that day, and a statement does not change its mind. The row is
   recognised however far its `date` has since been edited, with no window
   involved: *"Already in your ledger, posted the same day (22 May 2026)."*
2. **Same amount within a few days** — the older heuristic, still the only one
   available against a transaction typed in by hand.

Certainties are matched first, and one existing transaction can still only absorb
one row: two coffees at the same price on the same day are a real thing, so the
second stays new. Re-importing a whole statement therefore arrives entirely
unticked, and importing it anyway writes nothing —
`tests/statement-import.test.ts` runs the BDO fixture through twice and pins that
the ledger, both account balances and the reconciliation identity are unchanged.

A posted date can also be filled in by hand on the transaction form, which is
what makes a payment you recorded yourself recognisable when its statement
arrives.

What it will not do: read a **scanned** statement. If the PDF is a photograph of
a page rather than text, there is nothing to extract, and the app says so instead
of importing nothing and calling it success.

## Architecture

```
index.html            app shell (loads dist/app.js)
manifest.webmanifest  installability
styles/               tokens · base · components · views · glass (loaded last)
src/
  app.ts              chrome, nav, theme, render loop
  router.ts           hash routing (works from file:// too)
  store.ts            single state object, localStorage, pub/sub, undo stack
  pwa.ts              SW registration, install & update prompts, online state
  reminders.ts        permission, delivery, and the schedule handed to the SW
  sw.ts               service worker → compiled to ./sw.js at the repo root
  core/               pure domain logic — no DOM, no storage
    model.ts          the type layer: Account union, state, constructors
    money.ts          integer cents in, formatted strings out
    dates.ts          'YYYY-MM-DD' / 'YYYY-MM' calendar maths
    budget.ts         the engine: rollover, activity, reserves, reconcile
    cards.ts          balances, cycles, minimums, coverage, payoff
    bills.ts          recurring schedules, what has been paid, what is unfunded
    reminders.ts      which notifications a budget earns, and on what day
    actions.ts        state transitions (pure: state → state)
    seed.ts           deterministic sample data
    installments.ts   monthly instalment plans: what is left, and when it stops
    loans.ts          loan balances, progress, monthly commitment and payoff cost
    statement.ts      reading a bank statement's lines into candidate rows
    statement-import.ts  those rows as transactions, deduped against the ledger
    pdf/              a dependency-free PDF reader — inflate, crypto, objects,
                      filters, fonts, text extraction (see § Importing a statement)
  ui/                 dom · icons · charts · components · modal · toast · forms · password
  views/              one module per screen
tools/                static dev server · PNG icon generator
tests/                node:test — engine, cards, charts, reminders, PWA wiring
dist/                 build output (git-ignored)
```

**`core/` is pure and DOM-free**, which is why the money maths is directly
testable under plain `node --test` with no browser or test framework.

## TypeScript setup

Sources import each other with **`.ts` extensions**, which makes one source tree
serve both runtimes:

- **Node runs the sources directly.** Node 22 strips types, so `npm test` and the
  tools need no build at all — `node --test "tests/**/*.test.ts"`.
- **The browser gets compiled output.** `rewriteRelativeImportExtensions` turns
  those `.ts` specifiers into `.js` on emit, so `dist/` is plain ES modules.

Three configs, because the three targets have genuinely different libs:

| Config | Purpose |
|---|---|
| `tsconfig.json` | the app → `dist/`, DOM lib |
| `tsconfig.sw.json` | the service worker → `./sw.js`, WebWorker lib |
| `tsconfig.check.json` | type-checks app + tests + tools, emits nothing |

The worker compiles to the **repo root** rather than `dist/` on purpose: a
worker's default scope is its own directory, so serving it from `dist/` would
leave it unable to control the root page without an extra HTTP header.

`strict` is on, plus `noUnusedLocals`, `noImplicitReturns` and
`erasableSyntaxOnly` — the last of which keeps the sources runnable by Node's
type stripping by rejecting syntax that needs real codegen (enums, namespaces,
parameter properties).

### What the types are actually worth here

`Account` is a **discriminated union**, so a credit card's terms cannot be read
off a chequing account without narrowing through `isCredit` first:

```ts
export type Account = AssetAccount | CreditAccount;
export const isCredit = (a: Account | null | undefined): a is CreditAccount =>
  a?.type === 'credit';
```

Converting to TypeScript surfaced three real bugs that the JavaScript version
shipped with:

1. **`#/cards/<chequing-id>` rendered a card** with blank APR, limit and dates,
   because the detail view trusted any account it found by id. It now shows
   "card not found".
2. **`upcomingPayments(asOf)` ignored its own date argument** when computing
   days-until-due — it never threaded `asOf` through to the snapshots.
3. **`updateAccount` could produce an invalid account** by spreading a patch of
   card terms onto a chequing account. It now re-runs the constructor, which
   strips them.

### Design decisions worth knowing

- **No runtime dependencies.** A budget you rely on should not stop working
  because a toolchain rotted, so nothing ships to the browser but this repo's own
  code. The tradeoff is a hand-rolled hyperscript layer and hand-rolled SVG
  charts. TypeScript is a build-time dependency only.
- **Integer cents everywhere.** Floats never touch a balance; rate maths rounds
  back to cents immediately.
- **localStorage, not IndexedDB.** The whole budget is a few hundred KB of JSON,
  so reads are synchronous and rendering never awaits. Export is one
  `JSON.stringify`.
- **`u` undo instead of confirmation dialogs** for reversible actions;
  confirmation is reserved for genuinely destructive ones.
- **Test fixtures fail loudly.** Lookups go through a `must()` helper rather than
  a `!` assertion, so a drifted fixture reports what went missing instead of
  throwing a TypeError inside an assertion.
- **Transfers are always a linked pair.** Deleting an account deletes both legs,
  and editing one rewrites both — a half-transfer, or a second copy of one, would
  silently unbalance every total in the app.
- **Text always goes through `textContent`.** A payee named `<img onerror=…>` is
  just an odd payee name.

### Data & privacy

Everything stays in your browser. A statement you import is read on the device
and its password is never stored. There is no account, no sync and no network
call — the service worker only ever caches Zenith's own files, and reminders are
worked out on the device rather than pushed to it. Because that means
a cleared browser takes the budget with it, Settings has a one-click JSON backup,
and the app says so plainly rather than burying it.

---

## Charts

The chart layer follows one fixed spec rather than per-chart taste: bars cap at
24px with a 4px rounded data-end and a square baseline, a 2px surface gap
separates touching marks, lines are 2px with ≥8px markers ringed in the surface
colour, gridlines are hairline and recessive, and there is never a second y-axis.
Two or more series always get a legend; direct labels stay selective; every chart
offers a table view; axis steps are rounded *before* the maximum is derived, so
ticks read `$1,000` rather than `$1,300`.

### Colour

The eight categorical slots are a fixed, validated order — a category keeps its
slot for life, so filtering never repaints the survivors, and a ninth series
folds into a neutral "Other" instead of inventing a hue.

Both modes were validated against their own surface (`#fcfcfb` / `#1a1a19`):
worst adjacent colour-vision-deficiency ΔE **9.1** light / **8.4** dark, worst
adjacent normal-vision ΔE **19.6** / **19.3**. Dark is a *selected* set of steps
for the dark surface, not an automatic flip.

Three light-mode slots (aqua, yellow, magenta) sit below 3:1 against the light
surface. That is a known warning, and the relief is shipped rather than ignored:
every chart using them carries direct value labels **and** a table view. Status
colours are reserved for state, never reused as a series, and always ship with an
icon and a word.

### Glass

Surfaces are frosted glass: translucent panels blurring a fixed colour mesh. A
panel is four things at once, and drops out of the illusion if any is missing —
a translucent fill, a blur of what is behind it, a sheen across the top-left
standing in for a reflection, and a 1px white rim that reads as thickness.

`styles/glass.css` loads last and applies all four in one place, so the
treatment is a single decision rather than thirty component rules — and a single
place to undo. It is undone in three cases: `prefers-reduced-transparency`,
browsers without `backdrop-filter`, and print. All three land on the same
opaque surfaces.

Transparency is where a design like this usually loses its accessibility, so
contrast is **measured on the composite rather than assumed**: a browser pass
samples the rendered pixel behind every text run — through the glass, the blur
and the mesh — and compares it with the computed text colour. Every sampled run
across six screens in both modes clears 4.5:1, the tightest being **4.70:1**.
That pass is what moved the muted ink darker in light and lighter in dark, and
it caught two pre-existing dark-mode status pills below the line (3.53:1 and
4.31:1), fixed by darkening their tracks.

---

## Accessibility

Semantic landmarks and a skip link; `aria-current` on navigation; meters expose
`role="meter"` with values; the dialog traps focus and closes on Escape; charts
carry `aria-label`s, keyboard-focusable marks and a table view of the same data;
status is never colour-alone; `prefers-reduced-motion`, `prefers-color-scheme`
and `prefers-reduced-transparency` are all respected; hit targets are ≥40px and the primary actions sit within
thumb reach on a phone.

---

## Icons

`npm run icons` generates every app icon from `tools/gen-icons.ts` — a ~40-line
PNG writer over Node's built-in `zlib`, so even the icon pipeline has no
dependencies. Shapes are 4× supersampled for smooth edges, and the maskable
variants keep the artwork inside the middle 80% so a circular crop cannot clip
it.

The mark is a **rising line ending in a marker at its high point** — a zenith,
which is what the name means — on an indigo-to-blue plate, echoing the end-dot
the app's own line charts draw. Two shapes it deliberately is not: bars on a flat
blue square (that is LinkedIn's silhouette), and a dot centred above a symmetric
peak (which reads as a person).

## Single-file build

`npm run build:artifact` packs the whole app into one self-contained
`dist-artifact/zenith.html` — no external requests of any kind. Useful for
sharing the app as a single page.

Collapsing 26 modules into one document needs a bundler, because concatenating
the ES modules into one scope would collide on every same-named local (`render`,
`state`, `money`, …). Rather than hand-writing a transpiler, `tsc` emits
CommonJS and `tools/build-artifact.ts` wraps each module in its own function,
registered by path and required lazily — about twenty lines of registry.

Three things the single file necessarily gives up:

- **Offline caching.** A service worker has to be a separate same-origin script
  at the scope it controls, and it cannot be registered from a `data:` or
  `blob:` URL.
- **Installability.** That needs the worker plus a linked manifest.
- **Reminders.** Notifications that outlive the tab are raised through the
  worker, so Settings says the preview cannot do it rather than offering a
  switch that would do nothing.

Everything else works, including localStorage persistence. The app detects this
mode via `window.__ZENITH_EMBEDDED__`, which makes it skip worker registration,
leave the host page's light/dark stamp alone rather than fighting it, and say so
in Settings instead of offering an install that cannot work. The page opens with
the sample budget seeded through the store, so it still fills with content even
where a host sandboxes storage.

## Deploying

The app is static once built:

```bash
npm ci && npm run build   # emits dist/ and sw.js
```

Then serve `index.html`, `manifest.webmanifest`, `sw.js`, `dist/`, `styles/` and
`assets/`. Every reference is relative, so a project subpath
(`you.github.io/zenith/`) works with no configuration: the worker scopes itself
to that directory rather than the domain root. `sw.js` has to sit beside
`index.html` — a worker only controls its own directory and below.

Two workflows, kept separate so publishing the live site is never a side effect
of opening a pull request:

- `ci.yml` — type-checks, tests and builds every pull request and every push to
  `main`, and fails if the single-file bundle picks up an external reference.
- `deploy.yml` — publishes to Pages from `main` only. It needs one manual step:
  repository **Settings → Pages → Source: GitHub Actions**.

### Being told about an update

A new deploy is useless if the app never mentions it. Registering the worker
asks the browser to check once, at page load — and for a long time that was the
*only* check, which meant a tab left open, or an installed app never closed, sat
on an old version indefinitely. You had to reload to be told to reload.

Zenith now looks again when it comes back to the foreground, and hourly while it
stays there. When something is waiting it says so in three places, because a
toast lasts seconds and the moment is easy to miss:

- a toast, with **Reload** on it
- an **Update** button in the header, which stays until it is used
- a row in Settings → Install, which is where someone goes looking afterwards

Settings also has **Check for updates** for the moment you know a change has
shipped and would rather not wait for the next check.

The check is a conditional request for Zenith's own `sw.js`. It sends nothing —
there is still no account, no sync, and no data leaving the device.

### Cache busting

The worker precaches the shell into `zenith-shell-${VERSION}` and serves it
cache-first, so `VERSION` *is* the cache-busting mechanism: while it stays the
same, a returning visitor keeps being served the files already in their cache,
and a redesign can ship to nobody. `activate` deletes every `zenith-` cache that
is not the current pair, so moving the version throws the old shell away.

Hand-bumping a constant is exactly the step that gets forgotten, so the build
derives it. `tools/stamp-sw.ts` hashes every source the shell is built from
(`src/**/*.ts`, `styles/*.css`, `index.html`, the manifest and the icons) and
stamps the first 12 hex digits into the emitted `sw.js`. Identical inputs give an
identical version — a deploy that changes nothing forces nobody to re-download —
and any real change gives a new one. `tests/pwa.test.ts` recomputes the hash and
fails on a stale stamp, and CI re-runs that check *after* building, where the
emitted worker actually exists.

What a visitor then sees: the page is network-first, so a deploy is picked up on
the next load; the new worker installs in the background and the app offers
**"A new version is ready — Reload"**, which posts `SKIP_WAITING` and reloads
under the new worker. Nothing is silently swapped underneath an open session.

To clear a cache by hand — a corrupted state, or testing the first-run
experience — DevTools → Application → **Unregister** the worker and **Clear site
data**, then reload. A plain hard reload bypasses the HTTP cache but not the
worker's Cache Storage, which is why it often looks like nothing changed.

### Why the single-file build is not a substitute

The single-file build is for *sharing* the app, not installing it. A PWA needs
two things a lone HTML file cannot have:

- a **service worker** — which must be a separate same-origin script, and cannot
  be registered from a `data:` or `blob:` URL
- a **linked manifest** — which browsers only honour for a top-level document,
  not one embedded in a cross-origin frame

Add-to-Home-Screen on such a page gives a bookmark, not an installed app, and it
still needs the network to open. Host the built app for the real thing.

## Browser support

Any browser with ES modules, `<dialog>`, CSS custom properties and
`color-mix()` — Chrome/Edge 111+, Safari 16.4+, Firefox 113+. The service worker
is skipped on `file://` (no origin to scope to) and the app still runs.

## Licence

MIT
