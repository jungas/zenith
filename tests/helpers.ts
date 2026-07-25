/** Shared test helpers. */

import { paymentCategoryFor } from '../src/core/model.ts';
import type { AppState, Category, CreditAccount } from '../src/core/model.ts';

/**
 * Assert a fixture lookup found something.
 *
 * Preferred over a `!` assertion so a fixture that drifts fails with a sentence
 * naming what went missing, rather than a TypeError deep inside an assertion.
 */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`test fixture is missing: ${what}`);
  return value;
}

export function account(state: AppState, name: string) {
  return must(
    state.accounts.find((a) => a.name === name),
    `account "${name}"`,
  );
}

export function creditAccount(state: AppState, name: string): CreditAccount {
  const found = account(state, name);
  if (found.type !== 'credit') throw new Error(`test fixture: "${name}" is not a credit card`);
  return found;
}

export function category(state: AppState, name: string): Category {
  return must(
    state.categories.find((c) => c.name === name && c.kind === 'spending'),
    `category "${name}"`,
  );
}

/** The payment envelope a credit account owns. */
export function paymentEnvelope(state: AppState, accountId: string): Category {
  return must(paymentCategoryFor(state, accountId), `payment envelope for ${accountId}`);
}
