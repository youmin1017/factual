import { amountInputValue, formatAmount, parseAmount } from './money.ts'
import { evalAmount, findCategory, formatDate, parseDate } from './register.ts'
import type { Schemas } from './api'
import type { Field, Option } from './form.ts'
import type { Context } from './register.ts'

// Shared expenses with one friend (M12, ADR-106) or among a group's members
// (M13, ADR-115): the lines of their page, how its cells are written and
// read back, how a total is divided into shares the same way the server
// divides it (apps/api/internal/domain/ledger/split.go), each member's
// balance and who should pay whom to settle. With a friend the page is the
// two-person case: the friend's part is whatever the caller's leaves. Pure,
// tested with node.

export type Friend = Schemas['Friend']
export type Group = Schemas['Group']
export type SharedExpense = Schemas['SharedExpense']
export type SharedExpenseInput = Schemas['SharedExpenseInput']
export type SplitMethod = Schemas['SplitMethod']

export type SplitColumn =
  | 'date'
  | 'description'
  | 'amount'
  | 'paidBy'
  | 'split'
  | 'mine'
  | 'balance'
  | 'category'
  | 'account'
  | 'note'

export const splitColumns: Array<SplitColumn> = [
  'date',
  'description',
  'amount',
  'paidBy',
  'split',
  'mine',
  'balance',
  'category',
  'account',
  'note',
]

export const splitLabels: Record<SplitColumn, string> = {
  date: '日期',
  description: '項目',
  amount: '金額',
  paidBy: '誰付',
  split: '分法',
  mine: '我的份',
  balance: '往來',
  category: '類別',
  account: '帳戶',
  note: '備註',
}

/** Columns worked out from the others. */
export const derivedSplitColumns: ReadonlySet<SplitColumn> = new Set([
  'mine',
  'balance',
])

export interface Foreign {
  currency: string
  /** In that currency's minor units. */
  amount: number
}

export interface Member {
  id: string
  name: string
}

/** The people of a page. */
export interface People {
  /** The caller. */
  me: string
  /** Everyone who can take part, the caller first. */
  members: Array<Member>
  /** With one friend: the friend's id; null in a group. */
  friend: string | null
}

export interface SplitRow {
  id: string
  /** The saved expense; null for a line never saved. */
  base: SharedExpense | null
  deleted: boolean
  /** ISO date. */
  date: string
  description: string
  total: number | null
  foreign: Foreign | null
  /** Who paid: a member, or null when several did (`paid`). */
  payer: string | null
  /** What each paid when several did; with a friend only the caller's (the friend paid the rest). */
  paid: Record<string, number>
  /** A settlement: the payer pays the whole amount to the receiver. */
  settlement: boolean
  /** A settlement's receiver; with a friend null, the other one. */
  receiver: string | null
  method: SplitMethod
  /** equal: who shares (shown and sent in member order). */
  among: Array<string>
  /** exact: each one's share; with a friend only the caller's (the friend's is the rest). */
  amounts: Record<string, number>
  /** percent: each one's percentage (with a friend only the caller's); shares: each one's number. */
  weights: Record<string, number>
  categoryId: string | null
  accountId: string | null
  note: string
}

export type SplitRowStatus = 'clean' | 'new' | 'changed' | 'deleted'

export interface SplitProblem {
  field: SplitColumn | null
  message: string
}

// ---------- people

/** People for a friend's page. */
export function friendPeople(me: string, friend: Friend): People {
  return {
    me,
    members: [
      { id: me, name: '我' },
      { id: friend.id, name: friend.displayName },
    ],
    friend: friend.id,
  }
}

/** People for a group's page: the caller first, then the others in the group's order. */
export function groupPeople(me: string, group: Group): People {
  return {
    me,
    members: [
      { id: me, name: '我' },
      ...group.members
        .filter((m) => m.userId !== me)
        .map((m) => ({ id: m.userId, name: m.displayName })),
    ],
    friend: null,
  }
}

/** How a member is called on the page: 我 for the caller. */
export function nameOf(people: People, id: string): string {
  if (id === people.me) return '我'
  return people.members.find((m) => m.id === id)?.name ?? '（已不在群組）'
}

/** The ids in member order; ids of people no longer members last. */
function inOrder(people: People, ids: Iterable<string>): Array<string> {
  const set = new Set(ids)
  const known = people.members.map((m) => m.id).filter((id) => set.has(id))
  const rest = [...set].filter((id) => !known.includes(id))
  return [...known, ...rest]
}

function friendOf(people: People): string | null {
  return people.friend
}

/** A settlement's receiver: its own, or with a friend the other one. */
export function receiverOf(row: SplitRow, people: People): string | null {
  if (row.receiver) return row.receiver
  const friend = friendOf(people)
  if (!friend || !row.payer) return null
  return row.payer === people.me ? friend : people.me
}

// ---------- dividing

/** Weights are kept to four decimals, as numeric(12, 4). */
export const WEIGHT_SCALE = 10000

export function scaledWeight(w: number): number | null {
  if (!Number.isFinite(w) || w < 0 || w >= 1e8) return null
  return Math.round(w * WEIGHT_SCALE)
}

