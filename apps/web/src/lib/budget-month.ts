/**
 * The budget page's data model (M6), without React: the categories as lines
 * of one month, with the money of a pooled parent's subcategories folded into
 * its envelope (ADR-025, ADR-026, ADR-061), and the category tree edited from
 * the same page (ADR-079). Kept pure so it can be tested with plain node
 * (`budget-month.test.ts`).
 */
import type { Schemas } from './api'

type Category = Schemas['Category']
type CategoryKind = Schemas['CategoryKind']
type EnvelopeMonth = Schemas['EnvelopeMonth']
type IncomeMonth = Schemas['IncomeMonth']
export type EnvelopeTarget = Schemas['EnvelopeTarget']

/**
 * - `section`: the heading of the expense or the income categories.
 * - `envelope`: holds a budget (pooled, or with no subcategories); takes an
 *   allocation.
 * - `group`: a parent whose subcategories budget separately; shows their sums.
 * - `member`: a subcategory inside a pooled envelope; shows its spending only.
 * - `income`: an income category; shows what came in this month.
 */
export type LineKind = 'section' | 'envelope' | 'group' | 'member' | 'income'

export interface BudgetLine {
  /** The category id; `section:expense` or `section:income` for headings. */
  id: string
  name: string
  /** Category path (`交通/加油`), for messages and `:fund`. */
  path: string
  /** 0 for a section heading, 1 for a top-level category. */
  depth: number
  kind: LineKind
  section: CategoryKind
  /** The category itself; null for a section heading. */
  category: Category | null
  /** Whether it has subcategories, shown or not. */
  hasChildren: boolean
  allocated: number
  /** Spent (negative) in an expense line; received in an income line. */
  activity: number
  /** At the end of the month: carried + allocated + activity. */
  balance: number
  carried: number
  archived: boolean
  /**
   * An envelope's target this month (ADR-086): its base plus what the
   * schedules it covers ask for; null when it has none.
   */
  target: EnvelopeTarget | null
}

export interface MonthTotals {
  allocated: number
  activity: number
  balance: number
}

export interface LineOptions {
  /** Show archived categories even when no money is in them. */
  showArchived?: boolean
  /** Every line, system ones without money too (to line months up). */
  all?: boolean
  /** The month's targets, by envelope (ADR-086). */
  targets?: Array<EnvelopeTarget>
}

/** `2026-11` → `2026-12`; `delta` may be negative. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const index = y * 12 + (m - 1) + delta
  const year = Math.floor(index / 12)
  return `${year}-${String((index % 12) + 1).padStart(2, '0')}`
}

/** The month a date falls in, `YYYY-MM`. */
export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function isMonth(text: unknown): text is string {
  return typeof text === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(text)
}

/** `2026-11` → `2026 年 11 月`. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${y} 年 ${m} 月`
}

/** The categories under `parentId` of one kind, in order; system ones left out. */
export function siblingsOf(
  categories: Array<Category>,
  parentId: string | null,
  kind: CategoryKind,
): Array<Category> {
  return categories
    .filter(
      (c) =>
        (c.parentId ?? null) === parentId && c.kind === kind && !c.isSystem,
    )
    .toSorted((a, b) => a.sortOrder - b.sortOrder)
}

function childrenByParent(
  categories: Array<Category>,
): Map<string | null, Array<Category>> {
  const byParent = new Map<string | null, Array<Category>>()
  for (const c of categories) {
    const key = c.parentId ?? null
    byParent.set(key, [...(byParent.get(key) ?? []), c])
  }
  // System categories (opening balances) go last; they cannot be moved.
  for (const list of byParent.values())
    list.sort(
      (a, b) =>
        Number(a.isSystem) - Number(b.isSystem) || a.sortOrder - b.sortOrder,
    )
  return byParent
}

/**
 * The expense lines in tree order: every expense category that is not a
 * system one. Archived categories show only while they still hold or moved
 * money this month, unless `showArchived`.
 */
