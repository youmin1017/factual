/**
 * The account register's data model, without React: turning transactions
 * into editable rows for one account and back, parsing what is typed into
 * cells, validation, and running balances. Kept pure so it can be tested
 * with plain node (`register.test.ts`).
 */
import { amountInputValue, parseAmount } from './money.ts'
import type { Schemas } from './api'

export type Transaction = Schemas['Transaction']
export type TransactionInput = Schemas['TransactionInput']
export type EntryInput = Schemas['EntryInput']
export type ClearedState = Schemas['ClearedState']
export type Occurrence = Schemas['Occurrence']

/** A schedule's occurrence not yet posted, shown as a 預定 row (ADR-085). */
export interface Planned {
  scheduleId: string
  /** The date the rule gives; identifies the occurrence. */
  occurrence: string
  /** The amount is an estimate (shown with `~`). */
  estimate: boolean
}

export interface AccountRef {
  id: string
  name: string
  onBudget: boolean
  closed: boolean
}

export interface CategoryRef {
  id: string
  /** `飲食/外食` */
  path: string
  name: string
  kind: 'expense' | 'income'
  archived: boolean
  isSystem: boolean
}

export interface PayeeRef {
  name: string
  lastCategoryId: string | null
}

/**
 * One line of a split (ADR-068): part of the row's amount with its own
 * category and memo, or a transfer of that part to another account.
 */
export interface SplitLine {
  id: string
  transferTo: string | null
  categoryId: string | null
  memo: string
  /** Change in this account's balance, in minor units. */
  amount: number
  /** The other account's entry of a transfer line keeps its cleared state. */
  counterCleared: ClearedState
}

export type Column =
  | 'date'
  | 'account'
  | 'payee'
  | 'note'
  | 'category'
  | 'outflow'
  | 'inflow'
  | 'cleared'

/** The editable columns of one account's register, left to right. */
export const columns: Array<Column> = [
  'date',
  'payee',
  'note',
  'category',
  'outflow',
  'inflow',
  'cleared',
]

/** A register of several accounts also says whose each row is (ADR-071). */
export const multiColumns: Array<Column> = [
  'date',
  'account',
  'payee',
  'note',
  'category',
  'outflow',
  'inflow',
  'cleared',
]

/**
 * One transaction as seen from one account: the editor's line. Typed values
 * only; text being typed lives in the cell editor until it is committed.
 */
export interface Row {
  /** Unique in the buffer: a transaction is on one row per account shown. */
  key: string
  /** The transaction's id. */
  id: string
  /** The account the row looks from. */
  accountId: string
  /** The saved transaction; null for a row that was never saved. */
  base: Transaction | null
  deleted: boolean
  /** ISO date, yyyy-mm-dd. */
  date: string
  payee: string
  /** The other account of a transfer (shown as `@name` in the payee cell). */
  transferTo: string | null
  note: string
  categoryId: string | null
  /** Change in this account's balance, in minor units; for a split, the sum of its lines. */
  amount: number
  cleared: ClearedState
  /** The lines of a split; null for a row with one category or transfer. */
  splits: Array<SplitLine> | null
  /**
   * `opening`: the account's opening balance; its category is fixed.
   * `foreign`: a split written from another account's side (ADR-068); only
   * date, payee, note and cleared are edited here.
   */
  locked: 'opening' | 'foreign' | null
  /**
   * A 預定 row: not saved yet; `base` is the transaction the occurrence
   * would post, so an untouched one is clean and an edited one posts with
   * the change on :w. Absent on rows from drafts older than schedules.
   */
  planned?: Planned | null
}

export interface Context {
  accounts: Map<string, AccountRef>
  categories: Map<string, CategoryRef>
  minorUnits: number
}

/**
 * A transaction's entries as lines seen from one account: each entry on the
 * account is a line, and each entry on another account must pair with a line
 * of the opposite amount, which becomes a transfer line. Null when the
 * entries do not pair up (a split written from the other account's side).
 */