/**
 * Splits total in proportion to weights by the largest remainder method:
 * the floor of each exact part, then the units left over to the largest
 * remainders, ties to the earlier weight.
 */
export function divide(total: number, weights: Array<number>): Array<number> {
  const sum = weights.reduce((a, w) => a + BigInt(w), 0n)
  const t = BigInt(total)
  const parts = weights.map((w) => (t * BigInt(w)) / sum)
  const rems = weights.map((w) => (t * BigInt(w)) % sum)
  let left = t - parts.reduce((a, p) => a + p, 0n)
  for (; left > 0n; left--) {
    let best = -1
    for (const [i, r] of rems.entries()) {
      if (weights[i] > 0 && (best < 0 || r > rems[best])) best = i
    }
    parts[best]++
    rems[best] = -1n
  }
  return parts.map(Number)
}

function roundWeight(w: number): number {
  return Math.round(w * WEIGHT_SCALE) / WEIGHT_SCALE
}

/** What each participant's weight is, in member order (percent and shares). */
function weightsOf(row: SplitRow, people: People): Array<[string, number]> {
  const friend = friendOf(people)
  if (friend && row.method === 'percent') {
    const mine = row.weights[people.me] as number | undefined
    if (mine === undefined) return []
    return [
      [people.me, mine],
      [friend, roundWeight(100 - mine)],
    ]
  }
  return inOrder(people, Object.keys(row.weights)).map((id) => [
    id,
    row.weights[id],
  ])
}

/** What each participant's exact share is, in member order. */
function amountsOf(
  row: SplitRow,
  people: People,
  total: number,
): Array<[string, number]> {
  const friend = friendOf(people)
  if (friend) {
    const mine = row.amounts[people.me] as number | undefined
    if (mine === undefined) return []
    return [
      [people.me, mine],
      [friend, total - mine],
    ]
  }
  return inOrder(people, Object.keys(row.amounts)).map((id) => [
    id,
    row.amounts[id],
  ])
}

/** Each participant's share, in member order, or null while it cannot be worked out. */
export function sharesOf(
  row: SplitRow,
  people: People,
): Map<string, number> | null {
  const total = row.total
  if (!total || total <= 0) return null
  if (row.settlement) {
    const receiver = receiverOf(row, people)
    if (!row.payer || !receiver || receiver === row.payer) return null
    return new Map([
      [row.payer, 0],
      [receiver, total],
    ])
  }
  switch (row.method) {
    case 'equal': {
      const ids = inOrder(people, row.among)
      if (ids.length === 0) return null
      const parts = divide(
        total,
        ids.map(() => 1),
      )
      return new Map(ids.map((id, i) => [id, parts[i]]))
    }
    case 'exact': {
      const parts = amountsOf(row, people, total)
      if (parts.length === 0 || parts.some(([, n]) => n < 0)) return null
      if (parts.reduce((s, [, n]) => s + n, 0) !== total) return null
      return new Map(parts)
    }
    default: {
      const parts = weightsOf(row, people)
      if (parts.length === 0) return null
      if (friendOf(people) && parts.length !== 2) return null
      const scaled = parts.map(([, w]) => scaledWeight(w))
      if (scaled.some((w) => w === null)) return null
      const ws = scaled as Array<number>
      const sum = ws.reduce((a, w) => a + w, 0)
      if (row.method === 'percent' && sum !== 100 * WEIGHT_SCALE) return null
      if (sum === 0) return null
      const split = divide(total, ws)
      return new Map(parts.map(([id], i) => [id, split[i]]))
    }
  }
}

/** What each payer paid, in member order, or null while it does not add up. */
export function paidBy(
  row: SplitRow,
  people: People,
): Map<string, number> | null {
  const total = row.total
  if (!total || total <= 0) return null
  if (row.payer) return new Map([[row.payer, total]])
  const friend = friendOf(people)
  if (friend) {
    const mine = row.paid[people.me] as number | undefined
    if (mine === undefined || mine <= 0 || mine >= total) return null
    return new Map([
      [people.me, mine],
      [friend, total - mine],
    ])
  }
  const parts = inOrder(people, Object.keys(row.paid))
    .map((id): [string, number] => [id, row.paid[id]])
    .filter(([, n]) => n !== 0)
  if (parts.length === 0 || parts.some(([, n]) => n < 0)) return null
  if (parts.reduce((s, [, n]) => s + n, 0) !== total) return null
  return new Map(parts)
}

/** What the caller paid. */
export function paidOf(row: SplitRow, people: People): number {
  return paidBy(row, people)?.get(people.me) ?? 0
}

/** The caller's share, or null while it cannot be worked out. */
export function myShareOf(row: SplitRow, people: People): number | null {
  const shares = sharesOf(row, people)
  return shares ? (shares.get(people.me) ?? 0) : null
}

