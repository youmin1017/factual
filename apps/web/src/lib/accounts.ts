import { parseLoanFields } from './loan.ts'
import { amountInputValue, formatAmount, parseAmount } from './money.ts'
import type { Schemas } from './api'
import type { Field, Option } from './form.ts'
import type { LoanFieldValues } from './loan.ts'

// The accounts page (ADR-108): its lines, edited as the goals page's are
// and saved with :w; what an account is set up with is edited in a form
// under the cell (ADR-107). Pure, tested with node.

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
    loan: null,
  }
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
  if (row.kind === 'credit_card' && row.card) input.card = { ...row.card }
  if (row.kind === 'loan' && row.loan) {
    const terms = parseLoanFields(row.loan, minorUnits)
    if (!('field' in terms)) input.loan = terms
  }
  return input
}

/** Whether the line differs from its saved account (its place aside). */
export function accountStatus(row: AccountRow): AccountRowStatus {
  if (row.deleted) return 'deleted'
  if (!row.base) return 'new'
  const saved = rowFromAccount(row.base)
  const same =
    row.loan === null &&
    row.name.trim() === saved.name &&
    row.closed === saved.closed &&
    JSON.stringify(row.kind === 'credit_card' ? row.card : null) ===
      JSON.stringify(saved.kind === 'credit_card' ? saved.card : null)
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
export function cardText(card: CardSettings | null): string {
  return card ? `${card.statementDay} 結 · ${card.dueDay} 繳` : ''
}

// ---------- the forms (ADR-107)

/** The columns edited in a form: what a new account is, and a card's settings. */
export function formOf(
  row: AccountRow,
  column: AccountColumn,
): 'setup' | 'card' | null {
  if (column === 'card') return row.kind === 'credit_card' ? 'card' : null
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

export function cardValues(
  card: CardSettings | null,
  minorUnits: number,
): Record<string, string> {
  return {
    statementDay: card ? String(card.statementDay) : '',
    dueDay: card ? String(card.dueDay) : '',
    limit:
      card?.creditLimit != null
        ? amountInputValue(card.creditLimit, minorUnits)
        : '',
    autopay: card?.autopayAccountId ?? '',
  }
}

/** The card form's fields; `payers` are the accounts a card can be paid from. */
export function cardFields(payers: Array<Option>): Array<Field> {
  return [
    { key: 'statementDay', label: '結帳日', type: 'number', suffix: '日' },
    { key: 'dueDay', label: '繳款截止', type: 'number', suffix: '日' },
    {
      key: 'limit',
      label: '信用額度',
      type: 'amount',
      placeholder: '不填',
    },
    {
      key: 'autopay',
      label: '自動扣繳',
      type: 'choice',
      options: [{ value: '', label: '不扣繳' }, ...payers],
    },
  ]
}

export function applyCard(
  values: Record<string, string>,
  minorUnits: number,
): Partial<AccountRow> | string {
  const blank = (s: string) => s.trim() === ''
  if (blank(values.statementDay) && blank(values.dueDay) && blank(values.limit))
    return { card: null }
  const day = (text: string) => {
    const n = Number(text.trim())
    return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null
  }
  const statementDay = day(values.statementDay)
  const dueDay = day(values.dueDay)
  if (statementDay === null || dueDay === null)
    return '結帳日和繳款截止日請輸入 1 到 31'
  let creditLimit: number | null = null
  if (!blank(values.limit)) {
    creditLimit = parseAmount(values.limit, minorUnits)
    if (creditLimit === null || creditLimit < 0) return '信用額度的金額不對'
  }
  return {
    card: {
      statementDay,
      dueDay,
      creditLimit,
      autopayAccountId: values.autopay || null,
    },
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
