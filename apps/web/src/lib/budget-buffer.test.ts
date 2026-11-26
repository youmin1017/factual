// Run with: node --experimental-strip-types src/lib/budget-buffer.test.ts
import assert from 'node:assert/strict'
import {
  batchOf,
  changeCount,
  createCategory,
  emptyBuffer,
  moveCategory,
  overlay,
  removeCategory,
  setAllocations,
  setBase,
  updateCategory,
} from './budget-buffer.ts'
import type { Schemas } from './api'

type Category = Schemas['Category']
type BudgetMonth = Schemas['BudgetMonth']

function category(
  id: string,
  name: string,
  parentId: string | null,
  sortOrder: number,
  extra: Partial<Category> = {},
): Category {
  return {
    id,
    parentId,
    name,
    kind: 'expense',
    pooled: true,
    isSystem: false,
    sortOrder,
    archived: false,
    budgetBase: null,
    ...extra,
  }
}

const saved = [
  category('food', '飲食', null, 0),
  category('car', '交通', null, 1),
  category('gas', '加油', 'car', 0),
]
const ids = new Set(saved.map((c) => c.id))
let b = emptyBuffer(saved)
assert.equal(changeCount(b, saved), 0)

// A new category goes where it was asked for; its siblings are numbered again.
b = createCategory(b, 'rent', {
  parentId: null,
  name: '房租',
  kind: 'expense',
  index: 1,
})
const order = b.categories
  .filter((c) => c.parentId === null)
  .toSorted((x, y) => x.sortOrder - y.sortOrder)
  .map((c) => c.id)
assert.deepEqual(order, ['food', 'rent', 'car'])
// Moving under another parent.
b = moveCategory(b, 'gas', 'food', 0)
assert.equal(b.categories.find((c) => c.id === 'gas')?.parentId, 'food')
b = updateCategory(b, 'food', { name: '伙食' })

// Allocations remember what the server had; going back drops the change.
b = setAllocations(
  b,
  '2026-11',
  [{ categoryId: 'food', amount: 5000 }],
  () => 3000,
)
b = setAllocations(
  b,
  '2026-11',
  [{ categoryId: 'rent', amount: 15000 }],
  () => 0,
)
b = setAllocations(
  b,
  '2026-11',
  [{ categoryId: 'food', amount: 3000 }],
  () => 9999,
)
assert.equal(Object.keys(b.allocations).length, 1)
b = setAllocations(
  b,
  '2026-11',
  [{ categoryId: 'food', amount: 4000 }],
  () => 3000,
)
b = setBase(b, 'food', 2000)

// The months are shown through the buffer.
const nov: BudgetMonth = {
  month: '2026-11',
  pool: 50000,
  income: 0,
  envelopes: [
    { categoryId: 'food', allocated: 3000, activity: -1000, carried: 0 },
  ],
  incomes: [],
  targets: [],
  spokenFor: [],
}
const dec: BudgetMonth = {
  ...nov,
  month: '2026-12',
  envelopes: [{ categoryId: 'food', allocated: 0, activity: 0, carried: 2000 }],
}
const shownNov = overlay(nov, b, saved)
assert.equal(shownNov.pool, 50000 - 1000 - 15000)
assert.deepEqual(
  shownNov.envelopes.find((e) => e.categoryId === 'food'),
  { categoryId: 'food', allocated: 4000, activity: -1000, carried: 0 },
)
assert.equal(
  shownNov.envelopes.find((e) => e.categoryId === 'rent')?.allocated,
  15000,
)
assert.deepEqual(shownNov.targets, [
  { categoryId: 'food', base: 2000, total: 2000, schedules: [], goals: [] },
])
const shownDec = overlay(dec, b, saved)
assert.equal(
  shownDec.envelopes.find((e) => e.categoryId === 'food')?.carried,
  3000,
)
assert.equal(
  shownDec.envelopes.find((e) => e.categoryId === 'rent')?.carried,
  15000,
)

// What :w sends.
const batch = batchOf(b, saved)
assert.deepEqual(batch.categories.map((c) => c.id).toSorted(), [
  'car',
  'food',
  'gas',
  'rent',
])
assert.deepEqual(
  batch.allocations.toSorted((x, y) =>
    x.categoryId.localeCompare(y.categoryId),
  ),
  [
    { categoryId: 'food', month: '2026-11', amount: 4000 },
    { categoryId: 'rent', month: '2026-11', amount: 15000 },
  ],
)
assert.deepEqual(batch.bases, [{ categoryId: 'food', amount: 2000 }])

// Removing: a new category leaves with its allocations, a saved one is deleted.
b = removeCategory(b, 'rent', ids)
assert.equal(batchOf(b, saved).allocations.length, 1)
b = removeCategory(b, 'car', ids)
assert.deepEqual(batchOf(b, saved).deleteCategories, ['car'])
assert.ok(changeCount(b, saved) > 0)

// Putting a deleted category back keeps its id.
b = createCategory(
  b,
  'new-id',
  { parentId: null, name: '交通', kind: 'expense' },
  saved,
)
assert.ok(b.categories.some((c) => c.id === 'car'))
assert.ok(!b.categories.some((c) => c.id === 'new-id'))
assert.deepEqual(batchOf(b, saved).deleteCategories, [])

console.log('budget-buffer: ok')
