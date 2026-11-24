import assert from 'node:assert/strict'
import {
  checkGap,
  loanFieldValues,
  monthAfter,
  parseLoanFields,
  parseMonths,
  parseRate,
  problemField,
  rateText,
} from './loan.ts'
import type { LoanFieldValues, LoanTerms } from './loan.ts'

// ---------- dates and numbers
assert.equal(monthAfter('2026-01-10'), '2026-02-10')
assert.equal(monthAfter('2026-01-31'), '2026-02-28')
assert.equal(monthAfter('2026-12-15'), '2027-01-15')
assert.equal(monthAfter(''), '')
assert.equal(parseMonths('240'), 240)
assert.equal(parseMonths('20年'), 240)
assert.equal(parseMonths('7y'), 84)
assert.equal(parseMonths('二十年'), null)
assert.equal(parseRate('2.35'), 2.35)
assert.equal(parseRate('2.35%'), 2.35)
assert.equal(parseRate('1.12345'), null)
assert.equal(parseRate('101'), null)
assert.equal(rateText(2.35), '2.35')
assert.equal(rateText(2), '2')

// ---------- the form
const blank = loanFieldValues(null, 0, '2026-11-24')
assert.equal(blank.start, '2026-11-24')
assert.equal(blank.firstPayment, '2026-12-24')
assert.deepEqual(blank.rates, [{ from: '2026-11-24', rate: '' }])

const typed: LoanFieldValues = {
  ...blank,
  principal: '1,000,000',
  months: '20年',
  start: '2025-01-10',
  firstPayment: '2025-02-10',
  rates: [
    { from: '2026-11-24', rate: '2' },
    { from: '2026-01-11', rate: '2.25%' },
  ],
  payFrom: 'bank',
  principalCategory: 'p',
  interestCategory: 'i',
}
const terms = parseLoanFields(typed, 0) as LoanTerms
assert.equal(terms.principal, 1_000_000)
assert.equal(terms.termMonths, 240)
// The first rate follows 撥款日, whatever its own date said.
assert.deepEqual(terms.rates, [
  { effectiveFrom: '2025-01-10', annualRate: 2 },
  { effectiveFrom: '2026-01-11', annualRate: 2.25 },
])
assert.equal(terms.payFromAccountId, 'bank')
assert.equal(terms.interestCategoryId, 'i')

// Back to the form and again gives the same terms.
assert.deepEqual(
  parseLoanFields(loanFieldValues(terms, 0, '2026-11-24'), 0),
  terms,
)

const problem = (v: Partial<LoanFieldValues>) =>
  (parseLoanFields({ ...typed, ...v }, 0) as { field: string }).field
assert.equal(problem({ principal: '' }), 'principal')
assert.equal(problem({ months: '0' }), 'months')
assert.equal(problem({ firstPayment: '2025-01-10' }), 'firstPayment')
assert.equal(problem({ grace: '240' }), 'grace')
assert.equal(problem({ rates: [{ from: '', rate: 'x' }] }), 'rates')
assert.equal(
  problem({
    rates: [
      { from: '', rate: '2' },
      { from: '2024-12-01', rate: '2.1' },
    ],
  }),
  'rates',
)
assert.equal(problem({ interestCategory: '' }), 'interestCategory')
// Without an account to pay from, no categories are needed or sent.
const manual = parseLoanFields(
  { ...typed, payFrom: '', principalCategory: '', interestCategory: '' },
  0,
) as LoanTerms
assert.equal(manual.payFromAccountId, null)
assert.equal(manual.principalCategoryId, null)

assert.equal(problemField('firstPaymentDate'), 'firstPayment')
assert.equal(problemField(undefined), null)
assert.equal(
  checkGap({ date: '2026-11-10', computed: 900, recorded: 1000 }),
  100,
)
assert.equal(checkGap(null), 0)

console.log('loan: ok')
