import { amountInputValue, formatAmount, parseAmount } from './money.ts'
import { evalAmount, findCategory, formatDate, parseDate } from './register.ts'
import type { Schemas } from './api'
import type { Field, Option } from './form.ts'
import type { Context } from './register.ts'

// Shared expenses with one friend (M12, ADR-106): the lines of the friend's
// page, how its cells are written and read back, and how a total is divided
// into shares, the same way the server divides it
// (apps/api/internal/domain/ledger/split.go). Pure, tested with node.

export type Friend = Schemas['Friend']
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

/** Who paid: the caller, the friend, or both (the caller paying `myPaid`). */
export type Payer = 'me' | 'friend' | 'both'

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
  payer: Payer
  /** What the caller paid when both did. */
  myPaid: number | null
  /** A settlement: the payer pays the whole amount back to the other. */
  settlement: boolean
  method: SplitMethod
  /** The caller's share, for exact. */
  myShare: number | null
  /** The caller's and the friend's percentage or number of shares. */
  weights: [number, number] | null
  categoryId: string | null
  accountId: string | null
  note: string
}

export type SplitRowStatus = 'clean' | 'new' | 'changed' | 'deleted'

export interface SplitProblem {
  field: SplitColumn | null
  message: string
}

/** The two people of the page. */
export interface People {
  me: string
  friend: string
  /** The friend's name, as the page shows it. */
  friendName: string
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

/** The caller's and the friend's shares, or null while they cannot be worked out. */
export function sharesOf(row: SplitRow): [number, number] | null {
  const total = row.total
  if (!total || total <= 0) return null
  if (row.settlement) {
    return row.payer === 'me' ? [0, total] : [total, 0]
  }
  switch (row.method) {
    case 'equal': {
      const [a, b] = divide(total, [1, 1])
      return [a, b]
    }
    case 'exact':
      if (row.myShare === null || row.myShare < 0 || row.myShare > total)
        return null
      return [row.myShare, total - row.myShare]
    default: {
      if (!row.weights) return null
      const w = row.weights.map(scaledWeight)
      if (w[0] === null || w[1] === null) return null
      if (row.method === 'percent' && w[0] + w[1] !== 100 * WEIGHT_SCALE)
        return null
      if (w[0] + w[1] === 0) return null
      const [a, b] = divide(total, [w[0], w[1]])
      return [a, b]
    }
  }
}

/** What the caller paid. */
export function paidOf(row: SplitRow): number {
  const total = row.total ?? 0
  if (row.payer === 'me') return total
  if (row.payer === 'friend') return 0
  return row.myPaid ?? 0
}

/** How the line moves the friend account: what the friend owes the caller. */
export function effectOf(row: SplitRow): number | null {
  if (row.deleted) return 0
  const shares = sharesOf(row)
  if (!shares) return null
  return paidOf(row) - shares[0]
}

/** The friend account's balance after each line, oldest first. */
export function runningBalances(rows: Array<SplitRow>): Array<number> {
  const order = rows
    .map((r, i) => ({ r, i }))
    .toSorted((a, b) => a.r.date.localeCompare(b.r.date) || a.i - b.i)
  const out: Array<number> = Array.from({ length: rows.length }, () => 0)
  let balance = 0
  for (const { r, i } of order) {
    balance += effectOf(r) ?? 0
    out[i] = balance
  }
  return out
}

// ---------- rows

export function rowFromExpense(x: SharedExpense, people: People): SplitRow {
  const mine = x.shares.find((s) => s.userId === people.me)
  const theirs = x.shares.find((s) => s.userId === people.friend)
  const paidByMe = x.payers.find((p) => p.userId === people.me)?.amount ?? 0
  const payer: Payer =
    paidByMe === x.total ? 'me' : paidByMe === 0 ? 'friend' : 'both'
  const settlement = x.kind === 'settlement'
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
    myPaid: payer === 'both' ? paidByMe : null,
    settlement,
    method: settlement ? 'exact' : x.splitMethod,
    myShare:
      !settlement && x.splitMethod === 'exact' ? (mine?.amount ?? 0) : null,
    weights:
      !settlement &&
      (x.splitMethod === 'percent' || x.splitMethod === 'shares') &&
      mine?.weight != null &&
      theirs?.weight != null
        ? [mine.weight, theirs.weight]
        : null,
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
): SplitRow {
  return {
    id,
    base: null,
    deleted: false,
    date,
    description: '',
    total: null,
    foreign: null,
    payer: 'me',
    myPaid: null,
    settlement: false,
    method: 'equal',
    myShare: null,
    weights: null,
    categoryId,
    accountId,
    note: '',
  }
}

/** What the caller needs to say: the account paid from or into, the category of their share. */
export function needs(row: SplitRow): { account: boolean; category: boolean } {
  const shares = sharesOf(row)
  return {
    account: row.settlement || paidOf(row) > 0,
    category: !row.settlement && (shares === null || shares[0] > 0),
  }
}

export function toSplitInput(
  row: SplitRow,
  people: People,
): SharedExpenseInput {
  const total = row.total ?? 0
  const { me, friend } = people
  const payers =
    row.payer === 'both'
      ? [
          { userId: me, amount: row.myPaid ?? 0 },
          { userId: friend, amount: total - (row.myPaid ?? 0) },
        ]
      : [{ userId: row.payer === 'me' ? me : friend, amount: total }]
  const need = needs(row)
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
  if (!row.settlement) {
    switch (row.method) {
      case 'equal':
        input.shares = [{ userId: me }, { userId: friend }]
        break
      case 'exact':
        input.shares = [
          { userId: me, amount: row.myShare ?? 0 },
          { userId: friend, amount: total - (row.myShare ?? 0) },
        ]
        break
      default:
        input.shares = [
          { userId: me, weight: row.weights?.[0] ?? 0 },
          { userId: friend, weight: row.weights?.[1] ?? 0 },
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
): SplitProblem | null {
  if (row.deleted) return null
  if (!row.description.trim())
    return { field: 'description', message: '請輸入項目，例如：晚餐、計程車' }
  if (!row.total || row.total <= 0)
    return { field: 'amount', message: '請輸入金額' }
  if (row.settlement && row.payer === 'both')
    return { field: 'paidBy', message: '還款只有一個人付' }
  if (row.payer === 'both') {
    const paid = row.myPaid ?? 0
    if (paid <= 0 || paid >= row.total)
      return {
        field: 'paidBy',
        message: '兩個人都有付時，我付的要大於 0、小於總額',
      }
  }
  if (!sharesOf(row)) {
    return {
      field: 'split',
      message:
        row.method === 'percent'
          ? '比例要加起來 100%'
          : row.method === 'exact'
            ? '我的份要在 0 和總額之間'
            : '請輸入分法，例如：平分、我 300、我 40%、2:1',
    }
  }
  const need = needs(row)
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
  return String(Math.round(w * WEIGHT_SCALE) / WEIGHT_SCALE)
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
      return row.payer === 'me'
        ? '我'
        : row.payer === 'friend'
          ? people.friendName
          : `我 ${money(row.myPaid)}`
    case 'split':
      return splitText(row, ctx.minorUnits)
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

/** The split as it is written: 平分、我 300、我 40%、2:1、還款. */
export function splitText(row: SplitRow, minorUnits: number): string {
  if (row.settlement) return '還款'
  switch (row.method) {
    case 'equal':
      return '平分'
    case 'exact':
      return row.myShare === null
        ? ''
        : `我 ${amountText(row.myShare, minorUnits)}`
    case 'percent':
      return row.weights ? `我 ${weightText(row.weights[0])}%` : ''
    case 'shares':
      return row.weights
        ? `${weightText(row.weights[0])}:${weightText(row.weights[1])}`
        : ''
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

/** The form's values for a line. */
export function splitFormValues(
  row: SplitRow,
  minorUnits: number,
): Record<string, string> {
  const money = (n: number | null) =>
    n === null ? '' : amountText(n, minorUnits)
  const half = row.total ? Math.floor(row.total / 2) : null
  return {
    kind: row.settlement ? 'settlement' : 'expense',
    payer: row.payer,
    myPaid: money(row.myPaid ?? half),
    method: row.settlement ? 'equal' : row.method,
    myShare: money(row.myShare ?? half),
    myPercent:
      row.method === 'percent' && row.weights
        ? weightText(row.weights[0])
        : '50',
    myWeight:
      row.method === 'shares' && row.weights ? weightText(row.weights[0]) : '1',
    theirWeight:
      row.method === 'shares' && row.weights ? weightText(row.weights[1]) : '1',
    currency: row.foreign?.currency ?? '',
    foreign: row.foreign
      ? amountText(row.foreign.amount, currencyUnits(row.foreign.currency))
      : '',
  }
}

/** The form's fields for its values. */
export function splitFormFields(
  values: Record<string, string>,
  people: People,
  currencies: Array<Option>,
): Array<Field> {
  const who = people.friendName
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
    {
      key: 'payer',
      label: settlement ? '誰還誰' : '誰付',
      type: 'choice',
      options: settlement
        ? [
            { value: 'me', label: `我還${who}` },
            { value: 'friend', label: `${who}還我` },
          ]
        : [
            { value: 'me', label: '我' },
            { value: 'friend', label: who },
            { value: 'both', label: '兩人都有付' },
          ],
    },
  ]
  if (!settlement && values.payer === 'both') {
    fields.push({
      key: 'myPaid',
      label: '我付了',
      type: 'amount',
      placeholder: '其餘是對方付的',
    })
  }
  if (!settlement) {
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
    if (values.method === 'exact')
      fields.push({ key: 'myShare', label: '我的份', type: 'amount' })
    if (values.method === 'percent')
      fields.push({
        key: 'myPercent',
        label: '我出',
        type: 'number',
        suffix: '%',
      })
    if (values.method === 'shares') {
      fields.push(
        { key: 'myWeight', label: '我的份數', type: 'number' },
        { key: 'theirWeight', label: `${who}的份數`, type: 'number' },
      )
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
  minorUnits: number,
): Partial<SplitRow> | string {
  const total = row.total
  const settlement = values.kind === 'settlement'
  const payer = values.payer as Payer
  const patch: Partial<SplitRow> = {
    settlement,
    payer,
    myPaid: null,
    method: 'equal',
    myShare: null,
    weights: null,
  }
  if (settlement) {
    if (payer === 'both') return '還款只有一個人付'
    patch.method = 'exact'
  } else {
    if (payer === 'both') {
      const paid = evalAmount(values.myPaid, minorUnits)
      if (paid === null || paid <= 0 || (total !== null && paid >= total))
        return '兩個人都有付時，我付的要大於 0、小於總額'
      patch.myPaid = paid
    }
    patch.method = values.method as SplitMethod
    switch (patch.method) {
      case 'exact': {
        const mine = evalAmount(values.myShare, minorUnits)
        if (mine === null || mine < 0 || (total !== null && mine > total))
          return '我的份要在 0 和總額之間'
        patch.myShare = mine
        break
      }
      case 'percent': {
        const p = Number(values.myPercent)
        if (!Number.isFinite(p) || p < 0 || p > 100) return '比例是 0 到 100'
        patch.weights = [p, Math.round((100 - p) * WEIGHT_SCALE) / WEIGHT_SCALE]
        break
      }
      case 'shares': {
        const a = Number(values.myWeight)
        const b = Number(values.theirWeight)
        if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0)
          return '份數不能是負的'
        if (a + b === 0) return '份數不能都是 0'
        patch.weights = [a, b]
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
  invalid_payers: '付款的人只能是你和這位朋友',
  payers_total: '付的錢要加起來等於總額',
  invalid_shares: '兩個人都要有份，份數或比例不能是負的',
  shares_total: '兩個人的份要加起來等於總額',
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
  const shares = sharesOf(row)
  if (!shares || !row.total) return null
  const money = (n: number) => formatAmount(n, minorUnits)
  const who = people.friendName
  if (row.settlement) {
    return row.payer === 'me'
      ? `我還 ${who} ${money(row.total)}`
      : `${who} 還我 ${money(row.total)}`
  }
  const effect = paidOf(row) - shares[0]
  const parts = [`我的份 ${money(shares[0])}，${who} 的份 ${money(shares[1])}`]
  if (effect > 0) parts.push(`${who} 欠我 ${money(effect)}`)
  else if (effect < 0) parts.push(`我欠 ${who} ${money(-effect)}`)
  else parts.push('沒有誰欠誰')
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

/** A balance in words: 他欠我 300、我欠他 300、結清. */
export function balanceText(
  balance: number,
  friendName: string,
  minorUnits: number,
): string {
  const money = formatAmount(Math.abs(balance), minorUnits)
  if (balance > 0) return `${friendName} 欠我 ${money}`
  if (balance < 0) return `我欠 ${friendName} ${money}`
  return '兩清'
}

export function dateText(iso: string, today: Date): string {
  return formatDate(iso, today)
}
