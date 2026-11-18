// Run with `pnpm test`; dependency-free like money.test.ts.
import assert from 'node:assert/strict'
import {
  categoryMode,
  evalAmount,
  findCategory,
  foreignAccount,
  formatDate,
  matchScore,
  newRow,
  parseDate,
  rowFromTransaction,
  rowStatus,
  rowsFromTransactions,
  runningBalances,
  splitLinesOf,
  syncRows,
  toInput,
  validateRow,
  withSplits,
} from './register.ts'
import type { CategoryRef, Context, Transaction } from './register.ts'

// ---------- dates
const today = new Date(2026, 10, 17) // 2026-11-17
assert.equal(parseDate('t', today), '2026-11-17')
assert.equal(parseDate('今天', today), '2026-11-17')
assert.equal(parseDate('y', today), '2026-11-16')
assert.equal(parseDate('-17', today), '2026-10-31')
assert.equal(parseDate('+14', today), '2026-12-01')
assert.equal(parseDate('5', today), '2026-11-05')
assert.equal(parseDate('2/29', today), null)
assert.equal(parseDate('12/31', today), '2026-12-31')
assert.equal(parseDate('2025-1-2', today), '2025-01-02')
assert.equal(parseDate('2025/13/1', today), null)
assert.equal(parseDate('abc', today), null)
assert.equal(formatDate('2026-11-05', today), '11/05')
assert.equal(formatDate('2025-11-05', today), '2025/11/05')

// ---------- amounts
assert.equal(evalAmount('1,280', 0), 1280)
assert.equal(evalAmount('120*3', 0), 360)
assert.equal(evalAmount('(450+30)/2', 0), 240)
assert.equal(evalAmount('10/3', 2), 333)
assert.equal(evalAmount('-5+2', 0), -3)
assert.equal(evalAmount('1/0', 0), null)
assert.equal(evalAmount('2*', 0), null)
assert.equal(evalAmount('abc', 0), null)
assert.equal(evalAmount('', 0), 0)

// ---------- matching
assert.ok(matchScore('外食', '飲食/外食') > matchScore('外食', '外面的食物'))
assert.ok(matchScore('ys', '飲食/ys') > 0)
assert.equal(matchScore('xyz', '飲食'), -1)

// ---------- rows
const bank = 'bank'
const card = 'card'
const loan = 'loan'
const food = 'food'
const ctx: Context = {
  minorUnits: 0,
  accounts: new Map([
    [bank, { id: bank, name: '台新', onBudget: true, closed: false }],
    [card, { id: card, name: '玉山卡', onBudget: true, closed: false }],
    [loan, { id: loan, name: '車貸', onBudget: false, closed: false }],
  ]),
  categories: new Map(),
}
const entry = (
  accountId: string,
  categoryId: string | null,
  amount: number,
): Transaction['entries'][number] => ({
  id: `${accountId}-${amount}`,
  accountId,
  categoryId,
  amount,
  memo: '',
  cleared: 'uncleared',
})
const tx = (
  id: string,
  entries: Transaction['entries'],
  extra: Partial<Transaction> = {},
): Transaction => ({
  id,
  date: '2026-11-03',
  payeeId: null,
  payeeName: null,
  note: '',
  needsReview: false,
  isOpening: false,
  entries,
  ...extra,
})

// An expense round-trips unchanged.
const lunch = tx('lunch', [entry(card, food, -2400)], { payeeName: '鼎泰豐' })
const lunchRow = rowFromTransaction(lunch, card)
assert.equal(lunchRow.categoryId, food)
assert.equal(lunchRow.amount, -2400)
assert.equal(rowStatus(lunchRow, ctx), 'clean')
assert.equal(rowStatus({ ...lunchRow, note: '聚餐' }, ctx), 'changed')
assert.equal(rowStatus({ ...lunchRow, deleted: true }, ctx), 'deleted')

// A transfer seen from either side, and rebuilt with both entries.
const pay = tx('pay', [entry(bank, null, -2400), entry(card, null, 2400)])
const fromCard = rowFromTransaction(pay, card)
assert.equal(fromCard.transferTo, bank)
assert.equal(fromCard.amount, 2400)
assert.equal(categoryMode(fromCard, ctx), 'none')
assert.equal(rowStatus(fromCard, ctx), 'clean')
assert.deepEqual(
  toInput({ ...fromCard, amount: 3000 }, ctx).entries.map((e) => [
    e.accountId,
    e.amount,
  ]),
  [
    [card, 3000],
    [bank, -3000],
  ],
)