export function linesOf(
  tx: Transaction,
  accountId: string,
): Array<SplitLine> | null {
  const lines: Array<SplitLine> = tx.entries
    .filter((e) => e.accountId === accountId)
    .map((e) => ({
      id: e.id,
      transferTo: null,
      categoryId: e.categoryId,
      memo: e.memo,
      amount: e.amount,
      counterCleared: 'uncleared',
    }))
  for (const other of tx.entries.filter((e) => e.accountId !== accountId)) {
    const at = lines.findIndex(
      (l) =>
        l.transferTo === null &&
        l.amount === -other.amount &&
        (l.categoryId === null || other.categoryId === null),
    )
    if (at < 0) return null
    lines[at] = {
      ...lines[at],
      transferTo: other.accountId,
      categoryId: lines[at].categoryId ?? other.categoryId,
      counterCleared: other.cleared,
    }
  }
  return lines
}

/** The row an existing transaction is on this account. */
export function rowFromTransaction(tx: Transaction, accountId: string): Row {
  const mine = tx.entries.filter((e) => e.accountId === accountId)
  const row: Row = {
    key: rowKey(tx.id, accountId),
    id: tx.id,
    accountId,
    base: tx,
    deleted: false,
    date: tx.date,
    payee: tx.payeeName ?? '',
    transferTo: null,
    note: tx.note,
    categoryId: null,
    amount: mine.reduce((sum, e) => sum + e.amount, 0),
    cleared: mine[0]?.cleared ?? 'uncleared',
    splits: null,
    locked: null,
  }
  const lines = linesOf(tx, accountId)
  if (!lines) {
    row.locked = 'foreign'
  } else if (lines.length === 1) {
    // One category, or a transfer whose category (if any) is on whichever
    // side is on budget.
    row.transferTo = lines[0].transferTo
    row.categoryId = lines[0].categoryId
    if (tx.isOpening) row.locked = 'opening'
  } else {
    row.splits = lines
  }
  return row
}

export function rowKey(id: string, accountId: string): string {
  return `${id}:${accountId}`
}

/**
 * The rows of transactions for the accounts shown, newest first: one per
 * transaction and shown account it has entries on, in the accounts' order.
 */
export function rowsFromTransactions(
  transactions: Array<Transaction>,
  shown: Array<string>,
): Array<Row> {
  const rows: Array<Row> = []
  for (const tx of transactions) {
    const on = new Set(tx.entries.map((e) => e.accountId))
    for (const accountId of shown) {
      if (on.has(accountId)) rows.push(rowFromTransaction(tx, accountId))
    }
  }
  return rows.reverse()
}

/**
 * The id a 預定 row's transaction gets: the same for an occurrence every
 * time it is listed, so drafts of edited 預定 rows find their row again.
 * Shaped as a UUID (version 8, the custom one).
 */
