/** Pure shaping helpers that turn budget data into chart rows. */

import type { CategoryDatum } from '../ui/charts.ts';
import type { Category, Cents } from '../core/model.ts';

/**
 * Cap a categorical series at the palette's slot count. A ninth series is never
 * a generated hue — the tail folds into a single neutral "Other" row.
 *
 */
export function foldToOther(rows: CategoryDatum[], cap = 8): CategoryDatum[] {
  if (rows.length <= cap) return rows;
  const kept = rows.slice(0, cap - 1);
  const rest = rows.slice(cap - 1).reduce((total, row) => total + row.value, 0);
  return [...kept, { label: 'Other', color: 'series-neutral', value: rest }];
}

/**
 * Spending totals keyed by category id, resolved into labelled, coloured rows
 * ordered largest first.
 *
 */
export function toCategoryRows(
  totals: Map<string, Cents>,
  categoriesById: Map<string, Category>,
): CategoryDatum[] {
  return [...totals.entries()]
    .map(([categoryId, value]) => ({
      label: categoriesById.get(categoryId)?.name ?? 'Uncategorised',
      color: categoriesById.get(categoryId)?.color ?? 'series-neutral',
      value,
    }))
    .sort((a, b) => b.value - a.value);
}