/** How the line moves each member's balance: paid less share. */
export function effectsOf(
  row: SplitRow,
  people: People,
): Map<string, number> | null {
  if (row.deleted) return new Map()
  const shares = sharesOf(row, people)
  const paid = paidBy(row, people)
  if (!shares || !paid) return null
  const out = new Map<string, number>()
  for (const [id, n] of paid) out.set(id, (out.get(id) ?? 0) + n)
  for (const [id, n] of shares) out.set(id, (out.get(id) ?? 0) - n)
  return out
}

/** How the line moves the caller's friend or group account. */
export function effectOf(row: SplitRow, people: People): number | null {
  const effects = effectsOf(row, people)
  return effects ? (effects.get(people.me) ?? 0) : null
}

/** The caller's account balance after each line, oldest first. */
export function runningBalances(
  rows: Array<SplitRow>,
  people: People,
): Array<number> {
  const order = rows
    .map((r, i) => ({ r, i }))
    .toSorted((a, b) => a.r.date.localeCompare(b.r.date) || a.i - b.i)
  const out: Array<number> = Array.from({ length: rows.length }, () => 0)
  let balance = 0
  for (const { r, i } of order) {
    balance += effectOf(r, people) ?? 0
    out[i] = balance
  }
  return out
}

/** Every member's balance over the lines: what they are owed (negative: owe). */
export function memberBalances(
  rows: Array<SplitRow>,
  people: People,
): Map<string, number> {
  const out = new Map(people.members.map((m) => [m.id, 0]))
  for (const r of rows) {
    for (const [id, n] of effectsOf(r, people) ?? [])
      out.set(id, (out.get(id) ?? 0) + n)
  }
  return out
}

export interface Transfer {
  from: string
  to: string
  amount: number
}

/**
 * Who pays whom to settle the balances (ADR-037: a suggestion, the ledger
 * holds net positions): the largest debt is paid to the largest credit
 * until nothing is owed, so there are at most one fewer transfers than
 * people with a balance. Ties go to the earlier member.
 */
export function settleUp(
  balances: Map<string, number>,
  people: People,
): Array<Transfer> {
  const order = inOrder(people, balances.keys())
  const left = new Map(order.map((id) => [id, balances.get(id) ?? 0]))
  const out: Array<Transfer> = []
  const largest = (sign: 1 | -1) => {
    let best: string | null = null
    for (const id of order) {
      const n = (left.get(id) ?? 0) * sign
      if (n > 0 && (best === null || n > (left.get(best) ?? 0) * sign))
        best = id
    }
    return best
  }
  for (;;) {
    const debtor = largest(-1)
    const creditor = largest(1)
    if (!debtor || !creditor) return out
    const amount = Math.min(-(left.get(debtor) ?? 0), left.get(creditor) ?? 0)
    out.push({ from: debtor, to: creditor, amount })
    left.set(debtor, (left.get(debtor) ?? 0) + amount)
    left.set(creditor, (left.get(creditor) ?? 0) - amount)
  }
}

// ---------- rows

export function rowFromExpense(x: SharedExpense, people: People): SplitRow {
  const friend = friendOf(people)
  const settlement = x.kind === 'settlement'
  const payer = x.payers.length === 1 ? x.payers[0].userId : null
  const all = people.members.map((m) => m.id)
  const pick = (f: (s: SharedExpense['shares'][number]) => number | null) =>
    Object.fromEntries(
      x.shares.flatMap((s) => {
        const n = f(s)
        return n === null ? [] : [[s.userId, n]]
      }),
    ) as Record<string, number>
  const mine = x.shares.find((s) => s.userId === people.me)
  let amounts: Record<string, number> = {}
  let weights: Record<string, number> = {}
  if (!settlement && x.splitMethod === 'exact') {
    amounts = friend
      ? { [people.me]: mine?.amount ?? 0 }
      : pick((s) => s.amount)
  }
  if (!settlement && x.splitMethod === 'percent') {
    weights =
      friend && mine?.weight != null
        ? { [people.me]: mine.weight }
        : pick((s) => s.weight)
  }
  if (!settlement && x.splitMethod === 'shares') weights = pick((s) => s.weight)
  return {
    id: x.id,
    base: x,
    deleted: false,
    date: x.date,
    description: x.description,
    total: x.total,
    foreign: x.foreign
      ? { currency: x.foreign.currency, amount: x.foreign.amount }
      : null,
    payer,
    paid: payer
      ? {}
      : friend
        ? {
            [people.me]:
              x.payers.find((p) => p.userId === people.me)?.amount ?? 0,
          }
        : Object.fromEntries(x.payers.map((p) => [p.userId, p.amount])),
    settlement,
    receiver:
      settlement && !friend
        ? (x.shares.find((s) => s.amount > 0)?.userId ?? null)
        : null,
    method: settlement ? 'exact' : x.splitMethod,
    among:
      !settlement && x.splitMethod === 'equal'
        ? inOrder(
            people,
            x.shares.map((s) => s.userId),
          )
        : all,
    amounts,
    weights,
    categoryId: x.mine.categoryId,
    accountId: x.mine.accountId,
    note: x.note,
  }
}