export function plannedId(scheduleId: string, occurrence: string): string {
  const text = `${scheduleId}/${occurrence}`
  // Four 32-bit FNV-1a hashes, each seeded differently.
  const words = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((seed) => {
    let h = seed >>> 0
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  })
  const hex = words.join('')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The transaction an occurrence posts, as the server writes it (ADR-085). */
export function plannedTransaction(o: Occurrence): Transaction {
  const id = plannedId(o.scheduleId, o.occurrence)
  // An occurrence of several lines (a loan payment's principal and
  // interest, ADR-097) lists every entry it posts.
  const entries: Transaction['entries'] = o.entries?.map((e, i) => ({
    id: `${id}-${i}`,
    accountId: e.accountId,
    categoryId: e.categoryId,
    amount: e.amount,
    memo: e.memo,
    cleared: 'uncleared',
  })) ?? [
    {
      id: `${id}-0`,
      accountId: o.accountId,
      categoryId: o.categoryId,
      amount: o.amount,
      memo: '',
      cleared: 'uncleared',
    },
  ]
  if (!o.entries && o.transferAccountId) {
    entries.push({
      id: `${id}-1`,
      accountId: o.transferAccountId,
      categoryId: null,
      amount: -o.amount,
      memo: '',
      cleared: 'uncleared',
    })
  }
  return {
    id,
    date: o.date,
    payeeId: null,
    payeeName: o.payee || null,
    note: o.note,
    needsReview: false,
    isOpening: false,
    entries,
  }
}

/**
 * The 預定 rows of the accounts shown, latest first, as transactions are:
 * an occurrence `upcoming` lists (earliest first) on each account it moves.
 */
export function plannedRows(
  upcoming: Array<Occurrence>,
  shown: Array<string>,
): Array<Row> {
  const byId = new Map(
    upcoming.map((o) => [plannedId(o.scheduleId, o.occurrence), o]),
  )
  return rowsFromTransactions(upcoming.map(plannedTransaction), shown).map(
    (row) => {
      const o = byId.get(row.id)
      return o
        ? {
            ...row,
            planned: {
              scheduleId: o.scheduleId,
              occurrence: o.occurrence,
              estimate: o.estimate,
            },
          }
        : row
    },
  )
}

/** The rows a register shows from the server: 預定 rows above saved ones. */
export function bufferRows(
  transactions: Array<Transaction>,
  upcoming: Array<Occurrence>,
  shown: Array<string>,
): Array<Row> {
  return [
    ...plannedRows(upcoming, shown),
    ...rowsFromTransactions(transactions, shown),
  ]
}

/** What :w sends for a row: a 預定 row posts its occurrence. */
export function saveInput(row: Row, ctx: Context): TransactionInput {
  const input = toInput(row, ctx)
  if (!row.planned) return input
  return {
    ...input,
    occurrence: {
      scheduleId: row.planned.scheduleId,
      occurrence: row.planned.occurrence,
    },
  }
}

/** The transaction a row would save, as the register reads transactions. */
function asTransaction(row: Row, ctx: Context): Transaction {
  const input = toInput(row, ctx)
  return {
    id: row.id,
    date: input.date,
    payeeId: row.base?.payeeId ?? null,
    payeeName: input.payee || null,
    note: input.note,
    needsReview: row.base?.needsReview ?? false,
    isOpening: row.base?.isOpening ?? false,
    entries: input.entries.map((e, i) => ({ ...e, id: `${row.id}-${i}` })),
  }
}

/**
 * In a register of several accounts a transaction is on one row per account
 * shown (a transfer is on both of its accounts). After the row at `index`
 * changes, its transaction's other rows are rebuilt from it: rows of
 * accounts it left go, accounts it reached get a row under it, and deleting
 * one deletes them all.
 */
export function syncRows(
  rows: Array<Row>,
  index: number,
  ctx: Context,
  shown: Set<string>,
): Array<Row> {
  const row = rows[index]
  const others = rows.filter((r, i) => i !== index && r.id === row.id)
  let rebuilt: Array<Row>
  if (row.deleted) {
    rebuilt = others.map((r) => ({ ...r, deleted: true }))
  } else {
    const tx = asTransaction(row, ctx)
    const accounts = [...new Set(tx.entries.map((e) => e.accountId))].filter(
      (a) => a !== row.accountId && shown.has(a),
    )
    if (others.length === 0 && accounts.length === 0) return rows
    rebuilt = accounts.map((accountId) => {
      const before = others.find((r) => r.accountId === accountId)
      return {
        ...rowFromTransaction(tx, accountId),
        key: before?.key ?? rowKey(row.id, accountId),
        base: before?.base ?? row.base,
        planned: row.planned ?? null,
      }
    })
  }
  const rest = rows.filter((r, i) => i === index || r.id !== row.id)
  const at = rest.indexOf(row)
  return rest.toSpliced(at + 1, 0, ...rebuilt)
}

/**
 * The account whose register a foreign split is edited in: the one with the
 * most entries.
 */
export function foreignAccount(row: Row): string | null {
  const counts = new Map<string, number>()
  for (const e of row.base?.entries ?? []) {
    counts.set(e.accountId, (counts.get(e.accountId) ?? 0) + 1)
  }
  let best: string | null = null
  let most = 0
  for (const [id, n] of counts) {
    if (n > most) {
      best = id
      most = n
    }
  }
  return best
}

/** A split's lines, or the row's one category or transfer as a single line. */
export function splitLinesOf(row: Row, newId: () => string): Array<SplitLine> {
  if (row.splits) return row.splits
  return [
    {
      id: newId(),
      transferTo: row.transferTo,
      categoryId: row.categoryId,
      memo:
        row.base?.entries.find((e) => e.accountId === row.accountId)?.memo ??
        '',
      amount: row.amount,
      counterCleared: 'uncleared',
    },
  ]
}

export function isEmptyLine(line: SplitLine): boolean {
  return (
    line.amount === 0 &&
    !line.categoryId &&
    !line.transferTo &&
    !line.memo.trim()
  )
}

/**
 * The row with these split lines: empty lines are dropped, and one line left
 * makes it an ordinary row again.
 */
export function withSplits(row: Row, lines: Array<SplitLine>): Row {
  const kept = lines.filter((l) => !isEmptyLine(l))
  if (kept.length <= 1) {
    const line = kept.at(0)
    return {
      ...row,
      splits: null,
      transferTo: line?.transferTo ?? null,
      categoryId: line?.categoryId ?? null,
      amount: line?.amount ?? 0,
    }
  }
  return {
    ...row,
    splits: kept,
    transferTo: null,
    categoryId: null,
    amount: kept.reduce((sum, l) => sum + l.amount, 0),
  }
}

export function newRow(id: string, date: string, accountId: string): Row {
  return {
    key: rowKey(id, accountId),
    id,
    accountId,
    base: null,
    deleted: false,
    date,
    payee: '',
    transferTo: null,
    note: '',
    categoryId: null,
    amount: 0,
    cleared: 'uncleared',
    splits: null,
    locked: null,
  }
}

/**
 * What the category cell means for a row (ADR-023): a budget account needs a
 * category for money coming in or going out; a transfer needs one only when
 * it crosses between a budget and a tracking account; tracking accounts never
 * have one.
 */
export function categoryMode(
  row: Row,
  ctx: Context,
): 'required' | 'none' | 'locked' | 'split' {
  if (row.locked) return 'locked'
  if (row.splits) return 'split'
  return lineCategoryMode(row.accountId, row.transferTo, ctx)
}

/** The same rule for one line of a split, or a row's single category. */
export function lineCategoryMode(
  accountId: string,
  transferTo: string | null,
  ctx: Context,
): 'required' | 'none' {
  const me = ctx.accounts.get(accountId)
  if (!me) return 'none'
  if (transferTo) {
    const other = ctx.accounts.get(transferTo)
    return other && other.onBudget !== me.onBudget ? 'required' : 'none'
  }
  return me.onBudget ? 'required' : 'none'
}

/** The entries of one split line: this account's, and a transfer's other side. */
function lineEntries(
  line: SplitLine,
  accountId: string,
  ctx: Context,
  cleared: ClearedState,
): Array<EntryInput> {
  const me = ctx.accounts.get(accountId)
  if (!line.transferTo) {
    return [
      {
        accountId,
        categoryId: me?.onBudget ? line.categoryId : null,
        amount: line.amount,
        memo: line.memo.trim(),
        cleared,
      },
    ]
  }
  const other = ctx.accounts.get(line.transferTo)
  const crossing = Boolean(me && other && me.onBudget !== other.onBudget)
  return [
    {
      accountId,
      categoryId: crossing && me?.onBudget ? line.categoryId : null,
      amount: line.amount,
      memo: line.memo.trim(),
      cleared,
    },
    {
      accountId: line.transferTo,
      categoryId: crossing && other?.onBudget ? line.categoryId : null,
      amount: -line.amount,
      memo: line.memo.trim(),
      cleared: line.counterCleared,
    },
  ]
}

/** The entries a row stands for, as the batch endpoint takes them. */
export function toInput(row: Row, ctx: Context): TransactionInput {
  const me = ctx.accounts.get(row.accountId)
  const memoOf = (accountId: string) =>
    row.base?.entries.find((e) => e.accountId === accountId)?.memo ?? ''
  const clearedOf = (accountId: string) =>
    row.base?.entries.find((e) => e.accountId === accountId)?.cleared ??
    'uncleared'

  let entries: Array<EntryInput>
  if (row.splits) {
    entries = row.splits.flatMap((l) =>
      lineEntries(l, row.accountId, ctx, row.cleared),
    )
  } else if (row.locked === 'foreign' && row.base) {
    entries = row.base.entries.map((e) => ({
      accountId: e.accountId,
      categoryId: e.categoryId,
      amount: e.amount,
      memo: e.memo,
      cleared: e.accountId === row.accountId ? row.cleared : e.cleared,
    }))
  } else if (row.transferTo) {
    const other = ctx.accounts.get(row.transferTo)
    const crossing = Boolean(me && other && me.onBudget !== other.onBudget)
    entries = [
      {
        accountId: row.accountId,
        categoryId: crossing && me?.onBudget ? row.categoryId : null,
        amount: row.amount,
        memo: memoOf(row.accountId),
        cleared: row.cleared,
      },
      {
        accountId: row.transferTo,
        categoryId: crossing && other?.onBudget ? row.categoryId : null,
        amount: -row.amount,
        memo: memoOf(row.transferTo),
        cleared: clearedOf(row.transferTo),
      },
    ]
  } else {
    entries = [
      {
        accountId: row.accountId,
        categoryId: me?.onBudget ? row.categoryId : null,
        amount: row.amount,
        memo: memoOf(row.accountId),
        cleared: row.cleared,
      },
    ]
  }
  return {
    id: row.id,
    date: row.date,
    payee: row.transferTo ? '' : row.payee.trim(),
    note: row.note.trim(),
    entries,
  }
}

function canonical(input: TransactionInput): string {
  const entries = input.entries
    .map((e) => [e.accountId, e.categoryId ?? '', e.amount, e.memo, e.cleared])
    .sort((a, b) => String(a).localeCompare(String(b)))
  return JSON.stringify([input.date, input.payee, input.note, entries])
}

function baseInput(tx: Transaction): TransactionInput {
  return {
    id: tx.id,
    date: tx.date,
    payee: tx.payeeName ?? '',
    note: tx.note,
    entries: tx.entries.map((e) => ({
      accountId: e.accountId,
      categoryId: e.categoryId,
      amount: e.amount,
      memo: e.memo,
      cleared: e.cleared,
    })),
  }
}

export type RowStatus = 'clean' | 'new' | 'changed' | 'deleted'

/**
 * Statuses already worked out, per context and row. Rows are never changed
 * in place (an edit makes a new row), so an edit recomputes only the rows it
 * touched instead of comparing every row of the register again.
 */
const statusCache = new WeakMap<Context, WeakMap<Row, RowStatus>>()

export function rowStatus(row: Row, ctx: Context): RowStatus {
  if (!row.base) return 'new'
  if (row.deleted) return 'deleted'
  let known = statusCache.get(ctx)
  if (!known) {
    known = new WeakMap()
    statusCache.set(ctx, known)
  }
  let status = known.get(row)
  if (!status) {
    // A transfer is saved without a payee; compare it the same way.
    const saved = baseInput(row.base)
    if (row.transferTo) saved.payee = ''
    status =
      canonical(toInput(row, ctx)) === canonical(saved) ? 'clean' : 'changed'
    known.set(row, status)
  }
  return status
}

export interface RowProblem {
  field: Column | null
  message: string
}

/** What is wrong with a row before it is sent, in the user's words. */
export function validateRow(row: Row, ctx: Context): RowProblem | null {
  if (row.deleted) return null
  if (!isIsoDate(row.date)) return { field: 'date', message: '日期不正確' }
  if (!ctx.accounts.has(row.accountId)) {
    return { field: 'account', message: '帳戶不存在' }
  }
  if (row.transferTo) {
    if (row.transferTo === row.accountId) {
      return { field: 'payee', message: '不能轉帳給同一個帳戶' }
    }
    if (!ctx.accounts.has(row.transferTo)) {
      return { field: 'payee', message: '轉帳的帳戶不存在' }
    }
  }
  if (row.splits) {
    for (const [i, line] of row.splits.entries()) {
      const at = `拆分第 ${i + 1} 行：`
      if (line.transferTo === row.accountId) {
        return { field: 'category', message: `${at}不能轉帳給同一個帳戶` }
      }
      if (line.transferTo && !ctx.accounts.has(line.transferTo)) {
        return { field: 'category', message: `${at}轉帳的帳戶不存在` }
      }
      if (
        lineCategoryMode(row.accountId, line.transferTo, ctx) === 'required' &&
        !line.categoryId &&
        line.amount !== 0
      ) {
        return {
          field: 'category',
          message: line.transferTo
            ? `${at}在預算內和追蹤帳戶之間轉帳，需要選類別`
            : `${at}需要類別`,
        }
      }
    }
    return null
  }
  if (
    categoryMode(row, ctx) === 'required' &&
    !row.categoryId &&
    row.amount !== 0
  ) {
    return {
      field: 'category',
      message: row.transferTo
        ? '在預算內和追蹤帳戶之間轉帳，需要選類別'
        : '預算內帳戶的交易需要類別',
    }
  }
  return null
}

/** zh-TW messages for the batch endpoint's problem codes. */
export const problemMessages: Record<string, string> = {
  category_required: '預算內帳戶的交易需要類別',
  category_not_allowed: '追蹤帳戶的交易不能有類別',
  unbalanced: '轉帳兩邊的金額不平',
  unknown_account: '帳戶不存在',
  unknown_category: '類別不存在',
  not_found: '找不到這筆交易，可能已在別處刪除',
  duplicate_id: '這筆交易重複出現',
  too_long: '內容太長',
  no_entries: '交易沒有內容',
  already_posted: '這一期已經入帳了，重新整理（:e!）看看',
  already_saved: '這一期已經入帳了，重新整理（:e!）看看',
  not_an_occurrence: '這個排程沒有這一期',
  occurrence_skipped: '這一期已經略過了',
  shared_transaction:
    '這筆是分帳產生的交易：只能核對或改類別，其他的請到分帳頁修改（:e! 還原）',
}

export function problemColumn(field: string): Column | null {
  if (field === 'amount') return 'outflow'
  if (field === 'account') return 'payee'
  return (multiColumns as Array<string>).includes(field)
    ? (field as Column)
    : null
}

/** Within a day: the opening balance, then saved rows, then unsaved ones. */
function sameDayRank(row: Row): number {
  if (row.base?.isOpening) return 0
  return row.base ? 1 : 2
}

/**
 * Balance after each row, for rows in display order (newest first). Rows
 * count by date; within a day the opening balance comes first, then saved
 * rows, then unsaved ones, each group bottom of the screen first. Where a row
 * sits on screen does not move it in time. Deleted and 預定 rows count as 0.
 */
export function runningBalances(rows: Array<Row>): Array<number> {
  const order = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (a.row.date !== b.row.date) return a.row.date < b.row.date ? -1 : 1
      const kind = sameDayRank(a.row) - sameDayRank(b.row)
      return kind !== 0 ? kind : b.index - a.index
    })
  const out: Array<number> = Array.from({ length: rows.length }, () => 0)
  let balance = 0
  for (const { row, index } of order) {
    // 預定 rows are not in the account yet.
    if (!row.deleted && !row.planned) balance += row.amount
    out[index] = balance
  }
  return out
}

