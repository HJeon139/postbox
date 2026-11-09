// How a table block shows a cell (app/js/table-cells.mjs). A number column groups its digits, as an amount should,
// but a column whose label names a year or an id shows its whole numbers as written (#836). Only a label that is the
// name alone or ends with it counts: one where the name is followed by more words, or comes after a word such as
// “per”, “by” or “of”, labels an amount (#844).

import assert from 'node:assert/strict';
import test from 'node:test';
import { fmtCell } from '../app/js/table-cells.mjs';

test('#844 an amount per year keeps its thousands separators', () => {
  assert.equal(fmtCell(1234567, { id: 'revenue', label: 'Revenue per year' }), '1,234,567');
});

test('#844 an amount by year keeps its thousands separators', () => {
  assert.equal(fmtCell(1234567, { id: 'sales', label: 'Sales by year' }), '1,234,567');
});

test('#844 a count labeled “IDs found” keeps its thousands separators', () => {
  assert.equal(fmtCell(12345, { id: 'found', label: 'IDs found' }), '12,345');
});

test('#844 a count of IDs keeps its thousands separators', () => {
  assert.equal(fmtCell(12345, { id: 'count', label: 'Count of IDs' }), '12,345');
});

test('#844 a label that is an amount wins over an id that names a year', () => {
  assert.equal(fmtCell(1234567, { id: 'year', label: 'Revenue per year' }), '1,234,567');
});

test('#844 an unlabeled column whose id is an amount per year keeps its separators', () => {
  assert.equal(fmtCell(1234567, { id: 'revenue_per_year' }), '1,234,567');
});

test('#836 a column labeled “Year” shows a year as written', () => {
  assert.equal(fmtCell(2024, { id: 'y', label: 'Year' }), '2024');
});

test('#836 a column labeled “Fiscal year” shows a year as written', () => {
  assert.equal(fmtCell(2024, { id: 'fy', label: 'Fiscal year' }), '2024');
});

test('#836 a column labeled “Paper ID” shows an id as written', () => {
  assert.equal(fmtCell(123456, { id: 'pid', label: 'Paper ID' }), '123456');
});

test('#836 a column labeled “IDs” shows an id as written', () => {
  assert.equal(fmtCell(123456, { id: 'ids', label: 'IDs' }), '123456');
});

test('#836 an unlabeled column with the id “id” shows an id as written', () => {
  assert.equal(fmtCell(123456, { id: 'id' }), '123456');
});

test('#844 an unlabeled column with the id “paperId” shows an id as written', () => {
  assert.equal(fmtCell(123456, { id: 'paperId' }), '123456');
});

test('#836 a column of years shows a fraction with its separators', () => {
  assert.equal(fmtCell(1234.5, { id: 'year', label: 'Year' }), '1,234.5');
});

test('#836 a number column that names no year or id keeps its separators', () => {
  assert.equal(fmtCell(12345, { id: 'cites', label: 'Citations' }), '12,345');
});

test('#844 a year or id label with a note or punctuation after it shows as written', () => {
  assert.equal(fmtCell(2026, { id: 'y', label: 'Year (FY)' }), '2026');
  assert.equal(fmtCell(2026, { id: 'y', label: 'Year:' }), '2026');
  assert.equal(fmtCell(2026, { id: 'y', label: 'Year*' }), '2026');
  assert.equal(fmtCell(12345, { id: 'n', label: 'ID #' }), '12345');
});

test('#844 an amount per year with a unit after it keeps its separators', () => {
  assert.equal(fmtCell(1234567, { id: 'rev', label: 'Revenue per year (USD)' }), '1,234,567');
});

// Review of #1065: a label that starts with the singular name is still a name, a hyphen separates words, and a label
// that says nothing of a year, an id or an amount leaves it to the id.
for (const [label, id, v, want] of [
  ['Year founded', 'f', 2024, '2024'],
  ['Year built', 'b', 1999, '1999'],
  ['Year of birth', 'b', 1984, '1984'],
  ['ID number', 'n', 12345, '12345'],
  ['Fiscal-year', 'fy', 2024, '2024'],
  ['Paper-ID', 'p', 12345, '12345'],
  ['FY', 'year', 2024, '2024'],
  ['#', 'id', 12345, '12345'],
])
  test(`#844 “${label}” over the id “${id}” shows ${v} as written`, () => {
    assert.equal(fmtCell(v, { id, label }), want);
  });

for (const [label, v, want] of [
  ['IDs found', 12345, '12,345'],
  ['Revenue (per year)', 1234567, '1,234,567'],
  ['Years active', 12345, '12,345'],
])
  test(`#844 “${label}” keeps ${v}’s separators`, () => {
    assert.equal(fmtCell(v, { id: 'n', label }), want);
  });