export function newSplitRow(
  id: string,
  date: string,
  accountId: string | null,
  categoryId: string | null,
  people: People,
): SplitRow {
  return {
    id,
    base: null,
    deleted: false,
    date,
    description: '',
    total: null,
    foreign: null,
    payer: people.me,
    paid: {},
    settlement: false,
    receiver: null,
    method: 'equal',
    among: people.members.map((m) => m.id),
    amounts: {},
    weights: {},
    categoryId,
    accountId,
    note: '',
  }
}

/** What the caller needs to say: the account paid from or into, the category of their share. */
export function needs(
  row: SplitRow,
  people: People,
): { account: boolean; category: boolean } {
  if (row.settlement) {
    const me = people.me
    return {
      account: row.payer === me || receiverOf(row, people) === me,
      category: false,
    }
  }
  const share = myShareOf(row, people)
  return {
    account:
      row.payer === people.me ||
      (row.payer === null && (row.paid[people.me] ?? 0) > 0),
    category: share === null || share > 0,
  }
}

export function toSplitInput(
  row: SplitRow,
  people: People,
): SharedExpenseInput {
  const total = row.total ?? 0
  const friend = friendOf(people)
  const paid = paidBy(row, people)
  const payers = paid
    ? [...paid].map(([userId, amount]) => ({ userId, amount }))
    : row.payer
      ? [{ userId: row.payer, amount: total }]
      : inOrder(people, Object.keys(row.paid)).map((userId) => ({
          userId,
          amount: row.paid[userId],
        }))
  const need = needs(row, people)
  const input: SharedExpenseInput = {
    id: row.id,
    kind: row.settlement ? 'settlement' : 'expense',
    date: row.date,
    description: row.description.trim(),
    note: row.note.trim(),
    total,
    splitMethod: row.settlement ? 'exact' : row.method,
    payers,
    shares: [],
  }
  if (row.settlement) {
    const receiver = receiverOf(row, people)
    input.shares = receiver ? [{ userId: receiver }] : []
  } else {
    switch (row.method) {
      case 'equal':
        input.shares = inOrder(people, row.among).map((userId) => ({ userId }))
        break
      case 'exact':
        input.shares = amountsOf(row, people, total).map(
          ([userId, amount]) => ({ userId, amount }),
        )
        break
      default:
        input.shares = weightsOf(row, people).map(([userId, weight]) => ({
          userId,
          weight,
        }))
        if (friend && input.shares.length === 0)
          input.shares = [
            { userId: people.me, weight: 0 },
            { userId: friend, weight: 0 },
          ]
    }
  }
  if (row.foreign) input.foreign = { ...row.foreign }
  if (need.account && row.accountId) input.accountId = row.accountId
  if (need.category && row.categoryId) input.categoryId = row.categoryId
  return input
}

export function splitStatus(row: SplitRow, people: People): SplitRowStatus {
  if (row.deleted) return 'deleted'
  if (!row.base) return 'new'
  return JSON.stringify(toSplitInput(row, people)) ===
    JSON.stringify(toSplitInput(rowFromExpense(row.base, people), people))
    ? 'clean'
    : 'changed'
}

export function validateSplit(
  row: SplitRow,
  ctx: Context,
  people: People,
): SplitProblem | null {
  if (row.deleted) return null
  const friend = friendOf(people)
  if (!row.description.trim())
    return { field: 'description', message: '請輸入項目，例如：晚餐、計程車' }
  if (!row.total || row.total <= 0)
    return { field: 'amount', message: '請輸入金額' }
  if (row.settlement && !row.payer)
    return { field: 'paidBy', message: '還款只有一個人付' }
  if (!paidBy(row, people)) {
    return {
      field: 'paidBy',
      message: friend
        ? '兩個人都有付時，我付的要大於 0、小於總額'
        : '每個人付的要加起來等於總額',
    }
  }
  if (!sharesOf(row, people)) {
    return {
      field: 'split',
      message: row.settlement
        ? '還給誰？要是另一位成員'
        : row.method === 'percent'
          ? '比例要加起來 100%'
          : row.method === 'exact'
            ? friend
              ? '我的份要在 0 和總額之間'
              : '每個人的份要加起來等於總額'
            : row.method === 'equal'
              ? '至少要有一個人分'
              : '請輸入每個人的份數',
    }
  }
  const need = needs(row, people)
  if (need.account) {
    if (!row.accountId)
      return {
        field: 'account',
        message: row.settlement ? '錢進或出哪個帳戶？' : '我從哪個帳戶付的？',
      }
    const a = ctx.accounts.get(row.accountId)
    if (!a || !a.onBudget || a.closed)
      return { field: 'account', message: '要選預算內、沒有關閉的帳戶' }
  }
  if (need.category && !row.categoryId)
    return { field: 'category', message: '我的份要記在哪個類別？' }
  return null
}

// ---------- cells

/** Minor units of currencies amounts are kept in (as MinorUnits on the server). */
const wholeCurrencies = new Set([
  'TWD',
  'JPY',
  'KRW',
  'VND',
  'CLP',
  'ISK',
  'HUF',
])

export function currencyUnits(code: string): number {
  return wholeCurrencies.has(code) ? 0 : 2
}