// ---------- dates

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && makeDate(s) !== null
}

function makeDate(s: string): Date | null {
  const [y, m, d] = s.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y &&
    date.getMonth() === m - 1 &&
    date.getDate() === d
    ? date
    : null
}

function build(y: number, m: number, d: number): string | null {
  const iso = `${y}-${pad(m)}-${pad(d)}`
  return makeDate(iso) ? iso : null
}

/**
 * Reads a typed date: `t` or `今天` (today), `y` or `昨天`, `-1`/`+2` (days
 * from today), `5` (the 5th of this month), `11/5`, `2026-11-05`. Returns an
 * ISO date or null.
 */
export function parseDate(text: string, today: Date): string | null {
  const s = text.trim().toLowerCase()
  if (s === 't' || s === 'today' || s === '今天' || s === '.') {
    return isoDate(today)
  }
  if (s === 'y' || s === '昨天') {
    return isoDate(
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1),
    )
  }
  let m = /^([+-])(\d{1,3})$/.exec(s)
  if (m) {
    const n = Number(m[2]) * (m[1] === '-' ? -1 : 1)
    return isoDate(
      new Date(today.getFullYear(), today.getMonth(), today.getDate() + n),
    )
  }
  if (/^\d{1,2}$/.test(s)) {
    return build(today.getFullYear(), today.getMonth() + 1, Number(s))
  }
  m = /^(\d{1,2})[/.-](\d{1,2})$/.exec(s)
  if (m) return build(today.getFullYear(), Number(m[1]), Number(m[2]))
  m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(s)
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]))
  return null
}

