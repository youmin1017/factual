// Run with: node --experimental-strip-types src/lib/goals.test.ts
import assert from 'node:assert/strict'
import {
  envelopeMap,
  etaText,
  goalCellText,
  goalFigures,
  goalPatch,
  goalStatus,
  newGoalRow,
  parseKind,
  rowFromGoal,
  toGoalInput,
  validateGoal,
} from './goals.ts'
import type { Schemas } from './api'
import type { Goal, GoalColumn, GoalList, GoalRow } from './goals.ts'
import type { CategoryRef, Context } from './register.ts'

type Category = Schemas['Category']

function category(
  id: string,
  name: string,
  parentId: string | null,
  extra: Partial<Category> = {},
): Category {
  return {
    id,
    parentId,
    name,
    kind: 'expense',
    pooled: true,
    isSystem: false,
    sortOrder: 0,
    archived: false,
    budgetBase: null,
    ...extra,
  }
}

const categories: Array<Category> = [
  category('hobby', '興趣', null),
  category('badminton', '羽球', 'hobby'),
  category('food', '飲食', null),
  category('housing', '居住', null, { pooled: false }),
  category('rent', '房租', 'housing'),
  category('salary', '薪資', null, { kind: 'income', pooled: false }),
]
const envelopes = envelopeMap(categories)

// A pooled parent holds its subcategories' money; a parent whose children
// budget separately holds none; income is in no envelope.
assert.equal(envelopes.get('badminton'), 'hobby')
assert.equal(envelopes.get('hobby'), 'hobby')
assert.equal(envelopes.get('rent'), 'rent')
assert.equal(envelopes.has('housing'), false)
assert.equal(envelopes.has('salary'), false)

const refs = new Map<string, CategoryRef>(
  [
    ['hobby', '興趣'],
    ['badminton', '興趣/羽球'],
    ['food', '飲食'],
    ['housing', '居住'],
    ['rent', '居住/房租'],
    ['salary', '薪資'],
  ].map(([id, path]) => [
    id,
    {
      id,
      path,
      name: path.split('/').at(-1) ?? path,
      kind: id === 'salary' ? 'income' : 'expense',
      archived: false,
      isSystem: false,
    },
  ]),
)
const ctx: Context = { accounts: new Map(), categories: refs, minorUnits: 0 }
const today = '2026-11-20'

function apply(row: GoalRow, col: GoalColumn, text: string): GoalRow {
  const p = goalPatch(row, col, text, ctx, envelopes, today)
  if (typeof p === 'string') throw new Error(`${col} ${text}: ${p}`)
  return { ...row, ...p }
}

function refused(row: GoalRow, col: GoalColumn, text: string): string {
  const p = goalPatch(row, col, text, ctx, envelopes, today)
  assert.equal(typeof p, 'string', `${col} ${text} should be refused`)
  return p as string
}

// ---------- typing into cells

assert.equal(parseKind('期限'), 'targetByDate')
assert.equal(parseKind('維'), 'maintain')
assert.equal(parseKind('每月'), 'monthly')
assert.equal(parseKind('目標'), 'target')
assert.equal(parseKind('monthly'), 'monthly')
assert.equal(parseKind('x'), null)

let racket = newGoalRow('racket', null)
racket = apply(racket, 'name', ' 羽球拍 ')
racket = apply(racket, 'category', '興趣/羽球')
racket = apply(racket, 'target', '3,500')
racket = apply(racket, 'wait', '+11')
racket = apply(racket, 'url', 'https://example.com/racket')
assert.equal(racket.name, '羽球拍')
assert.equal(racket.categoryId, 'badminton')
assert.equal(racket.targetAmount, 3500)
assert.equal(racket.waitUntil, '2026-12-01')
assert.match(refused(racket, 'category', '居住'), /沒有預算/)
assert.match(refused(racket, 'category', '薪資'), /沒有預算/)
assert.match(refused(racket, 'url', 'example.com'), /http/)
assert.match(refused(racket, 'target', '-5'), /大於 0/)
assert.match(refused(racket, 'saved', '1'), /算出來/)
assert.equal(apply(racket, 'wait', '').waitUntil, null)

// A level is typed as months of spending.
let fund = apply(
  apply(newGoalRow('fund', 'food'), 'name', '備用金'),
  'kind',
  '維持',
)
fund = apply(fund, 'target', '3 個月')
assert.equal(fund.maintainMonths, 3)
assert.equal(goalCellText(fund, 'target', ctx), '3')
assert.match(refused(fund, 'target', '0'), /1 到 120/)

// What :w sends keeps only the amounts the kind uses.
const switched = apply(apply(racket, 'kind', '每月固定'), 'monthly', '500')
const input = toGoalInput(switched, 4)
assert.equal(input.targetAmount, null)
assert.equal(input.monthlyAmount, 500)
assert.equal(input.sortOrder, 4)

// ---------- validation and status

