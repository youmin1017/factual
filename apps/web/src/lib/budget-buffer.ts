import type { Schemas } from './api'

// The budget page's buffer (ADR-109): the category tree as the page leaves
// it, the allocations changed in any month and the envelopes' base amounts,
// kept until :w saves them in one request. The month figures the server
// sent are shown through it (`overlay`). Pure, tested with node.

type Category = Schemas['Category']
type BudgetMonth = Schemas['BudgetMonth']
type BudgetBatch = Schemas['BudgetBatch']

export interface AllocationChange {
  month: string
  categoryId: string
  /** What the server had when the change was made. */
  from: number
  to: number
}

export interface BudgetBuffer {
  /** Every category as the page leaves it, new ones included, deleted ones not. */
  categories: Array<Category>
  /** Saved categories deleted. */
  deleted: Array<string>
  /** By `month|categoryId`. */
  allocations: Record<string, AllocationChange>
}

export interface NewCategory {
  parentId: string | null
  name: string
  kind: Category['kind']
  pooled?: boolean
  archived?: boolean
  /** Position among its siblings of the same kind; last when absent. */
  index?: number
}

export function emptyBuffer(categories: Array<Category>): BudgetBuffer {
  return { categories, deleted: [], allocations: {} }
}

const allocationKey = (month: string, categoryId: string) =>
  `${month}|${categoryId}`

function siblings(
  list: Array<Category>,
  parentId: string | null,
  kind: Category['kind'],
): Array<Category> {
  return list
    .filter(
      (c) =>
        (c.parentId ?? null) === parentId && c.kind === kind && !c.isSystem,
    )
    .toSorted((a, b) => a.sortOrder - b.sortOrder)
}

/** Puts `id` at `index` among its siblings under `parentId`, numbering them again. */
export function moveCategory(
  buffer: BudgetBuffer,
  id: string,
  parentId: string | null,
  index: number,
): BudgetBuffer {
  const moving = buffer.categories.find((c) => c.id === id)
  if (!moving) return buffer
  const order = siblings(buffer.categories, parentId, moving.kind).filter(
    (c) => c.id !== id,
  )
  order.splice(Math.max(0, Math.min(index, order.length)), 0, {
    ...moving,
    parentId,
  })
  const place = new Map(order.map((c, i) => [c.id, i]))
  return {
    ...buffer,
    categories: buffer.categories.map((c) =>
      c.id === id
        ? { ...c, parentId, sortOrder: place.get(id) ?? 0 }
        : place.has(c.id)
          ? { ...c, sortOrder: place.get(c.id) ?? c.sortOrder }
          : c,
    ),
  }
}

export function createCategory(
  buffer: BudgetBuffer,
  id: string,
  input: NewCategory,
  saved: Array<Category> = [],
): BudgetBuffer {
  // Putting back a saved category deleted in this buffer (undo, or p after
  // dd) brings back the same category, so nothing that refers to it is lost.
  const back = saved.find(
    (c) =>
      buffer.deleted.includes(c.id) &&
      (c.parentId ?? null) === input.parentId &&
      c.name === input.name,
  )
  if (back) {
    const last = siblings(buffer.categories, input.parentId, back.kind).length
    return moveCategory(
      {
        ...buffer,
        deleted: buffer.deleted.filter((d) => d !== back.id),
        categories: [
          ...buffer.categories,
          {
            ...back,
            pooled: input.pooled ?? back.pooled,
            archived: input.archived ?? back.archived,
          },
        ],
      },
      back.id,
      input.parentId,
      input.index ?? last,
    )
  }
  const parent = input.parentId
    ? buffer.categories.find((c) => c.id === input.parentId)
    : undefined
  const kind = parent?.kind ?? input.kind
  const last = siblings(buffer.categories, input.parentId, kind).length
  const made: Category = {
    id,
    parentId: input.parentId,
    name: input.name,
    kind,
    // Expense categories share their budget unless told otherwise (ADR-061).
    pooled: kind === 'expense' ? (input.pooled ?? true) : false,
    isSystem: false,
    sortOrder: last,
    archived: input.archived ?? false,
    budgetBase: null,
  }
  return moveCategory(
    { ...buffer, categories: [...buffer.categories, made] },
    id,
    input.parentId,
    input.index ?? last,
  )
}

export function updateCategory(
  buffer: BudgetBuffer,
  id: string,
  changes: Partial<Pick<Category, 'name' | 'pooled' | 'archived'>>,
): BudgetBuffer {
  return {
    ...buffer,
    categories: buffer.categories.map((c) =>
      c.id === id ? { ...c, ...changes } : c,
    ),
  }
}

/**
 * Removes a category. A saved one is deleted on :w (the server refuses one
 * that still holds money); a new one, with what was allocated to it, is
 * simply gone.
 */
