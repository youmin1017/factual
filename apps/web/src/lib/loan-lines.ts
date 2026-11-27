import {
  methodLabels,
  monthAfter,
  parseRate,
  prepayLabels,
  shiftLabels,
} from './loan.ts'
import { amountInputValue } from './money.ts'
import { evalAmount, parseDate } from './register.ts'
import type { Option } from './form.ts'
import type {
  LoanFieldValues,
  LoanMethod,
  LoanShift,
  PrepayMode,
} from './loan.ts'

// A loan's terms as lines of the accounts grid, under the loan's line
// (ADR-110): two related terms to a line (h/l between them), a line per
// rate period, moved through with j/k and edited with i like any cell.
// Choices are picked from the completion list (ADR-107). Pure, tested.

export type LoanCellKey =
  | 'principal'
  | 'months'
  | 'start'
  | 'firstPayment'
  | 'method'
  | 'grace'
  | 'rateFrom'
  | 'rate'
  | 'payFrom'
  | 'prepay'
  | 'principalCategory'
  | 'interestCategory'
  | 'shift'

export interface LoanCell {
  key: LoanCellKey
  label: string
  /** Which rate period a rate cell belongs to. */
  rate?: number
}

export interface LoanLine {
  /** One or two cells, left to right. */
  cells: Array<LoanCell>
}

/** What the lines show by name: accounts it can be paid from, expense categories. */
export interface LoanRefs {
  /** Accounts a loan can be paid from, by id. */
  payers: Map<string, string>
  /** Expense categories by id, with their paths. */
  categories: Map<string, string>
  minorUnits: number
}

export function loanLines(v: LoanFieldValues): Array<LoanLine> {
  const lines: Array<LoanLine> = [
    {
      cells: [
        { key: 'principal', label: '撥款金額' },
        { key: 'months', label: '期數（月）' },
      ],
    },
    {
      cells: [
        { key: 'start', label: '撥款日' },
        { key: 'firstPayment', label: '首期繳款日' },
      ],
    },
    {
      cells: [
        { key: 'method', label: '攤還方式' },
        { key: 'grace', label: '寬限期（月）' },
      ],
    },
    ...v.rates.map((_, i): LoanLine => ({
      cells: [
        {
          key: 'rateFrom',
          label: i === 0 ? '利率起日' : `第 ${i + 1} 段起日`,
          rate: i,
        },
        { key: 'rate', label: '年利率（%）', rate: i },
      ],
    })),
    {
      cells: [
        { key: 'payFrom', label: '扣款帳戶' },
        { key: 'prepay', label: '提前還款時' },
      ],
    },
  ]
  if (v.payFrom) {
    lines.push(
      {
        cells: [
          { key: 'principalCategory', label: '本金記在' },
          { key: 'interestCategory', label: '利息記在' },
        ],
      },
      { cells: [{ key: 'shift', label: '扣款日遇假日' }] },
    )
  }
  return lines
}

const slash = (iso: string) => iso.replaceAll('-', '/')

/** A value as the cell shows it, and as editing starts from. */
export function loanCellText(
  v: LoanFieldValues,
  cell: LoanCell,
  refs: LoanRefs,
): string {
  const r = v.rates[cell.rate ?? 0]
  switch (cell.key) {
    case 'principal':
      return v.principal
    case 'months':
      return v.months
    case 'start':
      return slash(v.start)
    case 'firstPayment':
      return slash(v.firstPayment)
    case 'method':
      return methodLabels[v.method]
    case 'grace':
      return v.grace
    case 'rateFrom':
      return slash((cell.rate ?? 0) === 0 ? v.start : r.from)
    case 'rate':
      return r.rate
    case 'payFrom':
      return v.payFrom ? (refs.payers.get(v.payFrom) ?? '') : '不自動還款'
    case 'prepay':
      return prepayLabels[v.prepay]
    case 'principalCategory':
      return refs.categories.get(v.principalCategory) ?? ''
    case 'interestCategory':
      return refs.categories.get(v.interestCategory) ?? ''
    case 'shift':
      return shiftLabels[v.shift]
  }
}

/**
 * How a cell's value is typed and shown: an amount (digits grouped as the
 * user prefers, ADR-122), a number or a date (the mono face), or text.
 */
export function loanCellNumeric(cell: LoanCell): 'amount' | 'number' | null {
  if (cell.key === 'principal') return 'amount'
  return [
    'months',
    'start',
    'firstPayment',
    'grace',
    'rateFrom',
    'rate',
  ].includes(cell.key)
    ? 'number'
    : null
}

