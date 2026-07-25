/** Pure shaping helpers that turn budget data into chart rows. */

/**
 * Cap a categorical series at the palette's slot count. A ninth series is never
 * a generated hue — the tail folds into a single neutral "Other" row.
 *
 * @param {{label: string, color: string, value: number}[]} rows sorted desc
 * @param {number} cap
 */
export function foldToOther(rows, cap = 8) {
  if (rows.length <= cap) return rows;
  const kept = rows.slice(0, cap - 1);
  const rest = rows.slice(cap - 1).reduce((total, row) => total + row.value, 0);
  return [...kept, { label: 'Other', color: 'series-neutral', value: rest }];
}

/**
 * Spending totals keyed by category id, resolved into labelled, coloured rows
 * ordered largest first.
 *
 * @param {Map<string, number>} totals
 * @param {Map<string, {name: string, color: string}>} categoriesById
 */
export function toCategoryRows(totals, categoriesById) {
  return [...totals.entries()]
    .map(([categoryId, value]) => ({
      label: categoriesById.get(categoryId)?.name ?? 'Uncategorised',
      color: categoriesById.get(categoryId)?.color ?? 'series-neutral',
      value,
    }))
    .sort((a, b) => b.value - a.value);
}
