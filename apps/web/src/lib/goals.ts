/**
 * The goals page's data model (ADR-092..094), without React: a goal as an
 * editable line and back, what typing into each cell changes, validation,
 * and what each goal has saved, asks this month and when it is reached.
 * The server works out saved amounts and asks the same way for targets
 * (`internal/domain/ledger/goals.go`); the page repeats them so unsaved
 * lines and a changed order show at once. Pure, tested with plain node
 * (`goals.test.ts`).
 */
import { amountInputValue, formatAmount } from './money.ts'
import { evalAmount, findCategory, parseDate } from './register.ts'
import type { Schemas } from './api'
import type { CategoryRef, Context } from './register.ts'

export type Goal = Schemas['Goal']
export type GoalInput = Schemas['GoalInput']
export type GoalKind = Schemas['GoalKind']
export type GoalStatus = Schemas['GoalStatus']
export type GoalList = Schemas['GoalList']
type Category = Schemas['Category']

export type GoalColumn =
  | 'name'
  | 'category'
  | 'kind'
  | 'target'
  | 'date'
  | 'monthly'
  | 'saved'
  | 'ask'
  | 'eta'
  | 'status'
  | 'wait'
  | 'url'
  | 'note'

export const goalColumns: Array<GoalColumn> = [
  'name',
  'category',
  'kind',
  'target',
  'date',
  'monthly',
  'saved',
  'ask',
  'eta',
  'status',
  'wait',
  'url',
  'note',
]

export const goalLabels: Record<GoalColumn, string> = {
  name: '名稱',
  category: '類別',
  kind: '類型',
  target: '目標',
  date: '期限',
  monthly: '每月',
  saved: '已存',
  ask: '本月',
  eta: '預計完成',
  status: '狀態',
  wait: '考慮到',
  url: '連結',
  note: '備註',
}

/** Columns worked out from the rest, never typed into. */
export const derivedColumns: ReadonlySet<GoalColumn> = new Set([
  'saved',
  'ask',
  'eta',
  'status',
])

export const kindLabels: Record<GoalKind, string> = {
  target: '目標金額',
  targetByDate: '期限前存到',
  maintain: '維持水位',
  monthly: '每月固定',
}

export const statusLabels: Record<GoalStatus, string> = {
  saving: '存錢中',
  full: '已存滿',
  waiting: '冷靜中',
  achieved: '已達成',
  archived: '已封存',
}

/** One goal as the page edits it; its priority is its place in the list. */
export interface GoalRow {
  id: string
  /** The saved goal; null for a line never saved. */
  base: Goal | null
  deleted: boolean
  name: string
  categoryId: string | null
  kind: GoalKind
  targetAmount: number | null
  /** ISO date. */
  targetDate: string | null
  monthlyAmount: number | null
  maintainMonths: number | null
  note: string
  url: string
  /** ISO date: a cooling-off period before buying. */
  waitUntil: string | null
  achieved: boolean
  archived: boolean
}

export type GoalRowStatus = 'clean' | 'new' | 'changed' | 'deleted'

export interface GoalProblem {
  field: GoalColumn | null
  message: string
}

export function rowFromGoal(g: Goal): GoalRow {
  return {
    id: g.id,
    base: g,
    deleted: false,
    name: g.name,
    categoryId: g.categoryId,
    kind: g.kind,
    targetAmount: g.targetAmount,
    targetDate: g.targetDate,
    monthlyAmount: g.monthlyAmount,
    maintainMonths: g.maintainMonths,
    note: g.note,
    url: g.url,
    waitUntil: g.waitUntil,
    achieved: g.achieved,
    archived: g.archived,
  }
}

export function newGoalRow(id: string, categoryId: string | null): GoalRow {
  return {
    id,
    base: null,
    deleted: false,
    name: '',
    categoryId,
    kind: 'target',
    targetAmount: null,
    targetDate: null,
    monthlyAmount: null,
    maintainMonths: null,
    note: '',
    url: '',
    waitUntil: null,
    achieved: false,
    archived: false,
  }
}

