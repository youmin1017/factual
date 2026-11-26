// Run with: node --experimental-strip-types src/lib/split.test.ts
import assert from 'node:assert/strict'
import {
  applySplitForm,
  divide,
  effectOf,
  needs,
  newSplitRow,
  parseTotal,
  rowFromExpense,
  runningBalances,
  sharesOf,
  splitCellText,
  splitFormFields,
  splitFormValues,
  splitPatch,
  splitStatus,
  toSplitInput,
  validateSplit,
} from './split.ts'
import type { Context } from './register.ts'
import type { People, SharedExpense, SplitRow } from './split.ts'

const people: People = { me: 'me', friend: 'ming', friendName: '小明' }
const ctx: Context = {
  accounts: new Map([
    ['bank', { id: 'bank', name: '台新', onBudget: true, closed: false }],
    ['loan', { id: 'loan', name: '車貸', onBudget: false, closed: false }],
  ]),
  categories: new Map([
    [
      'food',
      {
        id: 'food',
        path: '飲食',
        name: '飲食',
        kind: 'expense',
        archived: false,
        isSystem: false,
      },
    ],
  ]),
  minorUnits: 0,
}
const today = new Date(2026, 10, 20)

function row(extra: Partial<SplitRow>): SplitRow {
  return {
    ...newSplitRow('x', '2026-11-05', 'bank', 'food'),
    description: '晚餐',
    total: 2400,
    ...extra,
  }
}

// divide matches the server's (split_test.go).
assert.deepEqual(divide(1001, [1, 1]), [501, 500])
assert.deepEqual(divide(100, [1, 1, 1]), [34, 33, 33])
assert.deepEqual(divide(10, [1, 2]), [3, 7])
assert.deepEqual(divide(999, [400000, 600000]), [400, 599])
assert.deepEqual(divide(7, [0, 3]), [0, 7])
assert.deepEqual(
  divide(9_000_000_000_000, [999_900_000_000, 1]),
  [8_999_999_999_991, 9],
)

// Shares and what the friend owes.
assert.deepEqual(sharesOf(row({})), [1200, 1200])
assert.equal(effectOf(row({})), 1200)
assert.deepEqual(
  sharesOf(row({ method: 'shares', weights: [2, 1], total: 1000 })),
  [667, 333],
)
assert.equal(
  effectOf(
    row({ method: 'shares', weights: [2, 1], total: 1000, payer: 'friend' }),
  ),
  -667,
)
assert.equal(sharesOf(row({ method: 'percent', weights: [50, 40] })), null)
assert.deepEqual(sharesOf(row({ method: 'exact', myShare: 400 })), [400, 2000])
assert.equal(sharesOf(row({ method: 'exact', myShare: 3000 })), null)
// A settlement: Ming pays me 500 back.
const back = row({ settlement: true, payer: 'friend', total: 500 })
assert.equal(effectOf(back), -500)
assert.deepEqual(needs(back), { account: true, category: false })
assert.deepEqual(needs(row({ payer: 'friend' })), {
  account: false,
  category: true,
})
assert.deepEqual(
  runningBalances([
    row({
      id: 'b',
      date: '2026-11-10',
      settlement: true,
      payer: 'friend',
      total: 1200,
    }),
    row({ id: 'a', date: '2026-11-05' }),
  ]),
  [0, 1200],
)

// The split form: a line's values, its fields, and what they change.
function patchOf(x: Partial<SplitRow> | string): Partial<SplitRow> {
  assert.notEqual(typeof x, 'string', String(x))
  return x as Partial<SplitRow>
}
const currencies = [
  { value: 'JPY', label: '日圓' },
  { value: 'USD', label: '美元' },
]
const fieldKeys = (values: Record<string, string>) =>
  splitFormFields(values, people, currencies).map((f) => f.key)