function amountText(n: number, minorUnits: number): string {
  return amountInputValue(n, minorUnits)
}

function weightText(w: number): string {
  return String(roundWeight(w))
}

/** Who paid, as the cell says it: 我、小明、我 1000 (with a friend, both paid) or 我、小明 (several). */
export function payerText(
  row: SplitRow,
  people: People,
  minorUnits: number,
): string {
  if (row.payer) return nameOf(people, row.payer)
  if (friendOf(people)) {
    const mine = row.paid[people.me] as number | undefined
    return `我 ${mine === undefined ? '' : amountText(mine, minorUnits)}`
  }
  const ids = inOrder(people, Object.keys(row.paid)).filter(
    (id) => row.paid[id] !== 0,
  )
  return ids.map((id) => nameOf(people, id)).join('、')
}

export function splitCellText(
  row: SplitRow,
  column: SplitColumn,
  ctx: Context,
  people: People,
): string {
  const money = (n: number | null) =>
    n === null ? '' : amountText(n, ctx.minorUnits)
  switch (column) {
    case 'date':
      return row.date
    case 'description':
      return row.description
    case 'amount':
      return money(row.total)
    case 'paidBy':
      return payerText(row, people, ctx.minorUnits)
    case 'split':
      return splitText(row, people, ctx.minorUnits)
    case 'category':
      return row.categoryId
        ? (ctx.categories.get(row.categoryId)?.path ?? '')
        : ''
    case 'account':
      return row.accountId ? (ctx.accounts.get(row.accountId)?.name ?? '') : ''
    case 'note':
      return row.note
    default:
      return ''
  }
}

/** The split as the cell says it: 平分、我、小明平分、我 300、我 40%、2:1、還款、還給小明. */
export function splitText(
  row: SplitRow,
  people: People,
  minorUnits: number,
): string {
  const friend = friendOf(people)
  if (row.settlement) {
    const to = receiverOf(row, people)
    return friend || !to ? '還款' : `還給${nameOf(people, to)}`
  }
  switch (row.method) {
    case 'equal': {
      const ids = inOrder(people, row.among)
      if (people.members.every((m) => ids.includes(m.id))) return '平分'
      if (ids.length === 0) return ''
      return ids.length <= 3
        ? `${ids.map((id) => nameOf(people, id)).join('、')}平分`
        : `${ids.length} 人平分`
    }
    case 'exact': {
      const mine = row.amounts[people.me] as number | undefined
      if (mine !== undefined) return `我 ${amountText(mine, minorUnits)}`
      return Object.keys(row.amounts).length > 0 ? '指定金額' : ''
    }
    case 'percent': {
      const mine = row.weights[people.me] as number | undefined
      if (mine !== undefined) return `我 ${weightText(mine)}%`
      return Object.keys(row.weights).length > 0 ? '比例' : ''
    }
    case 'shares': {
      const parts = weightsOf(row, people)
      return parts.map(([, w]) => weightText(w)).join(':')
    }
  }
}

/** What an amount cell says: the total, in the budget's currency. */
export function parseTotal(
  text: string,
  minorUnits: number,
): Pick<SplitRow, 'total'> | string {
  const s = text.trim()
  if (s === '') return { total: null }
  const n = evalAmount(s, minorUnits)
  if (n === null) return '金額格式不對：可以輸入 2400 或 1200*2'
  if (n <= 0) return '金額要大於 0'
  return { total: n }
}

// ---------- the split form (ADR-107)

/** The columns whose value is edited in the split form. */
export const formColumns: ReadonlySet<SplitColumn> = new Set([
  'paidBy',
  'split',
])

const SEVERAL = 'several'

/** The form's values for a line. */
export function splitFormValues(
  row: SplitRow,
  people: People,
  minorUnits: number,
): Record<string, string> {
  const money = (n: number | undefined | null) =>
    n === undefined || n === null ? '' : amountText(n, minorUnits)
  const friend = friendOf(people)
  const half = row.total ? Math.floor(row.total / 2) : null
  const me = people.me
  const values: Record<string, string> = {
    kind: row.settlement ? 'settlement' : 'expense',
    payer: row.payer ?? SEVERAL,
    receiver:
      receiverOf(row, people) ??
      people.members.find((m) => m.id !== (row.payer ?? me))?.id ??
      '',
    method: row.settlement ? 'equal' : row.method,
    currency: row.foreign?.currency ?? '',
    foreign: row.foreign
      ? amountText(row.foreign.amount, currencyUnits(row.foreign.currency))
      : '',
  }
  const among = row.method === 'equal' && !row.settlement ? row.among : null
  for (const m of people.members) {
    const id = m.id
    values[`paid:${id}`] = money(row.paid[id])
    values[`in:${id}`] = !among || among.includes(id) ? 'yes' : 'no'
    values[`amt:${id}`] = row.method === 'exact' ? money(row.amounts[id]) : ''
    values[`pct:${id}`] =
      row.method === 'percent' && id in row.weights
        ? weightText(row.weights[id])
        : ''
    // Switching to shares starts everyone at one; a shares line keeps who
    // had none out of it.
    values[`w:${id}`] =
      row.method !== 'shares'
        ? '1'
        : id in row.weights
          ? weightText(row.weights[id])
          : ''
  }
  if (friend) {
    values[`paid:${me}`] = money(row.paid[me] ?? half)
    values[`amt:${me}`] = money(
      row.method === 'exact' ? (row.amounts[me] ?? half) : half,
    )
    if (values[`pct:${me}`] === '') values[`pct:${me}`] = '50'
  }
  return values
}

