// Run with: node --experimental-strip-types src/lib/split.test.ts
import assert from 'node:assert/strict'
import {
  applySplitForm,
  describeLine,
  divide,
  effectOf,
  memberBalances,
  needs,
  newSplitRow,
  parseTotal,
  rowFromExpense,
  runningBalances,
  settleUp,
  sharesOf,
  splitCellText,
  splitFormFields,
  splitFormValues,
  splitPatch,
  splitStatus,
  splitText,
  toSplitInput,
  validateSplit,
} from './split.ts'
import type { Context } from './register.ts'
import type { People, SharedExpense, SplitRow } from './split.ts'

const people: People = {
  me: 'me',
  members: [
    { id: 'me', name: '我' },
    { id: 'ming', name: '小明' },
  ],
  friend: 'ming',
}
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

function row(extra: Partial<SplitRow>, who: People = people): SplitRow {
  return {
    ...newSplitRow('x', '2026-11-05', 'bank', 'food', who),
    description: '晚餐',
    total: 2400,
    ...extra,
  }
}
const list = (m: Map<string, number> | null) => (m ? [...m.values()] : null)

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

// ---------- with a friend (M12)

// Shares and what the friend owes.
assert.deepEqual(list(sharesOf(row({}), people)), [1200, 1200])
assert.equal(effectOf(row({}), people), 1200)
assert.deepEqual(
  list(
    sharesOf(
      row({ method: 'shares', weights: { me: 2, ming: 1 }, total: 1000 }),
      people,
    ),
  ),
  [667, 333],
)
assert.equal(
  effectOf(
    row({
      method: 'shares',
      weights: { me: 2, ming: 1 },
      total: 1000,
      payer: 'ming',
    }),
    people,
  ),
  -667,
)
// With a friend a percentage is the caller's; the friend has the rest.
assert.deepEqual(
  list(sharesOf(row({ method: 'percent', weights: { me: 40 } }), people)),
  [960, 1440],
)
assert.equal(
  sharesOf(row({ method: 'percent', weights: { me: 140 } }), people),
  null,
)
assert.deepEqual(
  list(sharesOf(row({ method: 'exact', amounts: { me: 400 } }), people)),
  [400, 2000],
)
assert.equal(
  sharesOf(row({ method: 'exact', amounts: { me: 3000 } }), people),
  null,
)
// A settlement: Ming pays me 500 back.
const back = row({ settlement: true, payer: 'ming', total: 500 })
assert.equal(effectOf(back, people), -500)
assert.deepEqual(needs(back, people), { account: true, category: false })
assert.deepEqual(needs(row({ payer: 'ming' }), people), {
  account: false,
  category: true,
})
assert.deepEqual(
  runningBalances(
    [
      row({
        id: 'b',
        date: '2026-11-10',
        settlement: true,
        payer: 'ming',
        total: 1200,
      }),
      row({ id: 'a', date: '2026-11-05' }),
    ],
    people,
  ),
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
const fieldKeys = (values: Record<string, string>, who: People = people) =>
  splitFormFields(values, who, currencies).map((f) => f.key)
const plain = splitFormValues(row({}), people, 0)
assert.deepEqual(fieldKeys(plain), ['kind', 'payer', 'method', 'currency'])
assert.deepEqual(fieldKeys({ ...plain, payer: 'several', method: 'shares' }), [
  'kind',
  'payer',
  'paid:me',
  'method',
  'w:me',
  'w:ming',
  'currency',
])
assert.deepEqual(fieldKeys({ ...plain, kind: 'settlement', currency: 'JPY' }), [
  'kind',
  'payer',
  'currency',
  'foreign',
])
const form = (values: Record<string, string>, r = row({}), who = people) =>
  applySplitForm(r, { ...plain, ...values }, who, 0)
assert.deepEqual(patchOf(form({ method: 'exact', 'amt:me': '300' })).amounts, {
  me: 300,
})
assert.deepEqual(patchOf(form({ method: 'percent', 'pct:me': '40' })).weights, {
  me: 40,
})
assert.deepEqual(
  patchOf(form({ method: 'shares', 'w:me': '2', 'w:ming': '1' })).weights,
  { me: 2, ming: 1 },
)
assert.deepEqual(patchOf(form({ payer: 'several', 'paid:me': '1000' })).paid, {
  me: 1000,
})
assert.equal(typeof form({ payer: 'several', 'paid:me': '2400' }), 'string')
assert.equal(typeof form({ method: 'percent', 'pct:me': '120' }), 'string')
assert.deepEqual(patchOf(form({ currency: 'JPY', foreign: '3000' })).foreign, {
  currency: 'JPY',
  amount: 3000,
})
assert.equal(typeof form({ currency: 'USD', foreign: '' }), 'string')
const settled = form({ kind: 'settlement', payer: 'ming' })
assert.equal(effectOf(row(patchOf(settled)), people), -2400)
// Opening the form on a line and taking it unchanged changes nothing.
for (const r of [
  row({ method: 'exact', amounts: { me: 300 } }),
  row({ method: 'percent', weights: { me: 40 } }),
  row({
    method: 'shares',
    weights: { me: 2, ming: 1 },
    payer: null,
    paid: { me: 1000 },
  }),
  row({ settlement: true, method: 'exact', payer: 'ming' }),
  row({ foreign: { currency: 'USD', amount: 1250 } }),
]) {
  const patch = applySplitForm(r, splitFormValues(r, people, 0), people, 0)
  assert.notEqual(typeof patch, 'string', String(patch))
  assert.deepEqual(
    toSplitInput({ ...r, ...(patch as Partial<SplitRow>) }, people),
    toSplitInput(r, people),
  )
}
assert.equal(
  splitCellText(
    row({ payer: null, paid: { me: 1000 } }),
    'paidBy',
    ctx,
    people,
  ),
  '我 1000',
)
assert.equal(
  splitText(row({ method: 'exact', amounts: { me: 300 } }), people, 0),
  '我 300',
)
assert.equal(
  splitText(row({ method: 'shares', weights: { me: 2, ming: 1 } }), people, 0),
  '2:1',
)
assert.equal(splitText(back, people, 0), '還款')
assert.deepEqual(parseTotal('2,400', 0), { total: 2400 })
assert.equal(typeof parseTotal('JPY 3000', 0), 'string')
assert.deepEqual(splitPatch('account', '台新', ctx, today), {
  accountId: 'bank',
})
assert.equal(typeof splitPatch('account', '車貸', ctx, today), 'string')
assert.deepEqual(splitPatch('date', '11/7', ctx, today), { date: '2026-11-07' })

// What is sent: the caller first in the shares, account and category only
// when they are needed; a settlement names its receiver.
assert.deepEqual(toSplitInput(row({ payer: 'ming' }), people), {
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
    row({
      payer: null,
      paid: { me: 1000 },
      method: 'shares',
      weights: { me: 2, ming: 1 },
    }),
    people,
  ).payers,
  [
    { userId: 'me', amount: 1000 },
    { userId: 'ming', amount: 1400 },
  ],
)
assert.deepEqual(
  toSplitInput(row({ method: 'percent', weights: { me: 40 } }), people).shares,
  [
    { userId: 'me', weight: 40 },
    { userId: 'ming', weight: 60 },
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
  shares: [{ userId: 'me' }],
  accountId: 'bank',
})

// Validation, field by field.
const check = (r: SplitRow, who = people) => validateSplit(r, ctx, who)
assert.equal(check(row({})), null)
assert.equal(check(row({ description: ' ' }))?.field, 'description')
assert.equal(check(row({ total: null }))?.field, 'amount')
assert.equal(check(row({ payer: null, paid: { me: 2400 } }))?.field, 'paidBy')
assert.equal(
  check(row({ settlement: true, payer: null, paid: { me: 1 } }))?.message,
  '還款只有一個人付',
)
assert.equal(
  check(row({ method: 'percent', weights: { me: 140 } }))?.field,
  'split',
)
assert.equal(check(row({ accountId: null }))?.field, 'account')
assert.equal(check(row({ accountId: 'loan' }))?.field, 'account')
assert.equal(check(row({ categoryId: null }))?.field, 'category')
assert.equal(check(row({ payer: 'ming', accountId: null })), null)

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
assert.equal(loaded.payer, 'ming')
assert.deepEqual(loaded.weights, { me: 2, ming: 1 })
assert.equal(splitStatus(loaded, people), 'clean')
assert.equal(splitStatus({ ...loaded, note: '機場' }, people), 'changed')
for (const x of [
  {
    ...saved,
    kind: 'settlement' as const,
    splitMethod: 'exact' as const,
    payers: [{ userId: 'me', amount: 300 }],
    shares: [
      { userId: 'me', amount: 0, weight: null },
      { userId: 'ming', amount: 300, weight: null },
    ],
    total: 300,
    mine: { transactionId: 't', accountId: 'bank', categoryId: null },
  },
  {
    ...saved,
    splitMethod: 'percent' as const,
    shares: [
      { userId: 'me', amount: 400, weight: 40 },
      { userId: 'ming', amount: 600, weight: 60 },
    ],
  },
  {
    ...saved,
    splitMethod: 'exact' as const,
    payers: [
      { userId: 'me', amount: 300 },
      { userId: 'ming', amount: 700 },
    ],
    shares: [
      { userId: 'me', amount: 250, weight: null },
      { userId: 'ming', amount: 750, weight: null },
    ],
    mine: { transactionId: 't', accountId: 'bank', categoryId: 'food' },
  },
]) {
  assert.equal(splitStatus(rowFromExpense(x, people), people), 'clean')
}

// ---------- in a group (M13)

const trip: People = {
  me: 'me',
  members: [
    { id: 'me', name: '我' },
    { id: 'ming', name: '小明' },
    { id: 'hua', name: '小華' },
  ],
  friend: null,
}
const g = (extra: Partial<SplitRow>) => row({ total: 3000, ...extra }, trip)

// Equal among everyone, or some of them.
assert.deepEqual(list(sharesOf(g({}), trip)), [1000, 1000, 1000])
assert.equal(effectOf(g({}), trip), 2000)
assert.equal(splitText(g({}), trip, 0), '平分')
const taxi = g({ total: 900, payer: 'hua', among: ['ming', 'me'] })
assert.deepEqual(
  [...(sharesOf(taxi, trip) ?? [])],
  [
    ['me', 450],
    ['ming', 450],
  ],
)
assert.equal(splitText(taxi, trip, 0), '我、小明平分')
assert.deepEqual(needs(taxi, trip), { account: false, category: true })
// Nothing to me: snacks between the other two.
const snacks = g({ total: 600, payer: 'ming', among: ['ming', 'hua'] })
assert.equal(effectOf(snacks, trip), 0)
assert.deepEqual(needs(snacks, trip), { account: false, category: false })
assert.equal(
  check(g({ ...snacks, categoryId: null, accountId: null }), trip),
  null,
)
assert.match(describeLine(snacks, trip, 0) ?? '', /與我無關/)
// Several paid; exact shares; a settlement between two others.
const hotel = g({
  payer: null,
  paid: { me: 2000, hua: 1000 },
  method: 'exact',
  amounts: { me: 1000, ming: 1500, hua: 500 },
})
assert.equal(effectOf(hotel, trip), 1000)
assert.equal(splitCellText(hotel, 'paidBy', ctx, trip), '我、小華')
assert.equal(
  check(g({ ...hotel, paid: { me: 2000, hua: 500 } }), trip)?.field,
  'paidBy',
)
assert.equal(
  check(g({ ...hotel, amounts: { me: 1000, ming: 1000 } }), trip)?.field,
  'split',
)
const payBack = g({
  settlement: true,
  method: 'exact',
  payer: 'ming',
  receiver: 'hua',
  total: 300,
})
assert.equal(splitText(payBack, trip, 0), '還給小華')
assert.equal(effectOf(payBack, trip), 0)
assert.deepEqual(needs(payBack, trip), { account: false, category: false })
assert.deepEqual(toSplitInput(payBack, trip).shares, [{ userId: 'hua' }])
assert.equal(
  check(g({ settlement: true, payer: 'ming', receiver: null }), trip)?.field,
  'split',
)

// Balances over the lines, and who pays whom to settle them.
const balances = memberBalances([g({}), taxi, snacks], trip)
assert.deepEqual(
  [...balances],
  [
    ['me', 1550],
    ['ming', -1150],
    ['hua', -400],
  ],
)
assert.deepEqual(settleUp(balances, trip), [
  { from: 'ming', to: 'me', amount: 1150 },
  { from: 'hua', to: 'me', amount: 400 },
])
assert.deepEqual(
  settleUp(
    new Map([
      ['me', -500],
      ['ming', 300],
      ['hua', 200],
    ]),
    trip,
  ),
  [
    { from: 'me', to: 'ming', amount: 300 },
    { from: 'me', to: 'hua', amount: 200 },
  ],
)
assert.deepEqual(settleUp(new Map([['me', 0]]), trip), [])

// The group's form: a member per line where each one has a value.
const gplain = splitFormValues(g({}), trip, 0)
assert.deepEqual(fieldKeys(gplain, trip), [
  'kind',
  'payer',
  'method',
  'in:me',
  'in:ming',
  'in:hua',
  'currency',
])
assert.deepEqual(fieldKeys({ ...gplain, kind: 'settlement' }, trip), [
  'kind',
  'payer',
  'receiver',
  'currency',
])
const gform = (values: Record<string, string>, r = g({})) =>
  applySplitForm(r, { ...gplain, ...values }, trip, 0)
assert.deepEqual(patchOf(gform({ 'in:hua': 'no' })).among, ['me', 'ming'])
assert.equal(
  typeof gform({ 'in:me': 'no', 'in:ming': 'no', 'in:hua': 'no' }),
  'string',
)
assert.deepEqual(
  patchOf(gform({ payer: 'several', 'paid:me': '2000', 'paid:hua': '1000' }))
    .paid,
  { me: 2000, hua: 1000 },
)
assert.match(String(gform({ payer: 'several', 'paid:me': '2000' })), /差 1,000/)
assert.deepEqual(
  patchOf(gform({ method: 'exact', 'amt:ming': '1000', 'amt:hua': '2000' }))
    .amounts,
  { ming: 1000, hua: 2000 },
)
assert.equal(
  typeof gform({ method: 'percent', 'pct:me': '50', 'pct:ming': '40' }),
  'string',
)
assert.deepEqual(
  patchOf(gform({ kind: 'settlement', payer: 'hua', receiver: 'ming' })),
  {
    settlement: true,
    payer: 'hua',
    paid: {},
    receiver: 'ming',
    method: 'exact',
    among: ['me', 'ming', 'hua'],
    amounts: {},
    weights: {},
    foreign: null,
  },
)
for (const r of [
  taxi,
  hotel,
  payBack,
  g({ method: 'shares', weights: { me: 2, hua: 1 } }),
  g({ method: 'percent', weights: { me: 50, ming: 25, hua: 25 } }),
]) {
  const patch = applySplitForm(r, splitFormValues(r, trip, 0), trip, 0)
  assert.notEqual(typeof patch, 'string', String(patch))
  assert.deepEqual(
    toSplitInput({ ...r, ...(patch as Partial<SplitRow>) }, trip),
    toSplitInput(r, trip),
  )
}

// A saved group expense reads back into the same line.
const savedTaxi: SharedExpense = {
  ...saved,
  total: 900,
  splitMethod: 'equal',
  payers: [{ userId: 'hua', amount: 900 }],
  shares: [
    { userId: 'ming', amount: 450, weight: null },
    { userId: 'me', amount: 450, weight: null },
  ],
}
const loadedTaxi = rowFromExpense(savedTaxi, trip)
assert.deepEqual(loadedTaxi.among, ['me', 'ming'])
assert.equal(splitStatus(loadedTaxi, trip), 'clean')
const savedBack: SharedExpense = {
  ...saved,
  kind: 'settlement',
  total: 300,
  splitMethod: 'exact',
  payers: [{ userId: 'ming', amount: 300 }],
  shares: [
    { userId: 'hua', amount: 300, weight: null },
    { userId: 'ming', amount: 0, weight: null },
  ],
  mine: { transactionId: null, accountId: null, categoryId: null },
}
assert.equal(rowFromExpense(savedBack, trip).receiver, 'hua')
assert.equal(splitStatus(rowFromExpense(savedBack, trip), trip), 'clean')

console.log('split: ok')