const plain = splitFormValues(row({}), 0)
assert.deepEqual(fieldKeys(plain), ['kind', 'payer', 'method', 'currency'])
assert.deepEqual(fieldKeys({ ...plain, payer: 'both', method: 'shares' }), [
  'kind',
  'payer',
  'myPaid',
  'method',
  'myWeight',
  'theirWeight',
  'currency',
])
assert.deepEqual(fieldKeys({ ...plain, kind: 'settlement', currency: 'JPY' }), [
  'kind',
  'payer',
  'currency',
  'foreign',
])
assert.deepEqual(
  applySplitForm(row({}), { ...plain, method: 'exact', myShare: '300' }, 0),
  {
    settlement: false,
    payer: 'me',
    myPaid: null,
    method: 'exact',
    myShare: 300,
    weights: null,
    foreign: null,
  },
)
assert.deepEqual(
  patchOf(
    applySplitForm(
      row({}),
      { ...plain, method: 'percent', myPercent: '40' },
      0,
    ),
  ).weights,
  [40, 60],
)
assert.deepEqual(
  applySplitForm(
    row({}),
    { ...plain, method: 'shares', myWeight: '2', theirWeight: '1' },
    0,
  ),
  {
    settlement: false,
    payer: 'me',
    myPaid: null,
    method: 'shares',
    myShare: null,
    weights: [2, 1],
    foreign: null,
  },
)
assert.deepEqual(
  patchOf(
    applySplitForm(row({}), { ...plain, payer: 'both', myPaid: '1000' }, 0),
  ).myPaid,
  1000,
)
assert.equal(
  typeof applySplitForm(
    row({}),
    { ...plain, payer: 'both', myPaid: '2400' },
    0,
  ),
  'string',
)
assert.equal(
  typeof applySplitForm(
    row({}),
    { ...plain, method: 'percent', myPercent: '120' },
    0,
  ),
  'string',
)
assert.deepEqual(
  patchOf(
    applySplitForm(row({}), { ...plain, currency: 'JPY', foreign: '3000' }, 0),
  ).foreign,
  { currency: 'JPY', amount: 3000 },
)
assert.equal(
  typeof applySplitForm(row({}), { ...plain, currency: 'USD', foreign: '' }, 0),
  'string',
)
const settled = applySplitForm(
  row({}),
  { ...plain, kind: 'settlement', payer: 'friend' },
  0,
)
assert.equal(typeof settled, 'object')
assert.equal(effectOf(row(settled as Partial<SplitRow>)), -2400)
// Opening the form on a line and taking it unchanged changes nothing.
for (const r of [
  row({ method: 'exact', myShare: 300 }),
  row({ method: 'percent', weights: [40, 60] }),
  row({ method: 'shares', weights: [2, 1], payer: 'both', myPaid: 1000 }),
  row({ settlement: true, method: 'exact', payer: 'friend' }),
  row({ foreign: { currency: 'USD', amount: 1250 } }),
]) {
  const patch = applySplitForm(r, splitFormValues(r, 0), 0)
  assert.notEqual(typeof patch, 'string')
  assert.equal(
    splitStatus({ ...r, ...(patch as Partial<SplitRow>), base: null }, people),
    'new',
  )
  assert.deepEqual(
    toSplitInput({ ...r, ...(patch as Partial<SplitRow>) }, people),
    toSplitInput(r, people),
  )
}
assert.equal(
  splitCellText(row({ payer: 'both', myPaid: 1000 }), 'paidBy', ctx, people),
  '我 1000',
)
assert.deepEqual(parseTotal('2,400', 0), { total: 2400 })
assert.equal(typeof parseTotal('JPY 3000', 0), 'string')
assert.deepEqual(splitPatch('account', '台新', ctx, today), {
  accountId: 'bank',
})
assert.equal(typeof splitPatch('account', '車貸', ctx, today), 'string')
assert.deepEqual(splitPatch('date', '11/7', ctx, today), { date: '2026-11-07' })

// What is sent: the caller first in the shares, account and category only
// when they are needed.
assert.deepEqual(toSplitInput(row({ payer: 'friend' }), people), {
  id: 'x',
  kind: 'expense',
  date: '2026-11-05',
  description: '晚餐',
  note: '',
  total: 2400,
  splitMethod: 'equal',
  payers: [{ userId: 'ming', amount: 2400 }],
  shares: [{ userId: 'me' }, { userId: 'ming' }],
  categoryId: 'food',
})
assert.deepEqual(
  toSplitInput(
    row({ payer: 'both', myPaid: 1000, method: 'shares', weights: [2, 1] }),
    people,
  ).payers,
  [
    { userId: 'me', amount: 1000 },
    { userId: 'ming', amount: 1400 },
  ],
)
assert.deepEqual(toSplitInput(back, people), {
  id: 'x',
  kind: 'settlement',
  date: '2026-11-05',
  description: '晚餐',
  note: '',
  total: 500,
  splitMethod: 'exact',
  payers: [{ userId: 'ming', amount: 500 }],
  shares: [],
  accountId: 'bank',
})

// Validation, field by field.
assert.equal(validateSplit(row({}), ctx), null)
assert.equal(
  validateSplit(row({ description: ' ' }), ctx)?.field,
  'description',
)
assert.equal(validateSplit(row({ total: null }), ctx)?.field, 'amount')
assert.equal(
  validateSplit(row({ payer: 'both', myPaid: 2400 }), ctx)?.field,
  'paidBy',
)
assert.equal(
  validateSplit(row({ settlement: true, payer: 'both', myPaid: 1 }), ctx)
    ?.message,
  '還款只有一個人付',
)
assert.equal(
  validateSplit(row({ method: 'percent', weights: [50, 40] }), ctx)?.field,
  'split',
)
assert.equal(validateSplit(row({ accountId: null }), ctx)?.field, 'account')
assert.equal(validateSplit(row({ accountId: 'loan' }), ctx)?.field, 'account')
assert.equal(validateSplit(row({ categoryId: null }), ctx)?.field, 'category')
assert.equal(
  validateSplit(row({ payer: 'friend', accountId: null }), ctx),
  null,
)

// A saved expense reads back into the same line.
const saved: SharedExpense = {
  id: 'x',
  kind: 'expense',
  date: '2026-11-06',
  description: '計程車',
  note: '',
  currency: 'TWD',
  total: 1000,
  foreign: null,
  splitMethod: 'shares',
  payers: [{ userId: 'ming', amount: 1000 }],
  shares: [
    { userId: 'me', amount: 667, weight: 2 },
    { userId: 'ming', amount: 333, weight: 1 },
  ],
  recordedBy: 'me',
  mine: { transactionId: 't', accountId: null, categoryId: 'food' },
}
const loaded = rowFromExpense(saved, people)
assert.equal(loaded.payer, 'friend')
assert.deepEqual(loaded.weights, [2, 1])
assert.equal(splitStatus(loaded, people), 'clean')
assert.equal(splitStatus({ ...loaded, note: '機場' }, people), 'changed')
assert.equal(
  splitStatus(
    rowFromExpense(
      {
        ...saved,
        kind: 'settlement',
        splitMethod: 'exact',
        payers: [{ userId: 'me', amount: 300 }],
        shares: [
          { userId: 'me', amount: 0, weight: null },
          { userId: 'ming', amount: 300, weight: null },
        ],
        total: 300,
        mine: { transactionId: 't', accountId: 'bank', categoryId: null },
      },
      people,
    ),
    people,
  ),
  'clean',
)

console.log('split: ok')