/** `11/05` this year, `2025/11/05` otherwise. */
export function formatDate(iso: string, today: Date): string {
  const [y, m, d] = iso.split('-')
  return Number(y) === today.getFullYear() ? `${m}/${d}` : `${y}/${m}/${d}`
}

// ---------- amounts

/**
 * Reads a typed amount into minor units: a plain number (`1,280`) or simple
 * arithmetic (`120*3`, `(450+30)/2`). Results are rounded to the currency's
 * minor unit; null when it is not a valid amount.
 */
export function evalAmount(text: string, minorUnits: number): number | null {
  const plain = parseAmount(text, minorUnits)
  if (plain !== null) return plain
  const tokens = text.replaceAll(/[\s,]/g, '').match(/\d*\.?\d+|[-+*/()]/g)
  if (!tokens || tokens.join('') !== text.replaceAll(/[\s,]/g, '')) return null
  let i = 0
  const peek = (): string | undefined => tokens.at(i)
  const next = (): string | undefined => tokens.at(i++)
  // expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)*
  // factor := ('-'|'+') factor | number | '(' expr ')'
  const expr = (): number => {
    let v = term()
    while (peek() === '+' || peek() === '-') {
      v = next() === '+' ? v + term() : v - term()
    }
    return v
  }
  const term = (): number => {
    let v = factor()
    while (peek() === '*' || peek() === '/') {
      v = next() === '*' ? v * factor() : v / factor()
    }
    return v
  }
  const factor = (): number => {
    const t = next()
    if (t === '-') return -factor()
    if (t === '+') return factor()
    if (t === '(') {
      const v = expr()
      if (next() !== ')') return Number.NaN
      return v
    }
    return t !== undefined && /^\d*\.?\d+$/.test(t) ? Number(t) : Number.NaN
  }
  const value = expr()
  if (i !== tokens.length || !Number.isFinite(value)) return null
  const minor = Math.round(value * 10 ** minorUnits)
  return Number.isSafeInteger(minor) ? minor : null
}

