# Zenith

An installable, offline-first **envelope budgeting** PWA where **credit cards are
part of the budget** rather than a separate ledger you reconcile by hand.

Zero dependencies — no framework, no bundler, no build step. It is HTML, CSS and
ES modules, served as-is.

```bash
npm start     # http://localhost:4173
npm test      # 46 tests, node:test, no dependencies
npm run icons # regenerate the PNG app icons
```

Open Settings → **Load sample data** for a worked example: four months of
budgeting across two credit cards.

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
to fund. (`tests/budget.test.mjs` pins all of this, including the pre-existing
debt case that a naïve version of the identity gets wrong.)

---

## What's in it

| Screen | What it does |
|---|---|
| **Home** | Ready-to-assign hero, cash vs card debt, per-card coverage, payments due, envelopes closest to the limit, spending mix, recent activity |
| **Budget** | Month-by-month envelope table with inline assigning, rollover, overspend flags, move-money, 3-month-average suggestions — and card payment envelopes in their own group with a **Reserved** column |
| **Cards** | Per card: balance, utilisation band, available credit, statement balance, minimum payment, statement/due dates, funding coverage, interest cost |
| **Card detail** | Statement-cycle timeline, a plain-language walkthrough of the budget connection, and a payoff planner (amortisation, total interest, months saved vs paying the minimum) |
| **Ledger** | One searchable list across every account, filterable by account, category and month |
| **Reports** | Income vs spending, spending by category, card debt over time, savings rate — 3/6/12-month ranges |
| **Accounts** | Net worth, cash, debt, per-account balances |
| **Settings** | Currency and locale, theme, utilisation warning threshold, install, JSON backup import/export, CSV export, sample data, integrity check |

Also: one-level-deep **undo** on every mutation (`u`), `n` to add a transaction,
full keyboard navigation, and a focus-trapped dialog.

### Credit-card specifics

- **Statement cycle** — `statementDay` and `dueDay` per card. Balances are
  computed *as of the last close*, so the statement figure excludes charges made
  after it. A due date of the 31st clamps to the last day of a short month
  instead of rolling into the next.
- **Minimum payment** — `max(floor, rate × balance)`, never more than the balance.
- **Payoff planner** — amortises at a chosen monthly payment and reports months,
  total interest and what paying more than the minimum saves. A payment that
  does not clear the monthly interest is reported honestly as *never pays off*
  rather than looping.
- **Utilisation bands** — healthy / above target / high / very high / over limit,
  each with an icon and a word, so state never rides on colour alone.
- **Cash advances** — paying *from* a card draws on its own credit, so nothing is
  categorised and the debt simply grows.

---

## Architecture

```
index.html            app shell
manifest.webmanifest  installability
sw.js                 precached shell, network-first navigations, SWR assets
styles/               tokens · base · components · views
src/
  app.js              chrome, nav, theme, render loop
  router.js           hash routing (works from file:// too)
  store.js            single state object, localStorage, pub/sub, undo stack
  pwa.js              SW registration, install & update prompts, online state
  core/               pure domain logic — no DOM, no storage
    money.js          integer cents in, formatted strings out
    dates.js          'YYYY-MM-DD' / 'YYYY-MM' calendar maths
    model.js          shapes, constructors, payment-envelope invariant
    budget.js         the engine: rollover, activity, reserves, reconcile
    cards.js          balances, cycles, minimums, coverage, payoff
    actions.js        state transitions (pure: state → state)
    seed.js           deterministic sample data
  ui/                 dom · icons · charts · components · modal · toast · forms
  views/              one module per screen
tools/                zero-dep static server · PNG icon generator
tests/                node:test — engine, cards, charts, PWA wiring
```

**`core/` is pure and DOM-free**, which is why the money maths is directly
testable under plain `node --test` with no browser or test framework.

### Design decisions worth knowing

- **No dependencies, no build.** A budget you rely on should not stop working
  because a toolchain rotted. The tradeoff is a hand-rolled ~80-line hyperscript
  layer and hand-rolled SVG charts.
- **Integer cents everywhere.** Floats never touch a balance; rate maths rounds
  back to cents immediately.
- **localStorage, not IndexedDB.** The whole budget is a few hundred KB of JSON,
  so reads are synchronous and rendering never awaits. Export is one
  `JSON.stringify`.
- **`u` undo instead of confirmation dialogs** for reversible actions;
  confirmation is reserved for genuinely destructive ones.
- **Transfers are always a linked pair.** Deleting an account deletes both legs —
  a half-transfer would silently unbalance every total in the app.
- **Text always goes through `textContent`.** A payee named `<img onerror=…>` is
  just an odd payee name.

### Data & privacy

Everything stays in your browser. There is no account, no sync and no network
call — the service worker only ever caches Zenith's own files. Because that means
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

---

## Accessibility

Semantic landmarks and a skip link; `aria-current` on navigation; meters expose
`role="meter"` with values; the dialog traps focus and closes on Escape; charts
carry `aria-label`s, keyboard-focusable marks and a table view of the same data;
status is never colour-alone; `prefers-reduced-motion` and `prefers-color-scheme`
are both respected; hit targets are ≥40px and the primary actions sit within
thumb reach on a phone.

---

## Browser support

Any browser with ES modules, `<dialog>`, CSS custom properties and
`color-mix()` — Chrome/Edge 111+, Safari 16.4+, Firefox 113+. The service worker
is skipped on `file://` (no origin to scope to) and the app still runs.

## Licence

MIT