// Money to a tracking account needs a category, on the budget side.
const principal = newRow('p', '2026-11-10', bank)
const toLoan = { ...principal, transferTo: loan, amount: -8500 }
assert.equal(categoryMode(toLoan, ctx), 'required')
assert.equal(validateRow(toLoan, ctx)?.field, 'category')
const entries = toInput({ ...toLoan, categoryId: food }, ctx).entries
assert.deepEqual(
  entries.map((e) => [e.accountId, e.categoryId, e.amount]),
  [
    [bank, food, -8500],
    [loan, null, 8500],
  ],
)
// Seen from the loan, the same transaction shows the budget side's category.
const fromLoan = rowFromTransaction(
  tx('p', [entry(bank, food, -8500), entry(loan, null, 8500)]),
  loan,
)
assert.equal(fromLoan.categoryId, food)
assert.equal(rowStatus(fromLoan, ctx), 'clean')

// Budget accounts need a category; tracking accounts never send one.
assert.equal(
  validateRow({ ...newRow('x', '2026-11-01', bank), amount: -1 }, ctx)?.field,
  'category',
)
assert.equal(
  validateRow({ ...newRow('x', '2026-11-01', bank), amount: 0 }, ctx),
  null,
)
assert.equal(
  toInput(
    { ...newRow('x', '2026-11-01', loan), categoryId: food, amount: 5 },
    ctx,
  ).entries[0].categoryId,
  null,
)

// A split is one line per entry; clearing it clears every line.
const split = tx('s', [entry(card, food, -100), entry(card, 'other', -50)])
const splitRow = rowFromTransaction(split, card)
assert.equal(splitRow.splits?.length, 2)
assert.equal(splitRow.locked, null)
assert.equal(splitRow.amount, -150)
assert.equal(categoryMode(splitRow, ctx), 'split')
assert.equal(rowStatus(splitRow, ctx), 'clean')
assert.deepEqual(
  toInput({ ...splitRow, cleared: 'cleared' }, ctx).entries.map(
    (e) => e.cleared,
  ),
  ['cleared', 'cleared'],
)

// A loan payment: principal moves to the loan, interest is an expense.
const payment = tx('lp', [
  entry(bank, 'principal', -8500),
  entry(bank, 'interest', -1500),
  entry(loan, null, 8500),
])
const fromBank = rowFromTransaction(payment, bank)
assert.deepEqual(
  fromBank.splits?.map((l) => [l.transferTo, l.categoryId, l.amount]),
  [
    [loan, 'principal', -8500],
    [null, 'interest', -1500],
  ],
)
assert.equal(rowStatus(fromBank, ctx), 'clean')
// Seen from the loan the entries do not pair up: edited from the bank.
const paymentFromLoan = rowFromTransaction(payment, loan)
assert.equal(paymentFromLoan.locked, 'foreign')
assert.equal(paymentFromLoan.amount, 8500)
assert.equal(foreignAccount(paymentFromLoan), bank)
assert.equal(rowStatus(paymentFromLoan, ctx), 'clean')

// Turning a row into a split and back.
const groceries = {
  ...newRow('g', '2026-11-04', card),
  payee: '全聯',
  categoryId: food,
  amount: -1730,
}
const [first] = splitLinesOf(groceries, () => 'l1')
assert.deepEqual([first.categoryId, first.amount], [food, -1730])
const twoLines = withSplits(groceries, [
  { ...first, amount: -1280 },
  {
    id: 'l2',
    transferTo: null,
    categoryId: 'home',
    memo: '衛生紙',
    amount: -450,
    counterCleared: 'uncleared',
  },
  {
    id: 'l3',
    transferTo: null,
    categoryId: null,
    memo: '',
    amount: 0,
    counterCleared: 'uncleared',
  },
])
assert.equal(twoLines.splits?.length, 2)
assert.equal(twoLines.amount, -1730)
assert.equal(twoLines.categoryId, null)
assert.deepEqual(
  toInput(twoLines, ctx).entries.map((e) => [e.categoryId, e.memo]),
  [
    [food, ''],
    ['home', '衛生紙'],
  ],
)
const backToOne = withSplits(twoLines, [{ ...first, amount: -999 }])
assert.equal(backToOne.splits, null)
assert.deepEqual([backToOne.categoryId, backToOne.amount], [food, -999])
// Each line needs its category on a budget account.
assert.equal(
  validateRow(
    withSplits(groceries, [
      first,
      { ...first, id: 'l2', categoryId: null, amount: -5 },
    ]),
    ctx,
  )?.message,
  '拆分第 2 行：需要類別',
)

