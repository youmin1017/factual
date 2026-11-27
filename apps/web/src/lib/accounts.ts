import { cardFromValues } from './card-lines.ts'
import { parseLoanFields } from './loan.ts'
import { amountInputValue } from './money.ts'
import { evalAmount, parseDate } from './register.ts'
import type { Schemas } from './api'
import type { CardValues } from './card-lines.ts'
import type { Option } from './form.ts'
import type { LoanFieldValues } from './loan.ts'

// The accounts page (ADR-108): its lines, edited as the goals page's are
// and saved with :w. A new line's kind is picked from the completion list,
// its balance typed in its cell and whether it is on budget ticked; the
// day of that balance, and a new card's latest bill, are lines under it
// (ADR-137), as a loan's terms and a card's settings are (ADR-110,
// ADR-117). Pure, tested with node.

export type Account = Schemas['Account']
export type AccountInput = Schemas['AccountInput']
export type NewAccountKind = Schemas['NewAccountKind']
export type CardSettings = Schemas['CardSettings']

export type AccountColumn =
  | 'name'
  | 'kind'
  | 'onBudget'
  | 'balance'
  | 'cleared'
  | 'card'
  | 'status'

export const accountColumns: Array<AccountColumn> = [
  'name',
  'kind',
  'onBudget',
  'balance',
  'cleared',
  'card',
  'status',
]

export const accountLabels: Record<AccountColumn, string> = {
  name: '名稱',
  kind: '類型',
  onBudget: '預算',
  balance: '餘額',
  cleared: '已核對',
  card: '帳單',
  status: '狀態',
}

export const kindOptions: Array<Option & { value: NewAccountKind }> = [
  { value: 'bank', label: '銀行' },
  { value: 'cash', label: '現金' },
  { value: 'credit_card', label: '信用卡' },
  { value: 'loan', label: '貸款' },
  { value: 'investment', label: '投資' },
]

/** Kinds whose balance is usually money owed, typed as the amount owed. */
export function isDebt(kind: NewAccountKind): boolean {
  return kind === 'credit_card' || kind === 'loan'
}

/** Cash and bank accounts may be kept outside the budget; the rest are fixed (ADR-024). */
export function onBudgetOf(kind: NewAccountKind, chosen: boolean): boolean {
  if (kind === 'credit_card') return true
  if (kind === 'loan' || kind === 'investment') return false
  return chosen
}

export interface AccountRow {
  id: string
  /** The saved account; null for a line never saved. */
  base: Account | null
  deleted: boolean
  name: string
  kind: NewAccountKind
  onBudget: boolean
  /** New accounts: the balance on the opening date (negative for debts). */
  openingBalance: number
  /**
   * New cards: the part of `openingBalance` already billed in the latest
   * statement (本期帳單, ADR-137); the rest is 未出帳金額.
   */
  openingBilled: number
  /** ISO date. */
  openingDate: string
  closed: boolean
  card: CardSettings | null
  /**
   * A card's settings as edited in the lines under it (ADR-117); null while
   * they are as saved (`card`).
   */
  cardEdit: CardValues | null
  /**
   * A loan's terms as edited in its details under the line (ADR-110); null
   * while they are as saved.
   */
  loan: LoanFieldValues | null
}

export type AccountRowStatus = 'clean' | 'new' | 'changed' | 'deleted'

export interface AccountProblem {
  field: AccountColumn | null
  message: string
}

export function rowFromAccount(a: Account): AccountRow {
  return {
    id: a.id,
    base: a,
    deleted: false,
    name: a.name,
    kind: a.kind === 'friend' ? 'bank' : a.kind,
    onBudget: a.onBudget,
    openingBalance: 0,
    openingBilled: 0,
    openingDate: '',
    closed: a.closed,
    card: a.card ?? null,
    cardEdit: null,
    loan: null,
  }
}

export function newAccountRow(id: string, today: string): AccountRow {
  return {
    id,
    base: null,
    deleted: false,
    name: '',
    kind: 'bank',
    onBudget: true,
    openingBalance: 0,
    openingBilled: 0,
    openingDate: today,
    closed: false,
    card: null,
    cardEdit: null,
    loan: null,
  }
}

/** The card's settings the line comes to: edited or saved; a string while they are not complete. */
export function cardOf(
  row: AccountRow,
  minorUnits = 0,
): CardSettings | null | string {
  return row.cardEdit ? cardFromValues(row.cardEdit, minorUnits) : row.card
}

