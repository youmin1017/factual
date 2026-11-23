// Run with: node --experimental-strip-types src/lib/card.test.ts
import assert from 'node:assert/strict'
import { billingText, deferPlan, rowStatement } from './card.ts'
import { rowFromTransaction } from './register.ts'
import type { CardStatements } from './card.ts'
import type { Transaction } from './register.ts'

const card = 'card'
const now = new Date(2026, 11, 10) // 2026-12-10
const tx = (
  id: string,
  date: string,
  statementId: string | null,
): Transaction => ({
  id,
  date,
  payeeId: null,
  payeeName: '店家',
  note: '',
  needsReview: false,
  isOpening: false,
  entries: [
    {
      id: `${id}-e`,
      accountId: card,
      categoryId: 'food',
      amount: -100,
      memo: '',
      cleared: 'uncleared',
      statementId,
    },
  ],
})
const statement = (id: string, end: string) => ({
  id,
  periodStart: '',
  periodEnd: end,
  dueDate: '',
  previousDue: 0,
  charges: 0,
  payments: 0,
  amountDue: 0,
  computedDue: 0,
  adjusted: false,
  paid: 0,
  remaining: 0,
  state: 'due' as const,
})
const data: CardStatements = {
  card: {
    statementDay: 5,
    dueDay: 25,
    creditLimit: null,
    autopayAccountId: null,
  },
  open: {
    id: 'open',
    periodStart: '2026-12-06',
    periodEnd: '2027-01-05',
    dueDate: '2027-01-25',
    charges: 0,
    payments: 0,
  },
  statements: [statement('dec', '2026-12-05'), statement('nov', '2026-11-05')],
}

const inDec = rowFromTransaction(tx('a', '2026-12-04', 'dec'), card)
const inNov = rowFromTransaction(tx('b', '2026-11-01', 'nov'), card)
const late = rowFromTransaction(tx('c', '2026-12-03', null), card)
const fresh = rowFromTransaction(tx('d', '2026-12-08', null), card)

assert.equal(rowStatement(inDec), 'dec')
assert.equal(rowStatement(late), null)
assert.equal(
  billingText(inDec, data, now),
  '列在 12/05 結帳的帳單（:defer 移到下一期）',
)
assert.equal(billingText(inNov, data, now), '列在 11/05 結帳的帳單')
assert.equal(
  billingText(late, data, now),
  '還沒列入帳單，2027/01/05 結帳時列入（:defer 放回 12/05 那期）',
)
assert.equal(billingText(fresh, data, now), '本期消費，2027/01/05 結帳時列入')
assert.equal(billingText({ ...fresh, base: null }, data, now), null)

// :defer: out of the latest statement first; else back into it.
assert.deepEqual(deferPlan([inDec, late], card, data), {
  billed: false,
  ids: ['a'],
})
assert.deepEqual(deferPlan([late, fresh], card, data), {
  billed: true,
  ids: ['c'],
})
assert.equal(typeof deferPlan([inNov, fresh], card, data), 'string')
assert.equal(
  typeof deferPlan([inDec], card, { ...data, statements: [] }),
  'string',
)

console.log('card: ok')
