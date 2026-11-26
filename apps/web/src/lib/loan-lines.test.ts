// Run with: node --experimental-strip-types src/lib/loan-lines.test.ts
import assert from 'node:assert/strict'
import {
  addRate,
  loanCellLocked,
  loanCellOptions,
  loanCellPatch,
  loanCellText,
  loanLines,
  removeRate,
} from './loan-lines.ts'
import { loanFieldValues } from './loan.ts'
import type { LoanCell, LoanRefs } from './loan-lines.ts'

const today = new Date(2026, 10, 20)
const refs: LoanRefs = {
  payers: new Map([['bank', '台新']]),
  categories: new Map([
    ['p', '房貸/本金'],
    ['i', '房貸/利息'],
  ]),
  minorUnits: 0,
}
const blank = loanFieldValues(null, 0, '2026-11-20')
type V = typeof blank
const cell = (key: LoanCell['key'], rate?: number): LoanCell =>
  loanLines({ ...blank, payFrom: 'bank' })
    .flatMap((l) => l.cells)
    .find((c) => c.key === key && c.rate === rate) as LoanCell
const patch = (v: V, key: LoanCell['key'], text: string, rate?: number) =>
  loanCellPatch(v, cell(key, rate), text, refs, today)

// Two related terms to a line; categories and the holiday rule only with an
// account to pay from.
assert.deepEqual(
  loanLines(blank).map((l) => l.cells.map((c) => c.key)),
  [
    ['principal', 'months'],
    ['start', 'firstPayment'],
    ['method', 'grace'],
    ['rateFrom', 'rate'],
    ['payFrom', 'prepay'],
  ],
)
assert.equal(loanLines({ ...blank, payFrom: 'bank' }).length, 7)

// Numbers are typed as numbers; the label says the unit.
let v = patch(blank, 'principal', '1,000,000') as V
assert.equal(v.principal, '1000000')
assert.equal((patch(v, 'months', '240') as V).months, '240')
assert.equal(typeof patch(v, 'months', '20年'), 'string')
assert.equal((patch(v, 'grace', '12') as V).grace, '12')
assert.equal(typeof patch(v, 'months', '0'), 'string')
assert.equal(cell('months').label, '期數（月）')
// A new 撥款日 moves the first payment along when it followed it.
const moved = patch(v, 'start', '2025/1/10') as V
assert.equal(moved.start, '2025-01-10')
assert.equal(moved.firstPayment, '2025-02-10')

// Choices are picked by their label.
assert.equal((patch(v, 'method', '本金平均攤還') as V).method, 'equalPrincipal')
assert.equal(typeof patch(v, 'method', '亂寫'), 'string')
assert.equal((patch(v, 'payFrom', '台新') as V).payFrom, 'bank')
assert.equal(
  (patch(v, 'principalCategory', '房貸/本金') as V).principalCategory,
  'p',
)
assert.deepEqual(
  loanCellOptions(cell('payFrom'), refs)?.map((o) => o.label),
  ['不自動還款', '台新'],
)
assert.equal(loanCellOptions(cell('principal'), refs), null)

// Rates: the first from 撥款日; changes added after a line and removed again.
assert.ok(loanCellLocked(cell('rateFrom', 0)))
assert.equal(loanCellLocked(cell('rate', 0)), null)
assert.equal(typeof patch(v, 'rate', '2.35%', 0), 'string')
v = patch(v, 'rate', '2.35', 0) as V
assert.equal(v.rates[0].rate, '2.35')
v = addRate(v, 0, '2026-07-01')
assert.deepEqual(v.rates[1], { from: '2026-07-01', rate: '2.35' })
assert.equal(
  loanCellText(v, { key: 'rateFrom', label: '', rate: 1 }, refs),
  '2026/07/01',
)
assert.equal(typeof removeRate(v, 0), 'string')
assert.equal((removeRate(v, 1) as V).rates.length, 1)

console.log('loan-lines: ok')