/** The text a money cell starts editing from. */
export function amountCellText(
  amount: number,
  column: 'outflow' | 'inflow',
  minorUnits: number,
): string {
  if (column === 'outflow' && amount < 0) {
    return amountInputValue(-amount, minorUnits)
  }
  if (column === 'inflow' && amount > 0) {
    return amountInputValue(amount, minorUnits)
  }
  return ''
}

// ---------- completion

/**
 * How well `query` matches `text`: higher is better, -1 is no match. A
 * substring beats a scattered subsequence; earlier beats later.
 */
export function matchScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const t = text.toLowerCase()
  const at = t.indexOf(q)
  if (at >= 0) return 1000 - at * 10 - (t.length - q.length)
  let pos = 0
  let gaps = 0
  for (const ch of q) {
    const found = t.indexOf(ch, pos)
    if (found < 0) return -1
    gaps += found - pos
    pos = found + 1
  }
  return 500 - gaps * 5 - t.length
}

export function rank<T>(
  items: Array<T>,
  query: string,
  text: (item: T) => string,
  limit = 8,
): Array<T> {
  return items
    .map((item) => ({ item, score: matchScore(query, text(item)) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item)
}

/**
 * `rank` for a cell editor. While the text is still the cell's own value
 * (`own`: insert entered with i on a filled cell, nothing typed yet), every
 * option is offered with that value first, so another one can be picked
 * without erasing it; once something is typed, only what matches it.
 */
export function rankCell<T>(
  items: Array<T>,
  edit: string,
  own: string | null,
  text: (item: T) => string,
  limit = 8,
): Array<T> {
  if (own === null || edit === '' || edit !== own) {
    return rank(items, edit, text, limit)
  }
  const current = items.find((item) => text(item) === edit)
  const rest = rank(
    items.filter((item) => item !== current),
    '',
    text,
    current ? limit - 1 : limit,
  )
  return current ? [current, ...rest] : rest
}

/** Categories with their full paths, from the API's flat list. */
export function categoryRefs(
  list: Array<Schemas['Category']>,
): Map<string, CategoryRef> {
  const byId = new Map(list.map((c) => [c.id, c]))
  const pathOf = (c: Schemas['Category']): string => {
    const parent = c.parentId ? byId.get(c.parentId) : undefined
    return parent ? `${pathOf(parent)}/${c.name}` : c.name
  }
  const archivedOf = (c: Schemas['Category']): boolean => {
    const parent = c.parentId ? byId.get(c.parentId) : undefined
    return c.archived || (parent ? archivedOf(parent) : false)
  }
  return new Map(
    list.map((c) => [
      c.id,
      {
        id: c.id,
        path: pathOf(c),
        name: c.name,
        kind: c.kind,
        archived: archivedOf(c),
        isSystem: c.isSystem,
      },
    ]),
  )
}

/**
 * The category a typed text names: an exact path, else a category whose own
 * name matches and is the only one with that name.
 */
export function findCategory(
  text: string,
  categories: Iterable<CategoryRef>,
): CategoryRef | null {
  const s = text.trim()
  const usable = [...categories].filter((c) => !c.isSystem)
  const exact = usable.find((c) => c.path === s)
  if (exact) return exact
  const byName = usable.filter((c) => c.name === s)
  return byName.length === 1 ? byName[0] : null
}