// Running balances: display order is newest first; deleted rows count 0.
const rows = [
  { ...newRow('c', '2026-11-05', card), amount: -30 },
  { ...newRow('b', '2026-11-03', card), amount: -20, deleted: true },
  { ...newRow('a', '2026-11-01', card), amount: 100 },
]
assert.deepEqual(runningBalances(rows), [70, 100, 100])
// On one day the opening balance counts first, wherever it is on screen.
const opening = rowFromTransaction(
  tx('o', [entry(card, 'open', -8640)], {
    date: '2026-11-01',
    isOpening: true,
  }),
  card,
)
assert.deepEqual(
  runningBalances([
    opening,
    { ...newRow('n1', '2026-11-01', card), amount: -1730 },
    { ...newRow('n2', '2026-11-01', card), amount: -5000 },
  ]),
  [-8640, -15370, -13640],
)

// Categories by path, or by a name that is unique.
const cats: Array<CategoryRef> = [
  {
    id: '1',
    path: '飲食',
    name: '飲食',
    kind: 'expense',
    archived: false,
    isSystem: false,
  },
  {
    id: '2',
    path: '飲食/外食',
    name: '外食',
    kind: 'expense',
    archived: false,
    isSystem: false,
  },
  {
    id: '3',
    path: '交通/外食',
    name: '外食',
    kind: 'expense',
    archived: false,
    isSystem: false,
  },
  {
    id: '4',
    path: '期初餘額',
    name: '期初餘額',
    kind: 'income',
    archived: false,
    isSystem: true,
  },
]
assert.equal(findCategory('飲食/外食', cats)?.id, '2')
assert.equal(findCategory('外食', cats), null)
assert.equal(findCategory('飲食', cats)?.id, '1')
assert.equal(findCategory('期初餘額', cats), null)

// ---------- registers of several accounts (ADR-071)
const both = new Set([bank, card])
const multi = rowsFromTransactions([lunch, pay], [bank, card])
// Newest first; the card payment is on both of its accounts.
assert.deepEqual(
  multi.map((r) => [r.id, r.accountId, r.amount]),
  [
    ['pay', card, 2400],
    ['pay', bank, -2400],
    ['lunch', card, -2400],
  ],
)
assert.equal(new Set(multi.map((r) => r.key)).size, 3)
// Changing one side rebuilds the other.
const paidMore = syncRows(
  multi.with(0, { ...multi[0], amount: 3000 }),
  0,
  ctx,
  both,
)
assert.deepEqual(
  paidMore.map((r) => [r.key, r.amount]),
  [
    [multi[0].key, 3000],
    [multi[1].key, -3000],
    [multi[2].key, -2400],
  ],
)
assert.equal(rowStatus(paidMore[1], ctx), 'changed')
const entriesOf = (row: (typeof paidMore)[number]) =>
  toInput(row, ctx).entries.toSorted((x, y) =>
    x.accountId.localeCompare(y.accountId),
  )
assert.deepEqual(entriesOf(paidMore[0]), entriesOf(paidMore[1]))
// Paying from the loan instead: the bank row goes (the loan is not shown).
const fromLoanNow = syncRows(
  multi.with(0, { ...multi[0], transferTo: loan, categoryId: food }),
  0,
  ctx,
  both,
)
assert.deepEqual(
  fromLoanNow.map((r) => r.id),
  ['pay', 'lunch'],
)
// Deleting one side deletes the other.
const gone = syncRows(
  multi.with(1, { ...multi[1], deleted: true }),
  1,
  ctx,
  both,
)
assert.deepEqual(
  gone.map((r) => r.deleted),
  [true, true, false],
)
// A new transfer gets a row on the other account when it is shown.
const fresh = {
  ...newRow('n', '2026-11-06', bank),
  transferTo: card,
  amount: -100,
}
const withOther = syncRows([fresh], 0, ctx, both)
assert.deepEqual(
  withOther.map((r) => [r.accountId, r.amount, r.base]),
  [
    [bank, -100, null],
    [card, 100, null],
  ],
)

console.log('register: ok')