export function budgetLines(
  categories: Array<Category>,
  envelopes: Array<EnvelopeMonth>,
  { showArchived = false, all = false, targets = [] }: LineOptions = {},
): Array<BudgetLine> {
  const byParent = childrenByParent(
    categories.filter((c) => c.kind === 'expense' && !c.isSystem),
  )
  const targetOf = new Map(targets.map((t) => [t.categoryId, t]))
  const own = new Map(envelopes.map((e) => [e.categoryId, e]))
  const zero = { allocated: 0, activity: 0, carried: 0 }

  const lines: Array<BudgetLine> = []
  /** Adds the lines of `c` and below; returns the sums of what it added. */
  const walk = (
    c: Category,
    depth: number,
    path: string,
    inPool: boolean,
    archived: boolean,
  ): typeof zero => {
    const children = byParent.get(c.id) ?? []
    const kind: LineKind = inPool
      ? 'member'
      : c.pooled || children.length === 0
        ? 'envelope'
        : 'group'
    const line: BudgetLine = {
      id: c.id,
      name: c.name,
      path,
      depth,
      kind,
      section: 'expense',
      category: c,
      hasChildren: children.length > 0,
      ...zero,
      balance: 0,
      archived: archived || c.archived,
      target: kind === 'envelope' ? (targetOf.get(c.id) ?? null) : null,
    }
    const at = lines.length
    lines.push(line)
    const self = own.get(c.id) ?? zero
    const sums = {
      allocated: self.allocated,
      activity: self.activity,
      carried: self.carried,
    }
    for (const child of children) {
      const s = walk(
        child,
        depth + 1,
        `${path}/${child.name}`,
        kind !== 'group',
        line.archived,
      )
      sums.allocated += s.allocated
      sums.activity += s.activity
      sums.carried += s.carried
    }
    Object.assign(line, sums, {
      balance: sums.carried + sums.allocated + sums.activity,
    })
    // Members show what was spent in them; the envelope holds the rest.
    if (kind === 'member') {
      line.allocated = 0
      line.carried = 0
      line.balance = 0
    }
    // An archived line with no money left (and nothing asked of it) is
    // gone, with what is under it.
    if (
      line.archived &&
      !showArchived &&
      !all &&
      sums.activity === 0 &&
      sums.allocated === 0 &&
      sums.carried === 0 &&
      !line.target
    ) {
      lines.splice(at)
    }
    return sums
  }
  for (const top of byParent.get(null) ?? []) {
    walk(top, 1, top.name, false, false)
  }
  return lines
}

/**
 * The income lines in tree order, each with what came in this month (a parent
 * adds its subcategories'). System categories (opening balances) show only in
 * a month they received something; archived ones as expense lines do.
 */
export function incomeLines(
  categories: Array<Category>,
  incomes: Array<IncomeMonth>,
  { showArchived = false, all = false }: LineOptions = {},
): Array<BudgetLine> {
  const byParent = childrenByParent(
    categories.filter((c) => c.kind === 'income'),
  )
  const received = new Map(incomes.map((i) => [i.categoryId, i.received]))
  const lines: Array<BudgetLine> = []
  const walk = (
    c: Category,
    depth: number,
    path: string,
    archived: boolean,
  ): number => {
    const children = byParent.get(c.id) ?? []
    const line: BudgetLine = {
      id: c.id,
      name: c.name,
      path,
      depth,
      kind: 'income',
      section: 'income',
      category: c,
      hasChildren: children.length > 0,
      allocated: 0,
      activity: 0,
      balance: 0,
      carried: 0,
      archived: archived || c.archived,
      target: null,
    }
    const at = lines.length
    lines.push(line)
    let sum = received.get(c.id) ?? 0
    for (const child of children)
      sum += walk(child, depth + 1, `${path}/${child.name}`, line.archived)
    line.activity = sum
    const hidden = c.isSystem || (line.archived && !showArchived)
    if (hidden && sum === 0 && !all) lines.splice(at)
    return sum
  }
  for (const top of byParent.get(null) ?? []) walk(top, 1, top.name, false)
  return lines
}

