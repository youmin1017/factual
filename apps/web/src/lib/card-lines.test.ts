// Run with: node --experimental-strip-types src/lib/card-lines.test.ts
import assert from 'node:assert/strict'
import {
  cardCellNumeric,
  cardCellOptions,
  cardCellPatch,
  cardCellText,
  cardFromValues,
  cardLines,
  cardValuesOf,
} from './card-lines.ts'
import type { CardCell, CardRefs } from './card-lines.ts'

const refs: CardRefs = { payers: new Map([['bank', '台新']]), minorUnits: 0 }
const cell = (key: CardCell['key']): CardCell =>
  cardLines.flatMap((l) => l.cells).find((c) => c.key === key) as CardCell
const ok = <T>(x: T | string): T => {
  assert.notEqual(typeof x, 'string', String(x))
  return x as T
}

// Two settings to a line, as a loan's terms.
assert.deepEqual(
  cardLines.map((l) => l.cells.map((c) => c.key)),
  [
    ['statementDay', 'dueDay'],
    ['limit', 'autopay'],
  ],
)

// Saved settings read into the lines and back.
const saved = {
  statementDay: 5,
  dueDay: 20,
  creditLimit: 80000,
  autopayAccountId: 'bank',
}
const v = cardValuesOf(saved, 0)
assert.deepEqual(v, {
  statementDay: '5',
  dueDay: '20',
  limit: '80000',
  autopay: 'bank',
})
assert.deepEqual(cardFromValues(v, 0), saved)
assert.equal(cardCellText(v, cell('autopay'), refs), '台新')
assert.equal(
  cardCellText(cardValuesOf(null, 0), cell('autopay'), refs),
  '不扣繳',
)

// Typing and picking.
assert.equal(ok(cardCellPatch(v, cell('dueDay'), ' 25 ', refs)).dueDay, '25')
assert.equal(typeof cardCellPatch(v, cell('dueDay'), '32', refs), 'string')
assert.equal(
  typeof cardCellPatch(v, cell('statementDay'), '5日', refs),
  'string',
)
assert.equal(
  ok(cardCellPatch(v, cell('limit'), '100,000', refs)).limit,
  '100000',
)
assert.equal(ok(cardCellPatch(v, cell('limit'), '', refs)).limit, '')
assert.equal(ok(cardCellPatch(v, cell('autopay'), '不扣繳', refs)).autopay, '')
assert.equal(typeof cardCellPatch(v, cell('autopay'), '玉山', refs), 'string')
assert.deepEqual(
  cardCellOptions(cell('autopay'), refs)?.map((o) => o.label),
  ['不扣繳', '台新'],
)
assert.equal(cardCellOptions(cell('limit'), refs), null)
// The limit is an amount: typed and shown with the user's grouping (ADR-122).
assert.equal(cardCellNumeric(cell('limit')), 'amount')
assert.equal(cardCellNumeric(cell('dueDay')), 'number')
assert.equal(cardCellNumeric(cell('autopay')), null)

// Nothing filled in is no settings; half filled in is not complete.
assert.equal(cardFromValues(cardValuesOf(null, 0), 0), null)
assert.equal(typeof cardFromValues({ ...v, dueDay: '' }, 0), 'string')

console.log('card-lines: ok')