/** Which amounts a kind uses (the server keeps only those, ADR-092). */
export function usesColumn(kind: GoalKind, column: GoalColumn): boolean {
  switch (column) {
    case 'target':
      return kind !== 'monthly'
    case 'date':
      return kind === 'targetByDate'
    case 'monthly':
      return kind !== 'targetByDate'
    default:
      return true
  }
}

/** What :w sends for the line; amounts its kind does not use are left out. */
export function toGoalInput(row: GoalRow, sortOrder: number): GoalInput {
  const k = row.kind
  return {
    id: row.id,
    categoryId: row.categoryId ?? '',
    name: row.name.trim(),
    kind: k,
    targetAmount:
      k === 'target' || k === 'targetByDate' ? row.targetAmount : null,
    targetDate: k === 'targetByDate' ? row.targetDate : null,
    monthlyAmount: k === 'targetByDate' ? null : row.monthlyAmount,
    maintainMonths: k === 'maintain' ? row.maintainMonths : null,
    note: row.note.trim(),
    url: row.url.trim(),
    waitUntil: row.waitUntil,
    achieved: row.achieved,
    archived: row.archived,
    sortOrder,
  }
}

/** Whether the line differs from what is saved, its place aside. */
export function goalStatus(row: GoalRow): GoalRowStatus {
  if (row.deleted) return 'deleted'
  if (!row.base) return 'new'
  return JSON.stringify(toGoalInput(row, 0)) ===
    JSON.stringify(toGoalInput(rowFromGoal(row.base), 0))
    ? 'clean'
    : 'changed'
}

/**
 * Every expense category mapped to the envelope its money is budgeted in:
 * the topmost pooled category above it, or itself when it holds a budget
 * (ADR-061), as the server's `envelopeOf`. Categories in none are missing.
 */
export function envelopeMap(categories: Array<Category>): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const hasChildren = new Set(
    categories.flatMap((c) => (c.parentId ? [c.parentId] : [])),
  )
  const out = new Map<string, string>()
  for (const c of categories) {
    if (c.kind !== 'expense' || c.isSystem) continue
    let top: string | null = null
    for (let p = c.parentId; p;) {
      const parent = byId.get(p)
      if (!parent) break
      if (parent.pooled) top = parent.id
      p = parent.parentId
    }
    if (top) out.set(c.id, top)
    else if (c.pooled || !hasChildren.has(c.id)) out.set(c.id, c.id)
  }
  return out
}

/** What has to be right before :w, the first problem only. */
export function validateGoal(
  row: GoalRow,
  envelopes: Map<string, string>,
): GoalProblem | null {
  if (row.deleted) return null
  if (!row.name.trim()) return { field: 'name', message: '請輸入名稱' }
  if (!row.categoryId) return { field: 'category', message: '請選擇類別' }
  if (!envelopes.has(row.categoryId)) {
    return {
      field: 'category',
      message: '這個類別沒有預算：選一個有預算的類別',
    }
  }
  switch (row.kind) {
    case 'target':
      if (!row.targetAmount)
        return { field: 'target', message: '請輸入目標金額' }
      break
    case 'targetByDate':
      if (!row.targetAmount)
        return { field: 'target', message: '請輸入目標金額' }
      if (!row.targetDate) return { field: 'date', message: '請輸入期限' }
      break
    case 'maintain':
      if (!row.maintainMonths)
        return { field: 'target', message: '請輸入要維持幾個月的支出' }
      break
    case 'monthly':
      if (!row.monthlyAmount)
        return { field: 'monthly', message: '請輸入每月金額' }
      break
  }
  return null
}

/** A typed kind: its label, the start of it, or its code. */
export function parseKind(text: string): GoalKind | null {
  // A kind is picked from the completion list by its label (ADR-107).
  const s = text.trim()
  const hit = Object.entries(kindLabels).find(
    ([kind, label]) => label === s || kind === s,
  )
  return hit ? (hit[0] as GoalKind) : null
}