/** The options of a choice, picked from the completion list; null for typed values. */
export function loanCellOptions(
  cell: LoanCell,
  refs: LoanRefs,
): Array<Option> | null {
  const of = (labels: Record<string, string>) =>
    Object.entries(labels).map(([value, label]) => ({ value, label }))
  switch (cell.key) {
    case 'method':
      return of(methodLabels)
    case 'prepay':
      return of(prepayLabels)
    case 'shift':
      return of(shiftLabels)
    case 'payFrom':
      return [
        { value: '', label: '不自動還款' },
        ...[...refs.payers].map(([value, label]) => ({ value, label })),
      ]
    case 'principalCategory':
    case 'interestCategory':
      return [...refs.categories].map(([value, label]) => ({ value, label }))
    default:
      return null
  }
}

/** Why a cell cannot be edited: the first rate runs from 撥款日. */
export function loanCellLocked(cell: LoanCell): string | null {
  if (cell.key === 'rateFrom' && (cell.rate ?? 0) === 0)
    return '第一段利率從撥款日起；改撥款日就好'
  return null
}

/** The terms with a value typed or picked, or why it cannot be. */
export function loanCellPatch(
  v: LoanFieldValues,
  cell: LoanCell,
  text: string,
  refs: LoanRefs,
  today: Date,
): LoanFieldValues | string {
  const value = text.trim()
  const pick = <T extends string>(labels: Record<T, string>): T | null =>
    (Object.keys(labels) as Array<T>).find(
      (k) => labels[k] === value || k === value,
    ) ?? null
  const date = (): string | null => parseDate(value, today)
  const i = cell.rate ?? 0
  switch (cell.key) {
    case 'principal': {
      const n = evalAmount(value, refs.minorUnits)
      if (n === null || n <= 0) return '撥款金額要大於 0，例如 1000000'
      return { ...v, principal: amountInputValue(n, refs.minorUnits) }
    }
    case 'months': {
      const n = Number(value)
      if (!/^\d+$/.test(value) || n < 1 || n > 600)
        return '期數是 1 到 600 的整數（月），例如 240'
      return { ...v, months: String(n) }
    }
    case 'start': {
      const d = date()
      if (!d) return '看不懂這個日期：可以輸入 2025/1/10、1/10'
      // A first payment that followed 撥款日 moves along with it.
      const firstPayment =
        v.firstPayment === monthAfter(v.start) ? monthAfter(d) : v.firstPayment
      return { ...v, start: d, firstPayment }
    }
    case 'firstPayment': {
      const d = date()
      if (!d) return '看不懂這個日期：可以輸入 2025/2/10、2/10'
      return { ...v, firstPayment: d }
    }
    case 'grace': {
      const n = value || '0'
      if (!/^\d+$/.test(n)) return '寬限期是整數（月），例如 0 或 12'
      return { ...v, grace: String(Number(n)) }
    }
    case 'method': {
      const m = pick<LoanMethod>(methodLabels)
      return m ? { ...v, method: m } : '請從清單選攤還方式'
    }
    case 'prepay': {
      const m = pick<PrepayMode>(prepayLabels)
      return m ? { ...v, prepay: m } : '請從清單選提前還款的方式'
    }
    case 'shift': {
      const m = pick<LoanShift>(shiftLabels)
      return m ? { ...v, shift: m } : '請從清單選'
    }
    case 'rateFrom': {
      const d = date()
      if (!d) return '看不懂這個日期：可以輸入 2026/7/1'
      return { ...v, rates: v.rates.with(i, { ...v.rates[i], from: d }) }
    }
    case 'rate': {
      if (!/^\d+(\.\d+)?$/.test(value) || parseRate(value) === null)
        return '年利率是 0 到 100 的數字，例如 2.35'
      return { ...v, rates: v.rates.with(i, { ...v.rates[i], rate: value }) }
    }
    case 'payFrom': {
      if (value === '' || value === '不自動還款') return { ...v, payFrom: '' }
      const id = [...refs.payers].find(([, name]) => name === value)?.[0]
      return id ? { ...v, payFrom: id } : `找不到可以扣款的帳戶「${value}」`
    }
    case 'principalCategory':
    case 'interestCategory': {
      if (value === '') return { ...v, [cell.key]: '' }
      const id = [...refs.categories].find(([, path]) => path === value)?.[0]
      return id ? { ...v, [cell.key]: id } : `找不到支出類別「${value}」`
    }
  }
}

/** `o` on the terms: a rate change after `after`, today, at the same rate. */
export function addRate(
  v: LoanFieldValues,
  after: number,
  today: string,
): LoanFieldValues {
  const rate = v.rates[after]?.rate ?? ''
  return { ...v, rates: v.rates.toSpliced(after + 1, 0, { from: today, rate }) }
}

/** `dd` on a rate change; the first rate stays. */
export function removeRate(
  v: LoanFieldValues,
  i: number,
): LoanFieldValues | string {
  if (i === 0) return '第一段利率不能刪；改它的利率就好'
  return { ...v, rates: v.rates.filter((_, j) => j !== i) }
}
