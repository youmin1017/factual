import { cardFromValues } from './card-lines.ts'
import { parseLoanFields } from './loan.ts'
import { amountInputValue, formatAmount, parseAmount } from './money.ts'
import type { Schemas } from './api'
import type { CardValues } from './card-lines.ts'
import type { Field, Option } from './form.ts'
import type { LoanFieldValues } from './loan.ts'

// The accounts page (ADR-108): its lines, edited as the goals page's are
// and saved with :w; what an account is set up with is edited in a form
// under the cell (ADR-107), a loan's terms and a card's settings in lines
// under the account's (ADR-110, ADR-117). Pure, tested with node.

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
  if (card && typeof card === 'object') input.card = { ...card }
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
  }
  return null
}

// ---------- cells

export function accountCellText(
  row: AccountRow,
  column: AccountColumn,
): string {
  return column === 'name' ? row.name : ''
}

export function kindLabel(kind: NewAccountKind): string {
  return kindOptions.find((k) => k.value === kind)?.label ?? kind
}

/** A card's statement and due days in a few characters: 5 結 / 20 繳. */
export function cardText(card: CardSettings | null | string): string {
  if (typeof card === 'string') return '未填完'
  return card ? `${card.statementDay} 結 · ${card.dueDay} 繳` : ''
}

// ---------- the forms (ADR-107)

/** The columns edited in a form: what a new account is. */
export function formOf(row: AccountRow, column: AccountColumn): 'setup' | null {
  if (column === 'kind' || column === 'onBudget' || column === 'balance')
    return row.base ? null : 'setup'
  return null
}

/** Why a cell cannot be edited, or null. */
export function lockedReason(
  row: AccountRow,
  column: AccountColumn,
): string | null {
  if (row.deleted) return '這個帳戶已標記刪除，按 u 復原或 dd 取消'
  switch (column) {
    case 'kind':
    case 'onBudget':
      return row.base
        ? '帳戶建立後不能改類型和是否計入預算（有交易時會破壞預算的平衡）'
        : null
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

export function setupValues(
  row: AccountRow,
  minorUnits: number,
): Record<string, string> {
  const owed = isDebt(row.kind) ? -row.openingBalance : row.openingBalance
  return {
    kind: row.kind,
    onBudget: row.onBudget ? 'yes' : 'no',
    balance: row.openingBalance === 0 ? '' : amountInputValue(owed, minorUnits),
    date: row.openingDate,
  }
}

export function setupFields(values: Record<string, string>): Array<Field> {
  const kind = values.kind as NewAccountKind
  const fields: Array<Field> = [
    { key: 'kind', label: '類型', type: 'choice', options: kindOptions },
  ]
  if (kind === 'bank' || kind === 'cash') {
    fields.push({
      key: 'onBudget',
      label: '預算',
      type: 'choice',
      options: [
        { value: 'yes', label: '計入預算' },
        { value: 'no', label: '預算外（只追蹤餘額）' },
      ],
    })
  }
  fields.push(
    {
      key: 'balance',
      label: isDebt(kind) ? '目前欠款' : '目前餘額',
      type: 'amount',
      placeholder: '0',
    },
    { key: 'date', label: '那天是', type: 'date' },
  )
  return fields
}

export function applySetup(
  values: Record<string, string>,
  minorUnits: number,
): Partial<AccountRow> | string {
  const kind = values.kind as NewAccountKind
  const amount = parseAmount(values.balance, minorUnits)
  if (amount === null)
    return minorUnits === 0
      ? '餘額請輸入整數，例如 12000'
      : `餘額最多 ${minorUnits} 位小數`
  if (!values.date) return '請輸入餘額是哪一天的'
  return {
    kind,
    onBudget: onBudgetOf(kind, values.onBudget !== 'no'),
    // Debts are typed as the amount owed and kept as a negative balance.
    openingBalance: isDebt(kind) ? -amount : amount,
    openingDate: values.date,
  }
}

/** What the setup form's values come to, in a sentence. */
export function setupPreview(
  values: Record<string, string>,
  minorUnits: number,
): string {
  const patch = applySetup(values, minorUnits)
  if (typeof patch === 'string') return patch
  const kind = patch.kind ?? 'bank'
  const where = patch.onBudget ? '計入預算' : '不計入預算'
  const amount = formatAmount(Math.abs(patch.openingBalance ?? 0), minorUnits)
  const what = isDebt(kind) ? `欠 ${amount}` : `有 ${amount}`
  return kind === 'loan'
    ? `${where}；${what}（填了貸款條件就照條件算）。條件在這一列底下（za 展開）`
    : `${where}；${(patch.openingDate ?? '').replaceAll('-', '/')} ${what}`
}