/** The form's fields for its values. */
export function splitFormFields(
  values: Record<string, string>,
  people: People,
  currencies: Array<Option>,
): Array<Field> {
  const friend = friendOf(people)
  const me = people.me
  const who = friend ? nameOf(people, friend) : ''
  const settlement = values.kind === 'settlement'
  const fields: Array<Field> = [
    {
      key: 'kind',
      label: '類型',
      type: 'choice',
      options: [
        { value: 'expense', label: '一起花的錢' },
        { value: 'settlement', label: '還款' },
      ],
    },
  ]
  if (settlement && friend) {
    fields.push({
      key: 'payer',
      label: '誰還誰',
      type: 'choice',
      options: [
        { value: me, label: `我還${who}` },
        { value: friend, label: `${who}還我` },
      ],
    })
  } else if (settlement) {
    fields.push(
      {
        key: 'payer',
        label: '誰還',
        type: 'choice',
        options: people.members.map((m) => ({ value: m.id, label: m.name })),
      },
      {
        key: 'receiver',
        label: '還給',
        type: 'choice',
        options: people.members
          .filter((m) => m.id !== values.payer)
          .map((m) => ({ value: m.id, label: m.name })),
      },
    )
  } else {
    fields.push({
      key: 'payer',
      label: '誰付',
      type: 'choice',
      options: [
        ...people.members.map((m) => ({ value: m.id, label: m.name })),
        { value: SEVERAL, label: friend ? '兩人都有付' : '多人付' },
      ],
    })
    if (values.payer === SEVERAL) {
      if (friend) {
        fields.push({
          key: `paid:${me}`,
          label: '我付了',
          type: 'amount',
          placeholder: '其餘是對方付的',
        })
      } else {
        for (const m of people.members)
          fields.push({
            key: `paid:${m.id}`,
            label: `${m.name}付了`,
            type: 'amount',
            placeholder: '0',
          })
      }
    }
    fields.push({
      key: 'method',
      label: '分法',
      type: 'choice',
      options: [
        { value: 'equal', label: '平分' },
        { value: 'exact', label: '指定金額' },
        { value: 'percent', label: '比例' },
        { value: 'shares', label: '份數' },
      ],
    })
    const each = (
      prefix: string,
      label: (m: Member) => string,
      extra: Partial<Field> = {},
    ) => {
      for (const m of people.members)
        fields.push({
          key: `${prefix}:${m.id}`,
          label: label(m),
          type: 'number',
          ...extra,
        } as Field)
    }
    switch (values.method) {
      case 'equal':
        if (!friend)
          for (const m of people.members)
            fields.push({
              key: `in:${m.id}`,
              label: m.name,
              type: 'choice',
              options: [
                { value: 'yes', label: '分' },
                { value: 'no', label: '不分' },
              ],
            })
        break
      case 'exact':
        if (friend)
          fields.push({ key: `amt:${me}`, label: '我的份', type: 'amount' })
        else
          for (const m of people.members)
            fields.push({
              key: `amt:${m.id}`,
              label: `${m.name}的份`,
              type: 'amount',
              placeholder: '不分',
            })
        break
      case 'percent':
        if (friend)
          fields.push({
            key: `pct:${me}`,
            label: '我出',
            type: 'number',
            suffix: '%',
          })
        else each('pct', (m) => m.name, { suffix: '%', placeholder: '不分' })
        break
      case 'shares':
        if (friend)
          fields.push(
            { key: `w:${me}`, label: '我的份數', type: 'number' },
            { key: `w:${friend}`, label: `${who}的份數`, type: 'number' },
          )
        else each('w', (m) => `${m.name}的份數`, { placeholder: '不分' })
        break
      default:
        break
    }
  }
  fields.push({
    key: 'currency',
    label: '外幣',
    type: 'choice',
    options: [{ value: '', label: '無' }, ...currencies],
  })
  if (values.currency !== '') {
    fields.push({
      key: 'foreign',
      label: '原幣金額',
      type: 'amount',
      suffix: values.currency,
    })
  }
  return fields
}