export function toAccountInput(
  row: AccountRow,
  sortOrder: number,
  minorUnits = 0,
): AccountInput {
  const input: AccountInput = {
    id: row.id,
    name: row.name.trim(),
    kind: row.kind,
    onBudget: onBudgetOf(row.kind, row.onBudget),
    openingBalance: row.base ? 0 : row.openingBalance,
    openingDate: row.base ? row.openingDate || '2000-01-01' : row.openingDate,
    closed: row.closed,
    sortOrder,
  }
  const card = row.kind === 'credit_card' ? cardOf(row, minorUnits) : null
  if (card && typeof card === 'object') {
    input.card = { ...card }
    // A new card's latest bill is billed apart (ADR-137).
    if (!row.base && row.openingBilled !== 0)
      input.openingBilled = row.openingBilled
  }
  if (row.kind === 'loan' && row.loan) {
    const terms = parseLoanFields(row.loan, minorUnits)
    if (!('field' in terms)) input.loan = terms
  }
  return input
}

/** Whether the line differs from its saved account (its place aside). */
export function accountStatus(
  row: AccountRow,
  minorUnits = 0,
): AccountRowStatus {
  if (row.deleted) return 'deleted'
  if (!row.base) return 'new'
  const saved = rowFromAccount(row.base)
  const same =
    row.loan === null &&
    row.name.trim() === saved.name &&
    row.closed === saved.closed &&
    JSON.stringify(
      row.kind === 'credit_card' ? cardOf(row, minorUnits) : null,
    ) === JSON.stringify(saved.kind === 'credit_card' ? saved.card : null)
  return same ? 'clean' : 'changed'
}

export function validateAccount(
  row: AccountRow,
  rows: Array<AccountRow>,
  minorUnits = 0,
): AccountProblem | null {
  if (row.deleted) {
    return row.base?.hasActivity
      ? {
          field: null,
          message: '這個帳戶有交易，不能刪除：改用 :close 關閉（dd 取消刪除）',
        }
      : null
  }
  const name = row.name.trim()
  if (!name) return { field: 'name', message: '請輸入帳戶名稱' }
  if ([...name].length > 64)
    return { field: 'name', message: '名稱最多 64 個字' }
  if (rows.some((r) => r.id !== row.id && !r.deleted && r.name.trim() === name))
    return { field: 'name', message: `已經有叫「${name}」的帳戶` }
  const balance = row.base ? row.base.balance : row.openingBalance
  if (row.closed && (!row.base || !row.base.closed) && balance !== 0)
    return { field: 'status', message: '餘額不是 0 的帳戶不能關閉' }
  if (row.kind === 'loan' && row.loan) {
    const terms = parseLoanFields(row.loan, minorUnits)
    if ('field' in terms)
      return { field: null, message: `貸款條件：${terms.message}` }
  }
  if (row.kind === 'credit_card') {
    const card = cardOf(row, minorUnits)
    if (typeof card === 'string') return { field: 'card', message: card }
    if (card === null && row.base?.card)
      return {
        field: 'card',
        message: '已經有的帳單設定不能清空：結帳日和繳款截止日都要填',
      }
    if (card === null && !row.base && row.openingBilled !== 0)
      return {
        field: 'card',
        message: '有本期帳單就要填結帳日和繳款截止日（才知道是哪一期的帳單）',
      }
  }
  return null
}

// ---------- cells

/** 0 for -0 too, so that a balance never reads -0. */
function neg(n: number): number {
  return n === 0 ? 0 : -n
}

/** An amount of a new line as typed: a debt's as what is owed; '' for 0. */
function owedText(
  amount: number,
  kind: NewAccountKind,
  minorUnits: number,
): string {
  if (amount === 0) return ''
  return amountInputValue(isDebt(kind) ? neg(amount) : amount, minorUnits)
}

/** What a cell's editing starts from. */
export function accountCellText(
  row: AccountRow,
  column: AccountColumn,
  minorUnits = 0,
): string {
  switch (column) {
    case 'name':
      return row.name
    case 'kind':
      return kindLabel(row.kind)
    case 'balance':
      return owedText(row.openingBalance, row.kind, minorUnits)
    default:
      return ''
  }
}

/** What the balance cell of a new line is called while typed. */
export function balanceLabel(kind: NewAccountKind): string {
  return isDebt(kind) ? '目前欠款' : '目前餘額'
}

/**
 * A new line's kind, picked by its label from the completion list (ADR-137).
 * What was typed as the balance keeps its amount: a debt's is what is owed.
 */
export function kindPatch(
  row: AccountRow,
  text: string,
): Partial<AccountRow> | string {
  const typed = text.trim()
  const kind = kindOptions.find(
    (k) => k.label === typed || k.value === typed,
  )?.value
  if (!kind)
    return `沒有「${typed}」這種帳戶：${kindOptions.map((k) => k.label).join('、')}`
  if (kind === row.kind) return {}
  const chosen =
    row.kind === 'bank' || row.kind === 'cash' ? row.onBudget : true
  return {
    kind,
    onBudget: onBudgetOf(kind, chosen),
    openingBalance:
      isDebt(kind) === isDebt(row.kind)
        ? row.openingBalance
        : neg(row.openingBalance),
    openingBilled: 0,
  }
}

