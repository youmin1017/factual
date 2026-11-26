/**
 * Loans (ADR-096..098): the terms as typed in the 貸款設定 dialog and back,
 * and the words the loan's page uses. The table itself is computed on the
 * server only (the dialog previews it there), so nothing here does
 * amortization. Pure, tested with `pnpm test`.
 */
import { amountInputValue, parseAmount } from './money.ts'
import type { Schemas } from './api'

export type LoanTerms = Schemas['LoanTerms']
export type LoanDetails = Schemas['LoanDetails']
export type LoanPeriod = Schemas['LoanPeriod']
export type LoanPreview = Schemas['LoanPreview']
export type LoanCheck = Schemas['LoanCheck']
export type LoanMethod = LoanTerms['method']
export type PrepayMode = LoanTerms['prepayMode']
export type LoanShift = LoanTerms['holidayShift']

export const methodLabels: Record<LoanMethod, string> = {
  annuity: '本息平均攤還',
  equalPrincipal: '本金平均攤還',
}

export const prepayLabels: Record<PrepayMode, string> = {
  shortenTerm: '縮短期數（月付不變）',
  reducePayment: '降低月付（期數不變）',
}

export const shiftLabels: Record<LoanShift, string> = {
  nextWorkday: '遇假日延後扣款',
  prevWorkday: '遇假日提前扣款',
  noShift: '遇假日照常',
}

export const periodStates: Record<
  LoanPeriod['state'],
  { label: string; tone: string }
> = {
  before: { label: '設定前', tone: 'text-muted-foreground' },
  posted: { label: '已入帳', tone: 'text-positive' },
  skipped: { label: '略過', tone: 'text-muted-foreground' },
  pending: { label: '待入帳', tone: 'text-kraft' },
  planned: { label: '預計', tone: '' },
}

export interface LoanRateValues {
  from: string
  rate: string
}

/** The terms as typed: text for every field, ids for the selects ('' for none). */
export interface LoanFieldValues {
  principal: string
  months: string
  start: string
  firstPayment: string
  method: LoanMethod
  grace: string
  prepay: PrepayMode
  /** The first applies from 撥款日; later ones are rate changes. */
  rates: Array<LoanRateValues>
  payFrom: string
  principalCategory: string
  interestCategory: string
  shift: LoanShift
}

export type LoanField = keyof LoanFieldValues

/** The same day a month later, or the month's last day when it has none. */
export function monthAfter(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return ''
  const y = Number(m[1])
  const month = Number(m[2]) // the next month, 0-based
  const last = new Date(Date.UTC(y, month + 1, 0)).getUTCDate()
  const d = Math.min(Number(m[3]), last)
  const next = new Date(Date.UTC(y, month, d))
  return next.toISOString().slice(0, 10)
}

/** Rates are shown with no trailing zeros: 2.35, not 2.3500. */
export function rateText(rate: number): string {
  return String(Number(rate.toFixed(4)))
}

export function loanFieldValues(
  terms: LoanTerms | null,
  minorUnits: number,
  today: string,
): LoanFieldValues {
  if (!terms) {
    return {
      principal: '',
      months: '',
      start: today,
      firstPayment: monthAfter(today),
      method: 'annuity',
      grace: '0',
      prepay: 'shortenTerm',
      rates: [{ from: today, rate: '' }],
      payFrom: '',
      principalCategory: '',
      interestCategory: '',
      shift: 'nextWorkday',
    }
  }
  return {
    principal: amountInputValue(terms.principal, minorUnits),
    months: String(terms.termMonths),
    start: terms.startDate,
    firstPayment: terms.firstPaymentDate,
    method: terms.method,
    grace: String(terms.graceMonths),
    prepay: terms.prepayMode,
    rates: terms.rates.map((r) => ({
      from: r.effectiveFrom,
      rate: rateText(r.annualRate),
    })),
    payFrom: terms.payFromAccountId ?? '',
    principalCategory: terms.principalCategoryId ?? '',
    interestCategory: terms.interestCategoryId ?? '',
    shift: terms.holidayShift,
  }
}