/** What the form's values change on a line, or why they cannot. */
export function applySplitForm(
  row: SplitRow,
  values: Record<string, string>,
  people: People,
  minorUnits: number,
): Partial<SplitRow> | string {
  const total = row.total
  const friend = friendOf(people)
  const me = people.me
  const settlement = values.kind === 'settlement'
  const money = (n: number) => formatAmount(Math.abs(n), minorUnits)
  /** The amounts typed per member (blank left out), or why one is wrong. */
  const typed = (
    prefix: string,
    read: (s: string) => number | null,
    bad: string,
  ): Record<string, number> | string => {
    const out: Record<string, number> = {}
    for (const m of people.members) {
      const text = (values[`${prefix}:${m.id}`] ?? '').trim()
      if (text === '') continue
      const n = read(text)
      if (n === null || n < 0) return bad
      out[m.id] = n
    }
    return out
  }
  const sum = (r: Record<string, number>) =>
    Object.values(r).reduce((a, n) => a + n, 0)
  const patch: Partial<SplitRow> = {
    settlement,
    payer: values.payer === SEVERAL ? null : values.payer,
    paid: {},
    receiver: null,
    method: 'equal',
    among: people.members.map((m) => m.id),
    amounts: {},
    weights: {},
  }
  if (settlement) {
    if (values.payer === SEVERAL) return '還款只有一個人付'
    patch.method = 'exact'
    if (!friend) {
      if (!values.receiver || values.receiver === values.payer)
        return '還給誰？要是另一位成員'
      patch.receiver = values.receiver
    }
  } else {
    if (values.payer === SEVERAL) {
      if (friend) {
        const paid = evalAmount(values[`paid:${me}`] ?? '', minorUnits)
        if (paid === null || paid <= 0 || (total !== null && paid >= total))
          return '兩個人都有付時，我付的要大於 0、小於總額'
        patch.paid = { [me]: paid }
      } else {
        const paid = typed(
          'paid',
          (s) => evalAmount(s, minorUnits),
          '付的錢不能是負的',
        )
        if (typeof paid === 'string') return paid
        for (const [id, n] of Object.entries(paid)) if (n === 0) delete paid[id]
        if (Object.keys(paid).length === 0) return '請輸入每個人付了多少'
        if (total !== null && sum(paid) !== total)
          return `每個人付的要加起來等於總額（現在差 ${money(total - sum(paid))}）`
        patch.paid = paid
      }
    }
    patch.method = values.method as SplitMethod
    switch (patch.method) {
      case 'equal':
        if (!friend) {
          const among = people.members
            .map((m) => m.id)
            .filter((id) => values[`in:${id}`] !== 'no')
          if (among.length === 0) return '至少要有一個人分'
          patch.among = among
        }
        break
      case 'exact': {
        if (friend) {
          const mine = evalAmount(values[`amt:${me}`] ?? '', minorUnits)
          if (mine === null || mine < 0 || (total !== null && mine > total))
            return '我的份要在 0 和總額之間'
          patch.amounts = { [me]: mine }
          break
        }
        const amounts = typed(
          'amt',
          (s) => evalAmount(s, minorUnits),
          '每個人的份不能是負的',
        )
        if (typeof amounts === 'string') return amounts
        if (Object.keys(amounts).length === 0) return '請輸入每個人的份'
        if (total !== null && sum(amounts) !== total)
          return `每個人的份要加起來等於總額（現在差 ${money(total - sum(amounts))}）`
        patch.amounts = amounts
        break
      }
      case 'percent': {
        if (friend) {
          const p = Number(values[`pct:${me}`])
          if (!Number.isFinite(p) || p < 0 || p > 100) return '比例是 0 到 100'
          patch.weights = { [me]: p }
          break
        }
        const weights = typed(
          'pct',
          (s) => {
            const n = Number(s)
            return Number.isFinite(n) && n <= 100 ? n : null
          },
          '比例是 0 到 100',
        )
        if (typeof weights === 'string') return weights
        if (Math.round(sum(weights) * WEIGHT_SCALE) !== 100 * WEIGHT_SCALE)
          return `比例要加起來 100%（現在是 ${roundWeight(sum(weights))}%）`
        patch.weights = weights
        break
      }
      case 'shares': {
        const weights = typed(
          'w',
          (s) => {
            const n = Number(s)
            return Number.isFinite(n) ? n : null
          },
          '份數不能是負的',
        )
        if (typeof weights === 'string') return weights
        if (friend) {
          if (!(me in weights) || !(friend in weights))
            return '兩個人都要有份數'
        }
        if (sum(weights) === 0) return '份數不能都是 0'
        patch.weights = weights
        break
      }
      default:
        break
    }
  }
  if (values.currency) {
    const amount = parseAmount(values.foreign, currencyUnits(values.currency))
    if (amount === null || amount <= 0)
      return `請輸入原本付了多少 ${values.currency}`
    patch.foreign = { currency: values.currency, amount }
  } else {
    patch.foreign = null
  }
  return patch
}

