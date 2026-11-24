// Run with `pnpm test`; dependency-free like money.test.ts.
import assert from 'node:assert/strict'
import {
  afterSubtree,
  budgetLines,
  categoryNodes,
  copyLastMonth,
  fillTargets,
  incomeLines,
  monthLabel,
  monthTotals,
  newPlace,
  offTarget,
  pageLines,
  pageMonths,
  pasteTargets,
  shiftMonth,
  siblingsOf,
  targetTotal,
  topDown,
  uniqueName,
} from './budget-month.ts'
import type { Schemas } from './api'

type Category = Schemas['Category']

function cat(
  id: string,
  name: string,
  parentId: string | null,
  extra: Partial<Category> = {},
): Category {
  return {
    id,
    name,
    parentId,
    kind: 'expense',
    pooled: true,
    isSystem: false,
    archived: false,
    sortOrder: 0,
    budgetBase: null,
    ...extra,
  }
}

const categories: Array<Category> = [
  cat('income', '收入', null, { kind: 'income', pooled: false }),
  cat('opening', '期初餘額', null, { kind: 'income', isSystem: true }),
  cat('food', '飲食', null, { sortOrder: 0 }),
  cat('eat-out', '外食', 'food'),
  cat('home', '居住', null, { pooled: false, sortOrder: 1 }),
  cat('rent', '房租', 'home', { sortOrder: 0 }),
  cat('power', '水電', 'home', { sortOrder: 1 }),
  cat('old', '舊類別', null, { archived: true, sortOrder: 2 }),
  cat('kept', '封存但有錢', null, { archived: true, sortOrder: 3 }),
]

const lines = budgetLines(categories, [
  { categoryId: 'food', allocated: 5000, activity: 0, carried: 300 },
  { categoryId: 'eat-out', allocated: 0, activity: -1200, carried: -100 },
  { categoryId: 'rent', allocated: 12000, activity: -12000, carried: 0 },
  { categoryId: 'power', allocated: 1000, activity: -1500, carried: 0 },
  { categoryId: 'kept', allocated: 0, activity: 0, carried: 400 },
])

// Tree order; income, system and empty archived categories are not lines.
assert.deepEqual(
  lines.map((l) => [l.path, l.kind, l.depth]),
  [
    ['飲食', 'envelope', 1],
    ['飲食/外食', 'member', 2],
    ['居住', 'group', 1],
    ['居住/房租', 'envelope', 2],
    ['居住/水電', 'envelope', 2],
    ['封存但有錢', 'envelope', 1],
  ],
)

// A pooled envelope takes in its subcategories' money; members show spending.
const food = lines[0]
assert.deepEqual(
  [food.allocated, food.activity, food.carried, food.balance],
  [5000, -1200, 200, 4000],
)
assert.deepEqual(
  [lines[1].allocated, lines[1].activity, lines[1].balance],
  [0, -1200, 0],
)

// A group sums its envelopes; overspending carries as a negative balance.
assert.deepEqual(
  [lines[2].allocated, lines[2].activity, lines[2].balance],
  [13000, -13500, -500],
)
assert.equal(lines[4].balance, -500)

// Totals count envelopes only, so groups and members are not counted twice.
assert.deepEqual(monthTotals(lines), {
  allocated: 18000,
  activity: -14700,
  balance: 3900,
})

// Copying last month fills only envelopes with nothing this month.
const thisMonth = budgetLines(categories, [
  { categoryId: 'rent', allocated: 13000, activity: 0, carried: 0 },
])
assert.deepEqual(copyLastMonth(thisMonth, lines), [
  { categoryId: 'food', amount: 5000 },
  { categoryId: 'power', amount: 1000 },
])

// Archived categories show on request even when empty.
assert.ok(
  budgetLines(categories, [], { showArchived: true }).some(
    (l) => l.id === 'old',
  ),
)

// Income lines: a parent adds its subcategories; the system category shows
// only in a month it received something.
const withIncome: Array<Category> = [
  ...categories,
  cat('salary', '薪水', 'income', { kind: 'income', pooled: false }),
  cat('bonus', '獎金', 'income', {
    kind: 'income',
    pooled: false,
    sortOrder: 1,
  }),
]
const page = pageLines(withIncome, {
  envelopes: [
    { categoryId: 'food', allocated: 5000, activity: -800, carried: 0 },
  ],
  incomes: [
    { categoryId: 'salary', received: 40000 },
    { categoryId: 'bonus', received: 2000 },
  ],
})
assert.deepEqual(
  page.map((l) => [l.id, l.kind, l.depth]),
  [
    ['section:expense', 'section', 0],
    ['food', 'envelope', 1],
    ['eat-out', 'member', 2],
    ['home', 'group', 1],
    ['rent', 'envelope', 2],
    ['power', 'envelope', 2],
    ['section:income', 'section', 0],
    ['income', 'income', 1],
    ['salary', 'income', 2],
    ['bonus', 'income', 2],
  ],
)
assert.equal(page[0].allocated, 5000)
assert.equal(page[6].activity, 42000)
assert.equal(page[7].activity, 42000)
assert.equal(
  incomeLines(withIncome, [{ categoryId: 'opening', received: 100 }]).some(
    (l) => l.id === 'opening',
  ),
  true,
)

