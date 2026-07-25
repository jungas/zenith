/** Chart geometry that is pure maths and worth pinning. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { niceScale } from '../src/ui/charts.js';
import { foldToOther } from '../src/views/chart-data.js';

test('axis ticks are always round numbers', () => {
  for (const value of [1, 99, 100, 479, 2_523, 4_730, 6_600, 17_600, 165_044, 9_999_999]) {
    const { max, ticks } = niceScale(value);
    assert.ok(max >= value, `${value}: max ${max} must cover the data`);
    assert.equal(ticks[0], 0, 'starts at zero');
    assert.equal(ticks.at(-1), max, 'ends at the maximum');
    // A range of a few cents degenerates to [0, max]; anything realistic gets
    // three or more gridlines.
    assert.ok(ticks.length >= 2 && ticks.length <= 7, `${value}: ${ticks.length} ticks is unreadable`);
    if (value >= 100) assert.ok(ticks.length >= 3, `${value}: too few gridlines`);

    // Every step is identical and a round number: 1, 2, 2.5 or 5 × a power of ten.
    const step = ticks[1] - ticks[0];
    for (let i = 1; i < ticks.length; i++) {
      assert.equal(ticks[i] - ticks[i - 1], step, `${value}: uneven steps`);
    }
    const magnitude = 10 ** Math.floor(Math.log10(step));
    assert.ok(
      [1, 2, 2.5, 5, 10].some((c) => Math.abs(step / magnitude - c) < 1e-9),
      `${value}: step ${step} is not a round number`,
    );
  }
});

test('an empty or negative range still yields a usable axis', () => {
  for (const value of [0, -5, Number.NaN]) {
    const { max, ticks } = niceScale(value);
    assert.ok(max > 0);
    assert.ok(ticks.length > 1);
  }
});

test('a ninth series folds into Other rather than inventing a hue', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    label: `Cat ${i}`,
    color: `series-${(i % 8) + 1}`,
    value: 1_200 - i * 100,
  }));
  const folded = foldToOther(rows, 8);

  assert.equal(folded.length, 8);
  assert.equal(folded.at(-1).label, 'Other');
  assert.equal(folded.at(-1).color, 'series-neutral');
  // Nothing is lost in the fold.
  assert.equal(
    folded.reduce((total, row) => total + row.value, 0),
    rows.reduce((total, row) => total + row.value, 0),
  );
});

test('a set inside the cap is passed through untouched', () => {
  const rows = [{ label: 'A', color: 'series-1', value: 10 }];
  assert.equal(foldToOther(rows, 8), rows);
});