export function splitPatch(
  column: SplitColumn,
  text: string,
  ctx: Context,
  today: Date,
): Partial<SplitRow> | string {
  const value = text.trim()
  switch (column) {
    case 'date': {
      const date = parseDate(value, today)
      if (!date) return '看不懂這個日期：可以輸入 11/5、5、t（今天）或 -1'
      return { date }
    }
    case 'description':
      if (!value) return '請輸入項目'
      if ([...value].length > 200) return '項目最多 200 個字'
      return { description: value }
    case 'amount':
      return parseTotal(value, ctx.minorUnits)
    case 'category': {
      if (!value) return { categoryId: null }
      const found = findCategory(value, ctx.categories.values())
      if (!found) return `找不到類別「${value}」：請從清單選，或輸入完整路徑`
      return { categoryId: found.id }
    }
    case 'account': {
      if (!value) return { accountId: null }
      const usable = [...ctx.accounts.values()].filter(
        (a) => a.onBudget && !a.closed,
      )
      const found =
        usable.find((a) => a.name === value) ??
        (() => {
          const near = usable.filter((a) => a.name.includes(value))
          return near.length === 1 ? near[0] : undefined
        })()
      if (!found) return `找不到預算內的帳戶「${value}」`
      return { accountId: found.id }
    }
    case 'note':
      if ([...value].length > 1000) return '備註最多 1000 個字'
      return { note: value }
    default:
      return '這一欄是算出來的'
  }
}

/** The page's column for a problem the server reported. */
export function splitProblemColumn(field: string): SplitColumn | null {
  switch (field) {
    case 'payers':
      return 'paidBy'
    case 'shares':
    case 'kind':
      return 'split'
    default:
      return (splitColumns as Array<string>).includes(field)
        ? (field as SplitColumn)
        : null
  }
}

/** zh-TW messages for the problems the server reports per expense. */
export const splitProblemMessages: Record<string, string> = {
  description_required: '請輸入項目',
  too_long: '內容太長',
  invalid_amount: '金額要大於 0',
  invalid_kind: '分法看不懂',
  invalid_split: '分法看不懂',
  invalid_payers: '付款的人要是成員，每人一次，金額大於 0',
  payers_total: '付的錢要加起來等於總額',
  invalid_shares: '分攤的人要是成員，每人一次；還款要還給另一位成員',
  shares_total: '每個人的份要加起來等於總額',
  percent_total: '比例要加起來 100%',
  account_required: '要選錢進出的帳戶',
  unknown_account: '帳戶不存在',
  account_not_on_budget: '要選預算內、沒有關閉的帳戶',
  category_required: '我的份要記在哪個類別？',
  unknown_category: '類別不存在',
  not_found: '找不到這筆分帳，可能已在別處刪除',
  not_recorder: '只有記這筆分帳的人能修改',
  duplicate_id: '這筆分帳重複出現',
}

// ---------- the line in words

/** The cursor's line in a sentence: who paid, who owes what. */
export function describeLine(
  row: SplitRow,
  people: People,
  minorUnits: number,
): string | null {
  const shares = sharesOf(row, people)
  const effects = effectsOf(row, people)
  if (!shares || !effects || !row.total) return null
  const money = (n: number) => formatAmount(n, minorUnits)
  const friend = friendOf(people)
  const parts: Array<string> = []
  if (friend) {
    const who = nameOf(people, friend)
    if (row.settlement) {
      return row.payer === people.me
        ? `我還 ${who} ${money(row.total)}`
        : `${who} 還我 ${money(row.total)}`
    }
    const effect = effects.get(people.me) ?? 0
    parts.push(
      `我的份 ${money(shares.get(people.me) ?? 0)}，${who} 的份 ${money(shares.get(friend) ?? 0)}`,
    )
    if (effect > 0) parts.push(`${who} 欠我 ${money(effect)}`)
    else if (effect < 0) parts.push(`我欠 ${who} ${money(-effect)}`)
    else parts.push('沒有誰欠誰')
  } else if (row.settlement && row.payer) {
    const to = receiverOf(row, people)
    return `${nameOf(people, row.payer)} 還 ${to ? nameOf(people, to) : '?'} ${money(row.total)}`
  } else {
    parts.push(
      [...shares]
        .map(([id, n]) => `${nameOf(people, id)} ${money(n)}`)
        .join('、'),
    )
    const effect = effects.get(people.me) ?? 0
    if (effect > 0) parts.push(`群組欠我 ${money(effect)}`)
    else if (effect < 0) parts.push(`我欠群組 ${money(-effect)}`)
    else if (!shares.has(people.me) && !paidBy(row, people)?.has(people.me))
      parts.push('與我無關')
    else parts.push('我不欠也不被欠')
  }
  if (row.foreign) {
    parts.push(
      `原本 ${row.foreign.currency} ${formatAmount(
        row.foreign.amount,
        currencyUnits(row.foreign.currency),
      )}`,
    )
  }
  return parts.join(' · ')
}

/** A balance with a friend in words: 他欠我 300、我欠他 300、已結清. */
export function balanceText(
  balance: number,
  friendName: string,
  minorUnits: number,
): string {
  const money = formatAmount(Math.abs(balance), minorUnits)
  if (balance > 0) return `${friendName} 欠我 ${money}`
  if (balance < 0) return `我欠 ${friendName} ${money}`
  return '已結清'
}

/** A member's balance in a group in words: 被欠 300、欠 300、已結清. */
export function memberBalanceText(balance: number, minorUnits: number): string {
  const money = formatAmount(Math.abs(balance), minorUnits)
  if (balance > 0) return `被欠 ${money}`
  if (balance < 0) return `欠 ${money}`
  return '已結清'
}

export function dateText(iso: string, today: Date): string {
  return formatDate(iso, today)
}
