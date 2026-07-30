/**
 * Savings interest: what a p.a. rate actually earns on the balance sitting
 * there today.
 *
 * A savings account never bills anything the way a card or loan does, so
 * there is nothing here to amortise — just a balance and a rate, projected
 * forward the same way `monthlyInterestCost` projects a card's or loan's rate,
 * so all three read the same at a glance.
 */

import { accountBalance } from './budget.ts';
import { isAsset } from './model.ts';
import type { AppState, AssetAccount, Cents } from './model.ts';

export const savingsAccounts = (
  state: AppState,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): AssetAccount[] =>
  state.accounts.filter(
    (a): a is AssetAccount => isAsset(a) && a.type === 'savings' && (includeArchived || !a.archived),
  );

export interface SavingsSnapshot {
  account: AssetAccount;
  /** Current balance, positive. */
  balance: Cents;
  /** Annual rate as a decimal, e.g. 0.025 for 2.5% p.a. */
  annualRate: number;
  /** One more month at the stated rate. */
  monthlyInterest: Cents;
  /** One more year at the stated rate, on today's balance. */
  annualInterest: Cents;
}

/** What this savings account's p.a. rate earns on its balance, monthly and yearly. */
export function savingsSnapshot(state: AppState, account: AssetAccount): SavingsSnapshot {
  const balance = Math.max(0, accountBalance(state, account.id));
  const annualRate = account.interestRate || 0;
  return {
    account,
    balance,
    annualRate,
    monthlyInterest: balance > 0 && annualRate ? Math.round(balance * (annualRate / 12)) : 0,
    annualInterest: balance > 0 && annualRate ? Math.round(balance * annualRate) : 0,
  };
}

export function savingsSnapshots(state: AppState): SavingsSnapshot[] {
  return savingsAccounts(state).map((account) => savingsSnapshot(state, account));
}

export interface SavingsTotals {
  savings: SavingsSnapshot[];
  balance: Cents;
  monthlyInterest: Cents;
  annualInterest: Cents;
}

/** Totals across every savings account, for a dashboard-level figure. */
export function savingsTotals(state: AppState): SavingsTotals {
  const savings = savingsSnapshots(state);
  return savings.reduce<SavingsTotals>(
    (totals, snapshot) => ({
      savings,
      balance: totals.balance + snapshot.balance,
      monthlyInterest: totals.monthlyInterest + snapshot.monthlyInterest,
      annualInterest: totals.annualInterest + snapshot.annualInterest,
    }),
    { savings, balance: 0, monthlyInterest: 0, annualInterest: 0 },
  );
}