function section(kind: CategoryKind, totals: MonthTotals): BudgetLine {
  return {
    id: `section:${kind}`,
    name: kind === 'expense' ? '支出' : '收入',
    path: kind === 'expense' ? '支出' : '收入',
    depth: 0,
    kind: 'section',
    section: kind,
    category: null,
    hasChildren: false,
    carried: 0,
    archived: false,
    target: null,
    ...totals,
  }
}

/** Every line of the page: the expense section, then the income section. */
export function pageLines(
  categories: Array<Category>,
  month: {
    envelopes: Array<EnvelopeMonth>
    incomes: Array<IncomeMonth>
    targets?: Array<EnvelopeTarget>
  },
  options: LineOptions = {},
): Array<BudgetLine> {
  const expense = budgetLines(categories, month.envelopes, {
    ...options,
    targets: month.targets,
  })
  const income = incomeLines(categories, month.incomes, options)
  const received = income
    .filter((l) => l.depth === 1)
    .reduce((sum, l) => sum + l.activity, 0)
  return [
    section('expense', monthTotals(expense)),
    ...expense,
    section('income', { allocated: 0, activity: received, balance: 0 }),
    ...income,
  ]
}

/** The lines of one month on a page showing several. */
export interface MonthLines {
  month: string
  lines: Array<BudgetLine>
}

/**
 * The lines of several months side by side: every month has the same lines
 * in the same order (a line shows when any month would show it), so the
 * cursor's row means the same category in each.
 */
export function pageMonths(
  categories: Array<Category>,
  months: Array<{
    month: string
    envelopes: Array<EnvelopeMonth>
    incomes: Array<IncomeMonth>
    targets?: Array<EnvelopeTarget>
  }>,
  options: LineOptions = {},
): Array<MonthLines> {
  const shown = new Set(
    months.flatMap((m) => pageLines(categories, m, options).map((l) => l.id)),
  )
  return months.map((m) => ({
    month: m.month,
    lines: pageLines(categories, m, { all: true }).filter((l) =>
      shown.has(l.id),
    ),
  }))
}

/** What all envelopes of the month add up to. */
export function monthTotals(lines: Array<BudgetLine>): MonthTotals {
  const totals = { allocated: 0, activity: 0, balance: 0 }
  for (const l of lines) {
    if (l.kind !== 'envelope') continue
    totals.allocated += l.allocated
    totals.activity += l.activity
    totals.balance += l.balance
  }
  return totals
}

/** What the targets of the month's envelopes add up to. */
export function targetTotal(lines: Array<BudgetLine>): number {
  return lines.reduce(
    (sum, l) => sum + (l.kind === 'envelope' ? (l.target?.total ?? 0) : 0),
    0,
  )
}

/** Whether an envelope's allocation is not what its target asks. */
export function offTarget(line: BudgetLine): boolean {
  return (
    line.kind === 'envelope' &&
    line.target !== null &&
    line.allocated !== line.target.total
  )
}

/** A part of a target `:fill` could not fund, and how much of it is missing. */
export interface FillShort {
  line: BudgetLine
  /** The goal it belongs to; null for the base and the schedules. */
  goalId: string | null
  missing: number
}

export interface FillPlan {
  set: Array<{ line: BudgetLine; amount: number }>
  short: Array<FillShort>
}

/**
 * `:fill` (ADR-086, ADR-093): every envelope of `lines` with a target,
 * allocated that target; envelopes already there are left out, so running
 * it again changes nothing. Money comes from the pool in order: every
 * envelope's base and schedules first, in the page's order, then the goals
 * in their priority (`goalOrder`, lower first); it stops where the pool
 * runs out and says what it could not fund. What an envelope already has
 * counts first; an envelope given more than its target gives the rest back.
 * `force` (`:fill!`) fills every target whatever the pool.
 */