assert.equal(validateGoal(racket, envelopes), null)
assert.equal(validateGoal(newGoalRow('x', 'food'), envelopes)?.field, 'name')
assert.equal(
  validateGoal({ ...racket, kind: 'targetByDate' }, envelopes)?.field,
  'date',
)
assert.equal(
  validateGoal({ ...racket, categoryId: 'housing' }, envelopes)?.field,
  'category',
)
assert.equal(
  validateGoal({ ...fund, maintainMonths: null }, envelopes)?.field,
  'target',
)

function saved(
  row: GoalRow,
  sortOrder: number,
  extra: Partial<Goal> = {},
): Goal {
  return {
    ...toGoalInput(row, sortOrder),
    envelopeId: envelopes.get(row.categoryId ?? '') ?? null,
    createdAt: '2026-11-02T03:00:00Z',
    achievedAt: null,
    saved: 0,
    total: null,
    ask: 0,
    status: 'saving',
    ...extra,
  }
}

const savedRacket = rowFromGoal(saved(racket, 0))
assert.equal(goalStatus(savedRacket), 'clean')
// An amount its kind does not use is no change.
assert.equal(goalStatus({ ...savedRacket, targetDate: '2027-01-01' }), 'clean')
assert.equal(goalStatus({ ...savedRacket, targetAmount: 3600 }), 'changed')
assert.equal(goalStatus({ ...savedRacket, deleted: true }), 'deleted')
assert.equal(goalStatus(racket), 'new')

// ---------- figures: the same numbers as the server's integration test

const phones = rowFromGoal(
  saved(
    {
      ...newGoalRow('phones', 'hobby'),
      name: '耳機',
      targetAmount: 4000,
      monthlyAmount: 800,
    },
    1,
  ),
)
const trip = rowFromGoal(
  saved(
    {
      ...newGoalRow('trip', 'food'),
      name: '日本旅遊',
      kind: 'targetByDate',
      targetAmount: 30000,
      targetDate: '2027-01-31',
    },
    2,
  ),
)
const savedFund = rowFromGoal(saved(fund, 3))
const facts: Pick<
  GoalList,
  'month' | 'averageSpending' | 'typicalIncome' | 'baseTargets' | 'envelopes'
> = {
  month: '2026-11',
  averageSpending: 1500,
  typicalIncome: 40000,
  baseTargets: 2000,
  envelopes: [
    { categoryId: 'hobby', balance: 5000, carried: 0 },
    { categoryId: 'food', balance: 300, carried: -1500 },
  ],
}
const rows = [savedRacket, phones, trip, savedFund]
const { figures, summary } = goalFigures(rows, facts, envelopes, today)
const f = (id: string) => {
  const got = figures.get(id)
  assert.ok(got, id)
  return got
}
assert.deepEqual(
  [
    f('racket').saved,
    f('racket').status,
    f('racket').ask,
    f('racket').envelope,
  ],
  [3500, 'waiting', 0, 'hobby'],
)
assert.deepEqual([f('phones').saved, f('phones').ask], [1500, 800])
assert.deepEqual(
  [f('trip').saved, f('trip').ask, f('trip').total],
  [300, 10000, 30000],
)
assert.deepEqual(
  [f('fund').saved, f('fund').total, f('fund').ask],
  [0, 4500, 4500],
)
assert.deepEqual(summary, { free: 38000, asks: 800 + 10000 + 4500 })
// From December, 38,000 a month: the fund in December, the trip by its
// date, the headphones at 800 a month by March.
assert.equal(f('racket').eta, 'now')
assert.equal(f('fund').eta, '2026-12')
assert.equal(f('trip').eta, '2027-01')
assert.equal(f('phones').eta, '2027-03')

// Achieved: the racket takes nothing, the headphones fill up.
const after = goalFigures(
  [{ ...savedRacket, achieved: true }, phones, trip, savedFund],
  facts,
  envelopes,
  today,
).figures
assert.equal(after.get('racket')?.status, 'achieved')
assert.equal(after.get('racket')?.saved, 0)
assert.equal(after.get('racket')?.eta, null)
assert.equal(after.get('phones')?.status, 'full')

// The order decides who waits when money is short.
const little = { ...facts, typicalIncome: 1000, baseTargets: 0, envelopes: [] }
const a = { ...newGoalRow('a', 'food'), name: 'A', targetAmount: 1500 }
const b = { ...newGoalRow('b', 'food'), name: 'B', targetAmount: 1000 }
let byOrder = goalFigures([a, b], little, envelopes, today).figures
assert.deepEqual(
  [byOrder.get('a')?.eta, byOrder.get('b')?.eta],
  ['2027-01', '2027-02'],
)
byOrder = goalFigures([b, a], little, envelopes, today).figures
assert.deepEqual(
  [byOrder.get('a')?.eta, byOrder.get('b')?.eta],
  ['2027-02', '2026-12'],
)

// Nothing free: never within ten years; a monthly goal has no end.
const none = goalFigures(
  [a, { ...newGoalRow('m', 'food'), kind: 'monthly', monthlyAmount: 100 }],
  { ...little, typicalIncome: 0 },
  envelopes,
  today,
).figures
assert.equal(none.get('a')?.eta, 'never')
assert.equal(none.get('m')?.eta, null)
assert.equal(etaText('never'), '十年以上')
assert.equal(etaText('2027-03'), '2027/03')

console.log('goals: ok')
