import { amountInputValue, parseAmount } from './money.ts'
import type { CardSettings } from './accounts.ts'
import type { Option } from './form.ts'

// A credit card's statement settings as lines of the accounts grid, under
// the card's line, as a loan's terms are (ADR-110, ADR-117): two settings
// to a line, edited with i like any cell; the account it is paid from is
// picked from the completion list. Kept as text while edited, so a card
// can be half filled in until :w. Pure, tested.

export type CardCellKey = 'statementDay' | 'dueDay' | 'limit' | 'autopay'

export interface CardCell {
  key: CardCellKey
  label: string
}

export interface CardLine {
  cells: Array<CardCell>
}

/** The settings as the lines hold them: text, '' for not set. */
export interface CardValues {
  statementDay: string
  dueDay: string
  limit: string
  /** The account it is paid from; '' for none. */
  autopay: string
}

export interface CardRefs {
  /** Accounts a card can be paid from, by id. */
  payers: Map<string, string>
  minorUnits: number
}

export const cardLines: Array<CardLine> = [
  {
    cells: [
      { key: 'statementDay', label: '結帳日（日）' },
      { key: 'dueDay', label: '繳款截止日（日）' },
    ],
  },
  {
    cells: [
      { key: 'limit', label: '信用額度' },
      { key: 'autopay', label: '自動扣繳' },
    ],
  },
]

export function cardValuesOf(
  card: CardSettings | null,
  minorUnits: number,
): CardValues {
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

const NO_AUTOPAY = '不扣繳'

/** A value as the cell shows it, and as editing starts from. */
export function cardCellText(
  v: CardValues,
  cell: CardCell,
  refs: CardRefs,
): string {
  switch (cell.key) {
    case 'statementDay':
      return v.statementDay
    case 'dueDay':
      return v.dueDay
    case 'limit':
      return v.limit
    case 'autopay':
      return v.autopay ? (refs.payers.get(v.autopay) ?? '') : NO_AUTOPAY
  }
}

/** What an empty cell says, in the muted colour. */
export function cardCellPlaceholder(cell: CardCell): string {
  return cell.key === 'limit' ? '不填' : cell.key === 'autopay' ? '' : '1–31'
}

export function cardCellNumeric(cell: CardCell): boolean {
  return cell.key !== 'autopay'
}

/** The options of a choice, picked from the completion list; null for typed values. */
export function cardCellOptions(
  cell: CardCell,
  refs: CardRefs,
): Array<Option> | null {
  if (cell.key !== 'autopay') return null
  return [
    { value: '', label: NO_AUTOPAY },
    ...[...refs.payers].map(([value, label]) => ({ value, label })),
  ]
}

/** The settings with a value typed or picked, or why it cannot be. */
export function cardCellPatch(
  v: CardValues,
  cell: CardCell,
  text: string,
  refs: CardRefs,
): CardValues | string {
  const value = text.trim()
  switch (cell.key) {
    case 'statementDay':
    case 'dueDay': {
      if (value === '') return { ...v, [cell.key]: '' }
      const n = Number(value)
      if (!/^\d+$/.test(value) || n < 1 || n > 31)
        return '請輸入 1 到 31 的日子，例如 5'
      return { ...v, [cell.key]: String(n) }
    }
    case 'limit': {
      if (value === '') return { ...v, limit: '' }
      const n = parseAmount(value, refs.minorUnits)
      if (n === null || n < 0) return '信用額度的金額不對，例如 100000'
      return { ...v, limit: amountInputValue(n, refs.minorUnits) }
    }
    case 'autopay': {
      if (value === '' || value === NO_AUTOPAY) return { ...v, autopay: '' }
      const id = [...refs.payers].find(([, name]) => name === value)?.[0]
      return id ? { ...v, autopay: id } : `找不到可以扣款的帳戶「${value}」`
    }
  }
}

/**
 * The settings the values come to: null when nothing is filled in (only
 * the balance is kept), or why they are not complete.
 */
export function cardFromValues(
  v: CardValues,
  minorUnits: number,
): CardSettings | null | string {
  if (!v.statementDay && !v.dueDay && !v.limit && !v.autopay) return null
  if (!v.statementDay || !v.dueDay)
    return '信用卡設定：結帳日和繳款截止日都要填（或都不填）'
  const creditLimit = v.limit === '' ? null : parseAmount(v.limit, minorUnits)
  return {
    statementDay: Number(v.statementDay),
    dueDay: Number(v.dueDay),
    creditLimit,
    autopayAccountId: v.autopay || null,
  }
}