export function fillPlan(
  lines: Array<BudgetLine>,
  {
    pool,
    goalOrder = new Map(),
    force = false,
  }: { pool: number; goalOrder?: Map<string, number>; force?: boolean },
): FillPlan {
  const envelopes = lines.filter((l) => offTarget(l) && !l.archived)
  let left = force ? Number.POSITIVE_INFINITY : pool
  const level = new Map<string, number>()
  const wanted = new Map<string, number>()
  for (const line of envelopes) {
    const total = line.target?.total ?? 0
    // Money above the target goes back to the pool first.
    if (line.allocated > total) left += line.allocated - total
    level.set(line.id, Math.min(line.allocated, total))
    wanted.set(line.id, 0)
  }
  const short: Array<FillShort> = []
  function give(line: BudgetLine, goalId: string | null, amount: number) {
    if (amount <= 0) return
    const want = (wanted.get(line.id) ?? 0) + amount
    wanted.set(line.id, want)
    const has = level.get(line.id) ?? 0
    if (want <= has) return
    const granted = Math.min(want - has, Math.max(left, 0))
    level.set(line.id, has + granted)
    left -= granted
    const missing = Math.min(amount, want - has - granted)
    if (missing > 0) short.push({ line, goalId, missing })
  }
  for (const line of envelopes) {
    const t = line.target
    if (!t) continue
    give(
      line,
      null,
      (t.base ?? 0) + t.schedules.reduce((s, x) => s + x.amount, 0),
    )
  }
  const goals = envelopes
    .flatMap((line, at) =>
      (line.target?.goals ?? []).map((g, i) => ({ line, g, at, i })),
    )
    .toSorted(
      (a, b) =>
        (goalOrder.get(a.g.goalId) ?? Number.MAX_SAFE_INTEGER) -
          (goalOrder.get(b.g.goalId) ?? Number.MAX_SAFE_INTEGER) ||
        a.at - b.at ||
        a.i - b.i,
    )
  for (const { line, g } of goals) give(line, g.goalId, g.amount)
  return {
    set: envelopes
      .map((line) => ({ line, amount: level.get(line.id) ?? 0 }))
      .filter(({ line, amount }) => amount !== line.allocated),
    short,
  }
}

/**
 * `:copylast`: last month's allocation for each envelope that has none this
 * month (envelopes already given money are left alone), and no target: last
 * month's allocation held last month's schedules (ADR-086).
 */
export function copyLastMonth(
  current: Array<BudgetLine>,
  last: Array<BudgetLine>,
): Array<{ categoryId: string; amount: number }> {
  const before = new Map(
    last.filter((l) => l.kind === 'envelope').map((l) => [l.id, l.allocated]),
  )
  return current
    .filter(
      (l) =>
        l.kind === 'envelope' &&
        !l.archived &&
        !l.target &&
        l.allocated === 0 &&
        (before.get(l.id) ?? 0) !== 0,
    )
    .map((l) => ({ categoryId: l.id, amount: before.get(l.id) ?? 0 }))
}

/** Where a new category goes: its parent, kind and position among siblings. */
export interface NewPlace {
  parentId: string | null
  kind: CategoryKind
  index: number
  depth: number
}

/**
 * Where `o` (a sibling below), `O` (a sibling above) or `A` (the last
 * subcategory) on `line` puts a new category; on a section heading, `o` and
 * `O` add the first top-level category and `A` the last.
 */
