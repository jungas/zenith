# Zenith

An installable, offline-first **envelope budgeting** PWA where **credit cards are
part of the budget** rather than a separate ledger you reconcile by hand.

Written in **TypeScript** under `strict`, with **no runtime dependencies** — no
framework, no bundler, no chart library. TypeScript is the only build-time
dependency.

```bash
npm install
npm start         # builds, then serves http://localhost:4173
npm test          # type-checks, then runs 144 tests
npm run typecheck # types only
npm run build     # dist/*.js + sw.js, stamped with a shell version
npm run icons     # regenerate the app icons
npm run build:artifact   # the whole app as one HTML file
```

Open Settings → **Load sample data** for a worked example: four months of
budgeting across two Philippine credit cards and a digital wallet.

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

### The invariant

Because reserves cancel the debt that created them, the whole system collapses to
one identity, checked live in Settings → **Budget integrity**:

```
readyToAssign + Σ available  ===  Σ cash in asset accounts
```

Card debt does not appear in it. That is the point: every envelope balance is
backed by real money sitting in a real account.

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
| **Cards** | Per card: balance, utilisation band, available credit, statement balance, minimum payment, statement/due dates, funding coverage, interest cost — with limits shared across cards from one bank |
| **Card detail** | Statement-cycle timeline, a plain-language walkthrough of the budget connection, and a payoff planner (amortisation, total interest, months saved vs paying the minimum) |
| **Ledger** | One searchable list across every account, filterable by account, category and month |
| **Reports** | Income vs spending, spending by category, card debt over time, savings rate — 3/6/12-month ranges |
| **Accounts** | Net worth, cash, debt, per-account balances — chequing, savings, cash, digital wallets and cards |
| **Import** | Read a PDF statement — including a password-protected one — and turn it into transactions, with every row reviewable before anything is saved |
| **Settings** | Currency (26, including PHP) and locale, theme, utilisation warning threshold, payment reminders, install, JSON backup import/export, CSV export, statement import, sample data, integrity check |

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

---

## Reminders

A bill you meant to pay is the most expensive thing an offline budget can miss,
so Zenith raises **system notifications** before a card payment is due.

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
| Statement closing | the day the statement closes | off |

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

Statements from Philippine banks arrive **password protected**, so that is the
first thing the flow handles rather than the last. Choosing a file that turns out
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
only recognition of the name, which preselects the account, and the password
hint the prompt offers.

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

### Nothing is saved until you say so

The parse produces *proposals*. Every row is shown with its date, payee,
category and amount all editable, and anything that looks like a transaction
already in the ledger arrives unticked, naming the one it matched. Categories
are guessed from your own history — the category that payee went to last time —
rather than from a shipped merchant list that would be wrong for anyone whose
spending does not look like the author's.

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
    reminders.ts      which notifications a budget earns, and on what day
    actions.ts        state transitions (pure: state → state)
    seed.ts           deterministic sample data
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
- **Transfers are always a linked pair.** Deleting an account deletes both legs —
  a half-transfer would silently unbalance every total in the app.
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