/** Months typed as a whole number of months (ADR-107: no little language). */
export function parseMonths(text: string): number | null {
  const s = text.trim()
  return /^\d+$/.test(s) ? Number(s) : null
}

/** A rate typed as a percent (`2.35` or `2.35%`), at most four decimals. */
export function parseRate(text: string): number | null {
  const s = text.trim().replace(/%$/, '').trim()
  if (!/^\d+(\.\d{1,4})?$/.test(s)) return null
  const n = Number(s)
  return n <= 100 ? n : null
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

export interface LoanProblem {
  field: LoanField
  message: string
}

/** The terms typed, or the first thing wrong with them. */
export function parseLoanFields(
  v: LoanFieldValues,
  minorUnits: number,
): LoanTerms | LoanProblem {
  const principal = parseAmount(v.principal, minorUnits)
  if (principal === null || principal <= 0)
    return { field: 'principal', message: '請輸入撥款金額' }
  const months = parseMonths(v.months)
  if (months === null || months < 1 || months > 600)
    return { field: 'months', message: '期數是 1 到 600 的整數（月）' }
  if (!isDate(v.start)) return { field: 'start', message: '請輸入撥款日' }
  if (!isDate(v.firstPayment) || v.firstPayment <= v.start)
    return { field: 'firstPayment', message: '首期繳款日要在撥款日之後' }
  const grace = v.grace.trim() === '' ? 0 : parseMonths(v.grace)
  if (grace === null || grace >= months)
    return { field: 'grace', message: '寬限期要比期數短' }
  const rates: LoanTerms['rates'] = []
  for (const [i, r] of v.rates.entries()) {
    const annualRate = parseRate(r.rate)
    if (annualRate === null)
      return {
        field: 'rates',
        message: i === 0 ? '請輸入年利率，例如 2.35' : `第 ${i + 1} 段利率不對`,
      }
    const from = i === 0 ? v.start : r.from
    if (!isDate(from) || (i > 0 && from <= rates[i - 1].effectiveFrom))
      return {
        field: 'rates',
        message: '利率調整的日期要一段比一段晚，而且在撥款日之後',
      }
    rates.push({ effectiveFrom: from, annualRate })
  }
  if (v.payFrom && (!v.principalCategory || !v.interestCategory))
    return {
      field: v.principalCategory ? 'interestCategory' : 'principalCategory',
      message: '自動還款要選本金和利息的分類',
    }
  return {
    principal,
    termMonths: months,
    startDate: v.start,
    firstPaymentDate: v.firstPayment,
    method: v.method,
    graceMonths: grace,
    prepayMode: v.prepay,
    rates,
    payFromAccountId: v.payFrom || null,
    principalCategoryId: v.payFrom ? v.principalCategory || null : null,
    interestCategoryId: v.payFrom ? v.interestCategory || null : null,
    holidayShift: v.shift,
  }
}

/** The field a server problem names (`details.field`), as the form's. */
export function problemField(field: unknown): LoanField | null {
  const map: Record<string, LoanField> = {
    principal: 'principal',
    termMonths: 'months',
    startDate: 'start',
    firstPaymentDate: 'firstPayment',
    graceMonths: 'grace',
    rates: 'rates',
    payFromAccountId: 'payFrom',
    principalCategoryId: 'principalCategory',
    interestCategoryId: 'interestCategory',
  }
  return typeof field === 'string' ? (map[field] ?? null) : null
}

export function payment(p: LoanPeriod): number {
  return p.principal + p.interest
}

/**
 * How far the loan account is from the terms before the first payment its
 * schedule pays: positive when the account says more is owed.
 */
export function checkGap(check: LoanCheck | null): number {
  return check ? check.recorded - check.computed : 0
}