/** The balance typed on a new line (sums allowed): a debt's is what is owed. */
export function balancePatch(
  row: AccountRow,
  text: string,
  minorUnits: number,
): Partial<AccountRow> | string {
  const amount = evalAmount(text, minorUnits)
  if (amount === null)
    return minorUnits === 0
      ? '餘額請輸入整數，例如 12000'
      : `餘額最多 ${minorUnits} 位小數`
  return { openingBalance: isDebt(row.kind) ? neg(amount) : amount }
}

// ---------- a new account's opening, as lines under it (ADR-137)

export type OpeningCellKey = 'openingBilled' | 'openingUnbilled' | 'openingDate'

export interface OpeningCell {
  key: OpeningCellKey
  label: string
  /** Tells these cells from a loan's or a card's. */
  opening: true
}

/**
 * The lines under a new account about where it starts: the day of its
 * balance, and for a card the balance split into its latest bill and what
 * is not billed yet. None once the account is saved.
 */
export function openingLines(
  row: AccountRow,
): Array<{ cells: Array<OpeningCell> }> {
  if (row.base) return []
  const date = {
    cells: [{ key: 'openingDate', label: '餘額日期', opening: true } as const],
  }
  if (row.kind !== 'credit_card') return [date]
  return [
    {
      cells: [
        { key: 'openingBilled', label: '本期帳單', opening: true },
        { key: 'openingUnbilled', label: '未出帳金額', opening: true },
      ],
    },
    date,
  ]
}

export function openingCellText(
  row: AccountRow,
  cell: OpeningCell,
  minorUnits: number,
): string {
  switch (cell.key) {
    case 'openingBilled':
      return owedText(row.openingBilled, row.kind, minorUnits)
    case 'openingUnbilled':
      return owedText(
        row.openingBalance - row.openingBilled,
        row.kind,
        minorUnits,
      )
    case 'openingDate':
      return row.openingDate.replaceAll('-', '/')
  }
}

/** How a cell's value is typed and shown (as `cardCellNumeric`). */
export function openingCellNumeric(cell: OpeningCell): 'amount' | 'number' {
  return cell.key === 'openingDate' ? 'number' : 'amount'
}

/** The change a value typed into an opening line makes, or why it cannot. */
export function openingCellPatch(
  row: AccountRow,
  cell: OpeningCell,
  text: string,
  minorUnits: number,
  today: Date,
): Partial<AccountRow> | string {
  if (cell.key === 'openingDate') {
    if (text.trim() === '') return '請輸入餘額是哪一天的'
    const date = parseDate(text, today)
    return date ? { openingDate: date } : '日期看不懂，例如 11/20 或 t（今天）'
  }
  const amount = evalAmount(text, minorUnits)
  if (amount === null)
    return minorUnits === 0
      ? '金額請輸入整數，例如 12000'
      : `金額最多 ${minorUnits} 位小數`
  const signed = isDebt(row.kind) ? neg(amount) : amount
  if (cell.key === 'openingBilled') {
    const unbilled = row.openingBalance - row.openingBilled
    return { openingBilled: signed, openingBalance: unbilled + signed }
  }
  return { openingBalance: row.openingBilled + signed }
}

export function kindLabel(kind: NewAccountKind): string {
  return kindOptions.find((k) => k.value === kind)?.label ?? kind
}

/** A card's statement and due days in a few characters: 5 結 / 20 繳. */
export function cardText(card: CardSettings | null | string): string {
  if (typeof card === 'string') return '未填完'
  return card ? `${card.statementDay} 結 · ${card.dueDay} 繳` : ''
}

// ---------- what can be edited

/** Why a cell cannot be edited, or null. */
export function lockedReason(
  row: AccountRow,
  column: AccountColumn,
): string | null {
  if (row.deleted) return '這個帳戶已標記刪除，按 u 復原或 dd 取消'
  switch (column) {
    case 'kind':
      return row.base
        ? '帳戶建立後不能改類型和是否計入預算（有交易時會破壞預算的平衡）'
        : null
    case 'onBudget':
      if (row.base)
        return '帳戶建立後不能改類型和是否計入預算（有交易時會破壞預算的平衡）'
      if (row.kind === 'credit_card') return '信用卡一定計入預算'
      if (row.kind === 'loan' || row.kind === 'investment')
        return '貸款和投資帳戶在預算外'
      return null
    case 'balance':
      return row.base ? '餘額由交易決定：到帳戶明細記一筆，或對帳調整' : null
    case 'cleared':
      return '已核對的餘額由帳戶明細裡核對的交易決定'
    case 'card':
      return row.kind === 'credit_card' ? null : '只有信用卡有帳單設定'
    case 'status':
      return null
    default:
      return null
  }
}