export function removeCategory(
  buffer: BudgetBuffer,
  id: string,
  saved: ReadonlySet<string>,
): BudgetBuffer {
  const allocations = saved.has(id)
    ? buffer.allocations
    : Object.fromEntries(
        Object.entries(buffer.allocations).filter(
          ([, a]) => a.categoryId !== id,
        ),
      )
  return {
    categories: buffer.categories.filter((c) => c.id !== id),
    deleted:
      saved.has(id) && !buffer.deleted.includes(id)
        ? [...buffer.deleted, id]
        : buffer.deleted,
    allocations,
  }
}

/** Sets allocations of a month; `original` is what the server has for each. */
export function setAllocations(
  buffer: BudgetBuffer,
  month: string,
  set: Array<{ categoryId: string; amount: number }>,
  original: (categoryId: string) => number,
): BudgetBuffer {
  const allocations = { ...buffer.allocations }
  for (const { categoryId, amount } of set) {
    const key = allocationKey(month, categoryId)
    const from =
      key in allocations ? allocations[key].from : original(categoryId)
    if (amount === from) delete allocations[key]
    else allocations[key] = { month, categoryId, from, to: amount }
  }
  return { ...buffer, allocations }
}

/** Sets an envelope's base amount (0 removes it). */
export function setBase(
  buffer: BudgetBuffer,
  id: string,
  amount: number,
): BudgetBuffer {
  return updateBase(buffer, id, amount > 0 ? amount : null)
}

function updateBase(
  buffer: BudgetBuffer,
  id: string,
  base: number | null,
): BudgetBuffer {
  return {
    ...buffer,
    categories: buffer.categories.map((c) =>
      c.id === id ? { ...c, budgetBase: base } : c,
    ),
  }
}

/**
 * A month as the server sent it, with the buffer's allocations in it: an
 * envelope's allocation in its month, what it carries into the months
 * after, the pool (timeless, ADR-025), and targets with changed bases.
 */
export function overlay(
  month: BudgetMonth,
  buffer: BudgetBuffer,
  saved: Array<Category>,
): BudgetMonth {
  const envelopes = month.envelopes.map((e) => ({ ...e }))
  const at = new Map(envelopes.map((e, i) => [e.categoryId, i]))
  const figures = (categoryId: string) => {
    let i = at.get(categoryId)
    if (i === undefined) {
      i = envelopes.length
      at.set(categoryId, i)
      envelopes.push({ categoryId, allocated: 0, activity: 0, carried: 0 })
    }
    return envelopes[i]
  }
  let pool = month.pool
  for (const a of Object.values(buffer.allocations)) {
    const delta = a.to - a.from
    pool -= delta
    if (a.month === month.month) figures(a.categoryId).allocated = a.to
    else if (a.month < month.month) figures(a.categoryId).carried += delta
  }
  const before = new Map(saved.map((c) => [c.id, c.budgetBase]))
  const targets = month.targets.map((t) => ({ ...t }))
  for (const c of buffer.categories) {
    const was = before.get(c.id) ?? null
    if (c.budgetBase === was) continue
    const t = targets.find((x) => x.categoryId === c.id)
    const delta = (c.budgetBase ?? 0) - (was ?? 0)
    if (t) {
      t.base = c.budgetBase
      t.total += delta
    } else if (c.budgetBase) {
      targets.push({
        categoryId: c.id,
        base: c.budgetBase,
        total: c.budgetBase,
        schedules: [],
        goals: [],
      })
    }
  }
  return { ...month, pool, envelopes, targets }
}

function categoryChanged(c: Category, s: Category | undefined): boolean {
  return (
    !s ||
    (c.parentId ?? null) !== (s.parentId ?? null) ||
    c.name !== s.name ||
    c.pooled !== s.pooled ||
    c.archived !== s.archived ||
    c.sortOrder !== s.sortOrder
  )
}

/** What :w sends; empty lists when nothing changed. */
export function batchOf(
  buffer: BudgetBuffer,
  saved: Array<Category>,
): BudgetBatch {
  const byId = new Map(saved.map((c) => [c.id, c]))
  return {
    categories: buffer.categories
      .filter((c) => !c.isSystem && categoryChanged(c, byId.get(c.id)))
      .map((c) => ({
        id: c.id,
        parentId: c.parentId ?? null,
        name: c.name,
        kind: c.kind,
        pooled: c.pooled,
        archived: c.archived,
        sortOrder: c.sortOrder,
      })),
    deleteCategories: buffer.deleted.filter((id) => byId.has(id)),
    allocations: Object.values(buffer.allocations)
      .filter((a) => a.to !== a.from)
      .map((a) => ({ categoryId: a.categoryId, month: a.month, amount: a.to })),
    bases: buffer.categories
      .filter(
        (c) => (c.budgetBase ?? null) !== (byId.get(c.id)?.budgetBase ?? null),
      )
      .map((c) => ({ categoryId: c.id, amount: c.budgetBase ?? 0 })),
  }
}

/** How many changes wait for :w. */
export function changeCount(
  buffer: BudgetBuffer,
  saved: Array<Category>,
): number {
  const b = batchOf(buffer, saved)
  return (
    b.categories.length +
    b.deleteCategories.length +
    b.allocations.length +
    b.bases.length
  )
}