export function newPlace(
  categories: Array<Category>,
  line: BudgetLine,
  how: 'below' | 'above' | 'child',
): NewPlace | null {
  const kind = line.section
  const c = line.category
  if (!c) {
    const top = siblingsOf(categories, null, kind)
    return {
      parentId: null,
      kind,
      index: how === 'child' ? top.length : 0,
      depth: 1,
    }
  }
  // Next to a system category (listed last): the last top-level one.
  if (c.isSystem) {
    const top = siblingsOf(categories, null, kind)
    return { parentId: null, kind, index: top.length, depth: 1 }
  }
  if (how === 'child') {
    if (line.depth >= 3) return null
    return {
      parentId: c.id,
      kind,
      index: siblingsOf(categories, c.id, kind).length,
      depth: line.depth + 1,
    }
  }
  const parentId = c.parentId ?? null
  const index = siblingsOf(categories, parentId, kind).findIndex(
    (s) => s.id === c.id,
  )
  return {
    parentId,
    kind,
    index: how === 'below' ? index + 1 : index,
    depth: line.depth,
  }
}

/**
 * The index in `lines` where a line placed after `line` and everything under
 * it goes.
 */
export function afterSubtree(lines: Array<BudgetLine>, at: number): number {
  const depth = lines[at].depth
  let i = at + 1
  while (
    i < lines.length &&
    lines[i].depth > depth &&
    lines[i].kind !== 'section'
  )
    i++
  return i
}

/**
 * A category with everything under it, as yanked or cut on the name column.
 * `id` is the category's current id, or null while it is deleted; undo and
 * paste create it again and set the new id.
 */
export interface CategoryNode {
  id: string | null
  name: string
  kind: CategoryKind
  pooled: boolean
  archived: boolean
  /** Where it was: its parent's id (for the top ones) and position. */
  parentId: string | null
  index: number
  parent: CategoryNode | null
  children: Array<CategoryNode>
  /** The category it was taken from when yanked (copies keep it too). */
  sourceId: string
}

/**
 * The categories of `ids` as trees, only the top-most ones (a subcategory of
 * one already taken comes with it), in the order of `ids`. System
 * categories are left out.
 */
export function categoryNodes(
  categories: Array<Category>,
  ids: Array<string>,
): Array<CategoryNode> {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const chosen = new Set(ids)
  const insideChosen = (c: Category) => {
    for (let p = c.parentId; p; p = byId.get(p)?.parentId ?? null)
      if (chosen.has(p)) return true
    return false
  }
  const grow = (c: Category, parent: CategoryNode | null): CategoryNode => {
    const parentId = c.parentId ?? null
    const node: CategoryNode = {
      id: c.id,
      name: c.name,
      kind: c.kind,
      pooled: c.pooled,
      archived: c.archived,
      parentId,
      index: siblingsOf(categories, parentId, c.kind).findIndex(
        (s) => s.id === c.id,
      ),
      parent,
      children: [],
      sourceId: c.id,
    }
    node.children = siblingsOf(categories, c.id, c.kind).map((child) =>
      grow(child, node),
    )
    return node
  }
  return ids
    .map((id) => byId.get(id))
    .filter((c): c is Category => !!c && !c.isSystem && !insideChosen(c))
    .map((c) => grow(c, null))
}

/** Every node, parents before their subcategories. */
export function topDown(nodes: Array<CategoryNode>): Array<CategoryNode> {
  return nodes.flatMap((n) => [n, ...topDown(n.children)])
}

/** `name`, or `name 2`, `name 3`... when a sibling already has it. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(name)) return name
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`
    const candidate = name.slice(0, 32 - suffix.length) + suffix
    if (!used.has(candidate)) return candidate
  }
}

/**
 * The envelopes from line `from` down that pasted amounts go into, one per
 * amount; fewer when the page runs out of envelopes.
 */
export function pasteTargets(
  lines: Array<BudgetLine>,
  from: number,
  count: number,
): Array<BudgetLine> {
  return lines
    .slice(Math.max(0, from))
    .filter((l) => l.kind === 'envelope' && !l.archived)
    .slice(0, count)
}