function isoToday(today: string): Date {
  const [y, m, d] = today.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** What typing `text` into a cell changes, or why it cannot (a message). */
export function goalPatch(
  row: GoalRow,
  column: GoalColumn,
  text: string,
  ctx: Context,
  envelopes: Map<string, string>,
  today: string,
): Partial<GoalRow> | string {
  const value = text.trim()
  const amount = (): number | null | string => {
    if (!value) return null
    const n = evalAmount(value, ctx.minorUnits)
    if (n === null) return '金額格式不對：可以輸入 3500、3,500 或 1200*3'
    if (n < 0) return '金額要大於 0'
    return n === 0 ? null : n
  }
  switch (column) {
    case 'name':
      if (!value) return '請輸入名稱'
      if ([...value].length > 100) return '名稱最多 100 個字'
      return { name: value }
    case 'category': {
      if (!value) return { categoryId: null }
      const found = findCategory(value, ctx.categories.values())
      if (!found) return `找不到類別「${value}」：請從清單選，或輸入完整路徑`
      if (!envelopes.has(found.id))
        return `「${found.path}」沒有預算：選一個有預算的類別`
      return { categoryId: found.id }
    }
    case 'kind': {
      const kind = parseKind(value)
      if (!kind)
        return '請從清單選類型：目標金額、期限前存到、維持水位、每月固定'
      return { kind }
    }
    case 'target': {
      if (row.kind === 'maintain') {
        if (!value) return { maintainMonths: null }
        const n = Number(value)
        if (!/^\d+$/.test(value) || n < 1 || n > 120)
          return '維持水位是 1 到 120 個月的平均支出，例如 6'
        return { maintainMonths: n }
      }
      const n = amount()
      return typeof n === 'string' ? n : { targetAmount: n }
    }
    case 'date': {
      if (!value) return { targetDate: null }
      const date = parseDate(value, isoToday(today))
      if (!date) return '看不懂這個日期：可以輸入 2027/1/31、12/25 或 +90'
      return { targetDate: date }
    }
    case 'monthly': {
      const n = amount()
      return typeof n === 'string' ? n : { monthlyAmount: n }
    }
    case 'wait': {
      if (!value) return { waitUntil: null }
      const date = parseDate(value, isoToday(today))
      if (!date) return '看不懂這個日期：可以輸入 +30、12/25 或 2026-12-25'
      return { waitUntil: date }
    }
    case 'url':
      if (value && !/^https?:\/\//i.test(value))
        return '連結要以 http:// 或 https:// 開頭'
      return { url: value }
    case 'note':
      if ([...value].length > 500) return '備註最多 500 個字'
      return { note: value }
    default:
      return '這一欄是算出來的'
  }
}

/** The text a cell editor starts with. */
export function goalCellText(
  row: GoalRow,
  column: GoalColumn,
  ctx: Context,
): string {
  const money = (n: number | null) =>
    n ? amountInputValue(n, ctx.minorUnits) : ''
  switch (column) {
    case 'name':
      return row.name
    case 'category':
      return row.categoryId
        ? (ctx.categories.get(row.categoryId)?.path ?? '')
        : ''
    case 'kind':
      return kindLabels[row.kind]
    case 'target':
      return row.kind === 'maintain'
        ? row.maintainMonths
          ? String(row.maintainMonths)
          : ''
        : money(row.targetAmount)
    case 'date':
      return row.targetDate ?? ''
    case 'monthly':
      return money(row.monthlyAmount)
    case 'wait':
      return row.waitUntil ?? ''
    case 'url':
      return row.url
    case 'note':
      return row.note
    default:
      return ''
  }
}

/** The page column a server problem's field points at. */
export function goalProblemColumn(field: string): GoalColumn | null {
  if (field === 'months') return 'target'
  return (goalColumns as Array<string>).includes(field)
    ? (field as GoalColumn)
    : null
}

/** Categories a goal can name: expense ones that are in an envelope. */
export function goalCategories(
  ctx: Context,
  envelopes: Map<string, string>,
): Array<CategoryRef> {
  return [...ctx.categories.values()].filter(
    (c) => envelopes.has(c.id) && !c.archived && !c.isSystem,
  )
}

// ---------- saved amounts, asks and the projection (ADR-092..094)

/** `2026-11` → a month count, so months can be subtracted. */
export function monthIndex(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return y * 12 + m - 1
}

export function monthOfIndex(index: number): string {
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

/** What the derivations need of a line. */
interface Spec {
  id: string
  envelope: string | null
  kind: GoalKind
  target: number
  /** ISO date, targetByDate. */
  date: string
  monthly: number
  months: number
  /** The month it was made in. */
  created: string
  open: boolean
}

function specOf(
  row: GoalRow,
  envelopes: Map<string, string>,
  month: string,
): Spec {
  return {
    id: row.id,
    envelope: row.categoryId ? (envelopes.get(row.categoryId) ?? null) : null,
    kind: row.kind,
    target: row.targetAmount ?? 0,
    date: row.targetDate ?? '',
    monthly: row.monthlyAmount ?? 0,
    months: row.maintainMonths ?? 0,
    created: row.base?.createdAt.slice(0, 7) ?? month,
    open: !row.achieved && !row.archived && !row.deleted,
  }
}

/** The amount it saves towards (the level for maintain); null for monthly. */
function totalOf(g: Spec, avgSpending: number): number | null {
  switch (g.kind) {
    case 'target':
    case 'targetByDate':
      return g.target
    case 'maintain':
      return g.months * avgSpending
    case 'monthly':
      return null
  }
}

/**
 * Each envelope's balance (never below zero) handed down its goals in
 * order: goals with a total take up to it, monthly goals what is left.
 */
export function shareBalances(
  goals: Array<Spec>,
  balance: Map<string, number>,
  takesPart: (g: Spec) => boolean,
  avgSpending: number,
): Map<string, number> {
  const left = new Map<string, number>()
  for (const [env, b] of balance) left.set(env, Math.max(b, 0))
  const saved = new Map<string, number>()
  for (const withTotal of [true, false]) {
    for (const g of goals) {
      if (!g.envelope || !takesPart(g)) continue
      const total = totalOf(g, avgSpending)
      if ((total !== null) !== withTotal) continue
      const has = left.get(g.envelope) ?? 0
      const take = total === null ? has : Math.min(has, Math.max(total, 0))
      saved.set(g.id, take)
      left.set(g.envelope, has - take)
    }
  }
  return saved
}

/** What the goal asks in the month, from what it had saved at its start. */
export function askOf(
  g: Spec,
  saved: number,
  month: string,
  avgSpending: number,
): number {
  const need = Math.max((totalOf(g, avgSpending) ?? 0) - saved, 0)
  switch (g.kind) {
    case 'target':
      return g.monthly > 0 ? Math.min(g.monthly, need) : 0
    case 'targetByDate': {
      const left = monthIndex(g.date.slice(0, 7)) - monthIndex(month) + 1
      return left <= 1 ? need : Math.ceil(need / left)
    }
    case 'maintain':
      return g.monthly > 0 ? Math.min(g.monthly, need) : need
    case 'monthly':
      return g.monthly
  }
}

/** How far ahead the projection looks (ADR-094). */
export const PROJECTION_MONTHS = 120

export interface GoalFigures {
  envelope: string | null
  saved: number
  total: number | null
  ask: number
  status: GoalStatus
  /**
   * When it is reached: `YYYY-MM`; `now` when it already has its total;
   * `never` beyond ten years; null for monthly, achieved and archived goals.
   */
  eta: string | null
}

export interface GoalSummary {
  /** Typical income less the targets without goals: free for goals. */
  free: number
  /** What the goals ask this month together. */
  asks: number
}

/**
 * Every line's figures, in the lines' order (the priority): its share of
 * its envelope's balance today, its ask this month (from the balance
 * carried into it), its status and its projected completion. The
 * projection starts next month from today's savings: each month the free
 * money goes to the goals' asks in priority order, then what is left to
 * goals that ask nothing yet still need money.
 */
export function goalFigures(
  rows: Array<GoalRow>,
  facts: Pick<
    GoalList,
    'month' | 'averageSpending' | 'typicalIncome' | 'baseTargets' | 'envelopes'
  >,
  envelopes: Map<string, string>,
  today: string,
): { figures: Map<string, GoalFigures>; summary: GoalSummary } {
  const month = facts.month
  const avg = facts.averageSpending
  const specs = rows.map((r) => specOf(r, envelopes, month))
  const balance = new Map(facts.envelopes.map((e) => [e.categoryId, e.balance]))
  const carried = new Map(facts.envelopes.map((e) => [e.categoryId, e.carried]))
  const saved = shareBalances(specs, balance, (g) => g.open, avg)
  const active = (g: Spec) =>
    g.open && monthIndex(g.created) <= monthIndex(month)
  const atStart = shareBalances(specs, carried, active, avg)
  const free = facts.typicalIncome - facts.baseTargets

  const figures = new Map<string, GoalFigures>()
  let asks = 0
  for (const [i, g] of specs.entries()) {
    const row = rows[i]
    const total = totalOf(g, avg)
    const has = saved.get(g.id) ?? 0
    const ask =
      g.envelope && active(g) ? askOf(g, atStart.get(g.id) ?? 0, month, avg) : 0
    asks += ask
    let status: GoalStatus = 'saving'
    if (row.archived) status = 'archived'
    else if (row.achieved) status = 'achieved'
    else if (total !== null && total > 0 && has >= total)
      status = row.waitUntil && row.waitUntil > today ? 'waiting' : 'full'
    figures.set(g.id, {
      envelope: g.envelope,
      saved: has,
      total,
      ask,
      status,
      eta: null,
    })
  }

  // The projection, month after month from the next one.
  const sim = new Map<string, number>()
  const pending = specs.filter((g) => {
    const f = figures.get(g.id)
    if (!f || !g.open || !g.envelope || f.total === null || f.total <= 0)
      return false
    if (f.saved >= f.total) {
      f.eta = 'now'
      return false
    }
    sim.set(g.id, f.saved)
    return true
  })
  const start = monthIndex(month) + 1
  for (let m = start; m < start + PROJECTION_MONTHS && pending.length; m++) {
    const name = monthOfIndex(m)
    let budget = Math.max(free, 0)
    const asked = new Set<string>()
    for (const g of pending) {
      const ask = askOf(g, sim.get(g.id) ?? 0, name, avg)
      if (ask > 0) asked.add(g.id)
      const give = Math.min(ask, budget)
      sim.set(g.id, (sim.get(g.id) ?? 0) + give)
      budget -= give
    }
    for (const g of pending) {
      if (asked.has(g.id) || budget <= 0) continue
      const need = (totalOf(g, avg) ?? 0) - (sim.get(g.id) ?? 0)
      const give = Math.min(Math.max(need, 0), budget)
      sim.set(g.id, (sim.get(g.id) ?? 0) + give)
      budget -= give
    }
    for (let k = pending.length - 1; k >= 0; k--) {
      const g = pending[k]
      if ((sim.get(g.id) ?? 0) >= (totalOf(g, avg) ?? 0)) {
        const f = figures.get(g.id)
        if (f) f.eta = name
        pending.splice(k, 1)
      }
    }
  }
  for (const g of pending) {
    const f = figures.get(g.id)
    if (f) f.eta = 'never'
  }
  return { figures, summary: { free, asks } }
}

/** The 預計完成 cell: `2027/03`, 已存滿, 十年以上 or —. */
export function etaText(eta: string | null): string {
  if (eta === null) return '—'
  if (eta === 'now') return '已存滿'
  if (eta === 'never') return '十年以上'
  return eta.replace('-', '/')
}

/** A cell showing an amount, empty for none. */
export function amountText(n: number | null, minorUnits: number): string {
  return n ? formatAmount(n, minorUnits) : ''
}