// Where o, O and A put a new category.
assert.deepEqual(newPlace(withIncome, page[4], 'below'), {
  parentId: 'home',
  kind: 'expense',
  index: 1,
  depth: 2,
})
assert.deepEqual(newPlace(withIncome, page[4], 'above'), {
  parentId: 'home',
  kind: 'expense',
  index: 0,
  depth: 2,
})
assert.deepEqual(newPlace(withIncome, page[3], 'child'), {
  parentId: 'home',
  kind: 'expense',
  index: 2,
  depth: 2,
})
// The fourth level is refused; a section adds top-level categories.
assert.equal(newPlace(withIncome, { ...page[4], depth: 3 }, 'child'), null)
assert.deepEqual(newPlace(withIncome, page[6], 'child'), {
  parentId: null,
  kind: 'income',
  index: 1,
  depth: 1,
})
assert.deepEqual(
  siblingsOf(withIncome, null, 'income').map((c) => c.id),
  ['income'],
)
// After 居住 and its subcategories comes the income section.
assert.equal(afterSubtree(page, 3), 6)
assert.equal(afterSubtree(page, 6), 10)

// Yanking categories takes the top-most ones, each with what is under it.
const nodes = categoryNodes(withIncome, ['rent', 'home', 'food', 'opening'])
assert.deepEqual(
  nodes.map((n) => [n.id, n.index, n.children.map((c) => c.id)]),
  [
    ['home', 1, ['rent', 'power']],
    ['food', 0, ['eat-out']],
  ],
)
assert.deepEqual(
  topDown(nodes).map((n) => n.id),
  ['home', 'rent', 'power', 'food', 'eat-out'],
)
assert.equal(nodes[0].children[1].parent, nodes[0])
assert.equal(uniqueName('房租', ['水電']), '房租')
assert.equal(uniqueName('房租', ['房租', '房租 2']), '房租 3')

// Pasted amounts go into the envelopes from the cursor down.
assert.deepEqual(
  pasteTargets(page, 3, 5).map((l) => l.id),
  ['rent', 'power'],
)
assert.deepEqual(
  pasteTargets(page, 0, 2).map((l) => l.id),
  ['food', 'rent'],
)

// Several months line up: a line shows when any month would show it.
const side = pageMonths(categories, [
  { month: '2026-11', envelopes: [], incomes: [] },
  {
    month: '2026-12',
    envelopes: [{ categoryId: 'old', allocated: 0, activity: -50, carried: 0 }],
    incomes: [{ categoryId: 'opening', received: 10 }],
  },
])
assert.deepEqual(
  side[0].lines.map((l) => l.id),
  side[1].lines.map((l) => l.id),
)
assert.ok(side[0].lines.some((l) => l.id === 'old'))
assert.ok(side[0].lines.some((l) => l.id === 'opening'))
assert.equal(side[0].lines.find((l) => l.id === 'old')?.activity, 0)
assert.equal(side[1].lines.find((l) => l.id === 'old')?.activity, -50)
assert.ok(!side[0].lines.some((l) => l.id === 'kept'))

assert.equal(shiftMonth('2026-11', 1), '2026-12')
assert.equal(shiftMonth('2026-12', 1), '2027-01')
assert.equal(shiftMonth('2026-01', -1), '2025-12')
assert.equal(shiftMonth('2026-03', -14), '2025-01')
assert.equal(monthLabel('2026-03'), '2026 年 3 月')

// Targets (ADR-086): on envelopes only; :fill sets them, :copylast skips them.
{
  const month = {
    envelopes: [
      { categoryId: 'food', allocated: 5000, activity: 0, carried: 0 },
      { categoryId: 'rent', allocated: 12000, activity: 0, carried: 0 },
    ],
    incomes: [],
    targets: [
      {
        categoryId: 'food',
        total: 6500,
        base: 5000,
        schedules: [{ scheduleId: 's1', amount: 1500 }],
        goals: [],
      },
      {
        categoryId: 'rent',
        total: 12000,
        base: null,
        schedules: [],
        goals: [],
      },
      // An archived envelope with a target still shows.
      { categoryId: 'old', total: 300, base: 300, schedules: [], goals: [] },
    ],
  }
  const withTargets = pageLines(categories, month)
  const byId = new Map(withTargets.map((l) => [l.id, l]))
  assert.equal(byId.get('food')?.target?.total, 6500)
  assert.equal(byId.get('eat-out')?.target, null)
  assert.ok(byId.has('old'))
  assert.equal(targetTotal(withTargets), 6500 + 12000 + 300)
  const foodLine = byId.get('food')
  const rentLine = byId.get('rent')
  assert.ok(foodLine && rentLine)
  assert.ok(offTarget(foodLine))
  assert.ok(!offTarget(rentLine))
  // Only envelopes off their target, and not archived ones.
  assert.deepEqual(
    fillTargets(withTargets).map((f) => [f.line.id, f.amount]),
    [['food', 6500]],
  )
  // Run again once filled: nothing to do.
  const filled = withTargets.map((l) =>
    l.id === 'food' ? { ...l, allocated: 6500 } : l,
  )
  assert.deepEqual(fillTargets(filled), [])
  // :copylast leaves envelopes with a target alone.
  const empty = pageLines(categories, {
    ...month,
    envelopes: [],
  })
  assert.deepEqual(
    copyLastMonth(empty, lines).map((c) => c.categoryId),
    ['power'],
  )
}

console.log('budget-month: ok')
