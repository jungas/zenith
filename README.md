# Zenith

An installable, offline-first **envelope budgeting** PWA where **credit cards are
part of the budget** rather than a separate ledger you reconcile by hand.

Written in **TypeScript** under `strict`, with **no runtime dependencies** — no
framework, no bundler, no chart library. TypeScript is the only build-time
dependency.

```bash
npm install
npm start         # builds, then serves http://localhost:4173
npm test          # type-checks, then runs 59 tests
npm run typecheck # types only
npm run build     # dist/*.js + sw.js
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
| **Cards** | Per card: balance, utilisation band, available credit, statement balance, minimum payment, statement/due dates, funding coverage, interest cost |
| **Card detail** | Statement-cycle timeline, a plain-language walkthrough of the budget connection, and a payoff planner (amortisation, total interest, months saved vs paying the minimum) |
| **Ledger** | One searchable list across every account, filterable by account, category and month |
| **Reports** | Income vs spending, spending by category, card debt over time, savings rate — 3/6/12-month ranges |
| **Accounts** | Net worth, cash, debt, per-account balances — chequing, savings, cash, digital wallets and cards |
| **Settings** | Currency (26, including PHP) and locale, theme, utilisation warning threshold, install, JSON backup import/export, CSV export, sample data, integrity check |

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

## Architecture

```
index.html            app shell (loads dist/app.js)
manifest.webmanifest  installability
styles/               tokens · base · components · views
src/
  app.ts              chrome, nav, theme, render loop
  router.ts           hash routing (works from file:// too)
  store.ts            single state object, localStorage, pub/sub, undo stack
  pwa.ts              SW registration, install & update prompts, online state
  sw.ts               service worker → compiled to ./sw.js at the repo root
  core/               pure domain logic — no DOM, no storage
    model.ts          the type layer: Account union, state, constructors
    money.ts          integer cents in, formatted strings out
    dates.ts          'YYYY-MM-DD' / 'YYYY-MM' calendar maths
    budget.ts         the engine: rollover, activity, reserves, reconcile
    cards.ts          balances, cycles, minimums, coverage, payoff
    actions.ts        state transitions (pure: state → state)
    seed.ts           deterministic sample data
  ui/                 dom · icons · charts · components · modal · toast · forms
  views/              one module per screen
tools/                static dev server · PNG icon generator
tests/                node:test — engine, cards, charts, PWA wiring
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

Two things the single file necessarily gives up:

- **Offline caching.** A service worker has to be a separate same-origin script
  at the scope it controls, and it cannot be registered from a `data:` or
  `blob:` URL.
- **Installability.** That needs the worker plus a linked manifest.

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
