/**
 * The schedules page's data model (ADR-084..086), without React: a schedule
 * as an editable line and back, what typing into each cell changes, and
 * validation. Pure, tested with plain node (`schedules.test.ts`).
 */
import { amountInputValue, formatAmount } from './money.ts'
import {
  evalAmount,
  findCategory,
  lineCategoryMode,
  parseDate,
} from './register.ts'
import { describeRRule, nextOccurrences, parseRule } from './schedule-rule.ts'
import type { Schemas } from './api'
import type { Context } from './register.ts'
import type { HolidayShift, Occurrence } from './schedule-rule.ts'

export type Schedule = Schemas['Schedule']
export type ScheduleInput = Schemas['ScheduleInput']
export type BudgetMode = Schemas['BudgetMode']

export type ScheduleColumn =
  | 'rule'
  | 'next'
  | 'payee'
  | 'note'
  | 'category'
  | 'account'
  | 'outflow'
  | 'inflow'
  | 'mode'

export const scheduleColumns: Array<ScheduleColumn> = [
  'rule',
  'next',
  'payee',
  'note',
  'category',
  'account',
  'outflow',
  'inflow',
  'mode',
]

export const scheduleLabels: Record<ScheduleColumn, string> = {
  rule: '週期',
  next: '下次',
  payee: '收付款對象',
  note: '備註',
  category: '類別',
  account: '帳戶',
  outflow: '支出',
  inflow: '收入',
  mode: '預算方式',
}

export const modeLabels: Record<BudgetMode, string> = {
  notBudgeted: '不納入',
  full: '到期月全額',
  spread: '平均攤提',
}

/** One schedule as the page edits it. */
export interface ScheduleRow {
  id: string
  /** The saved schedule; null for a line never saved. */
  base: Schedule | null
  deleted: boolean
  /**
   * The rule as text. Typed rules are kept as `describeRule` shows them;
   * the cell always shows that (`ruleText`), whatever an older save kept.
   */
  source: string
  /** The RRULE; empty until a rule is typed. */
  rule: string
  shift: HolidayShift
  /** DTSTART, ISO; empty until a rule is typed. */
  start: string
  payee: string
  transferTo: string | null
  note: string
  categoryId: string | null
  accountId: string
  /** Change in the account's balance per occurrence, in minor units. */
  amount: number
  estimate: boolean
  budgetMode: BudgetMode
  paused: boolean
}

export type ScheduleStatus = 'clean' | 'new' | 'changed' | 'deleted'

export interface ScheduleProblem {
  field: ScheduleColumn | null
  message: string
}

export function rowFromSchedule(s: Schedule): ScheduleRow {
  return {
    id: s.id,
    base: s,
    deleted: false,
    source: s.source,
    rule: s.rule,
    shift: s.holidayShift,
    start: s.start,
    payee: s.payee,
    transferTo: s.transferAccountId,
    note: s.note,
    categoryId: s.categoryId,
    accountId: s.accountId,
    amount: s.amount,
    estimate: s.estimate,
    budgetMode: s.budgetMode,
    paused: s.paused,
  }
}

/** A blank line on an account; spending is budgeted in full by default (ADR-086). */
export function newScheduleRow(id: string, accountId: string): ScheduleRow {
  return {
    id,
    base: null,
    deleted: false,
    source: '',
    rule: '',
    shift: 'noShift',
    start: '',
    payee: '',
    transferTo: null,
    note: '',
    categoryId: null,
    accountId,
    amount: 0,
    estimate: false,
    budgetMode: 'full',
    paused: false,
  }
}

export function toScheduleInput(row: ScheduleRow): ScheduleInput {
  return {
    id: row.id,
    source: row.source,
    rule: row.rule,
    start: row.start,
    holidayShift: row.shift,
    payee: row.transferTo ? '' : row.payee,
    note: row.note,
    accountId: row.accountId,
    transferAccountId: row.transferTo,
    categoryId: row.categoryId,
    amount: row.amount,
    estimate: row.estimate,
    budgetMode: row.budgetMode,
    paused: row.paused,
  }
}

function inputOf(s: Schedule): ScheduleInput {
  return toScheduleInput(rowFromSchedule(s))
}

export function scheduleStatus(row: ScheduleRow): ScheduleStatus {
  if (row.deleted) return 'deleted'
  if (!row.base) return 'new'
  return JSON.stringify(toScheduleInput(row)) ===
    JSON.stringify(inputOf(row.base))
    ? 'clean'
    : 'changed'
}

/** What has to be right before :w, the first problem only. */
export function validateSchedule(
  row: ScheduleRow,
  ctx: Context,
): ScheduleProblem | null {
  if (row.deleted) return null
  if (!row.rule)
    return { field: 'rule', message: '請輸入週期，例如：每月 5 日' }
  if (!row.start) return { field: 'next', message: '請輸入下次的日期' }
  if (!ctx.accounts.has(row.accountId)) {
    return { field: 'account', message: '請選擇帳戶' }
  }
  if (row.amount === 0) return { field: 'outflow', message: '請輸入金額' }
  if (
    lineCategoryMode(row.accountId, row.transferTo, ctx) === 'required' &&
    !row.categoryId
  ) {
    return { field: 'category', message: '預算內帳戶的排程需要類別' }
  }
  return null
}

/**
 * The next occurrence the line shows: the server's for a saved schedule
 * whose rule and start are untouched (it knows what was posted), else the
 * first one from its start, or from today when that is later. Null when the
 * rule has ended or there is no rule yet.
 */
export function nextOf(
  row: ScheduleRow,
  today: string,
  off?: (iso: string) => boolean,
): Occurrence | null {
  const b = row.base
  if (
    b &&
    b.rule === row.rule &&
    b.start === row.start &&
    b.holidayShift === row.shift
  ) {
    return b.nextOccurrence && b.nextDate
      ? { nominal: b.nextOccurrence, date: b.nextDate }
      : null
  }
  if (!row.rule || !row.start) return null
  const from = row.base && row.start < today ? today : row.start
  return (
    nextOccurrences(row.rule, row.start, row.shift, from, 1, off).at(0) ?? null
  )
}

/** Amount cell text: the amount, `~` first for an estimate. */
export function scheduleAmountText(
  row: ScheduleRow,
  column: 'outflow' | 'inflow',
  minorUnits: number,
  forInput = false,
): string {
  const show = column === 'outflow' ? row.amount < 0 : row.amount > 0
  if (!show) return ''
  const abs = Math.abs(row.amount)
  const text = forInput
    ? amountInputValue(abs, minorUnits)
    : formatAmount(abs, minorUnits)
  return (row.estimate ? '~' : '') + text
}

/** A typed budget mode: its label, the first character of it, or its code. */
export function parseMode(text: string): BudgetMode | null {
  const s = text.trim()
  if (!s) return null
  for (const [mode, label] of Object.entries(modeLabels)) {
    if (label.startsWith(s) || mode === s) return mode as BudgetMode
  }
  if ('全額'.startsWith(s)) return 'full'
  if ('攤提'.startsWith(s)) return 'spread'
  return null
}

/**
 * What typing `text` into a cell changes, or why it cannot (a message).
 * `today` is ISO; a rule typed on a line starts it at its first occurrence
 * from today, which is what 下次 shows (and can be typed over).
 */
export function schedulePatch(
  row: ScheduleRow,
  column: ScheduleColumn,
  text: string,
  ctx: Context,
  today: string,
): Partial<ScheduleRow> | string {
  const value = text.trim()
  switch (column) {
    case 'rule': {
      const parsed = parseRule(value)
      if ('error' in parsed) return parsed.error
      if (parsed.rule === row.rule && parsed.shift === row.shift) return {}
      const source = describeRRule(parsed.rule, parsed.shift) ?? value
      const first = nextOccurrences(
        parsed.rule,
        today,
        parsed.shift,
        today,
        1,
      ).at(0)
      if (!first) return '這個週期在今天之後沒有任何一期'
      return {
        source,
        rule: parsed.rule,
        shift: parsed.shift,
        start: first.nominal,
      }
    }
    case 'next': {
      const [y, m, d] = today.split('-').map(Number)
      const date = parseDate(value, new Date(y, m - 1, d))
      if (!date) return '看不懂這個日期：可以輸入 t、+3、5、12/5 或 2026-12-05'
      if (!row.rule) return '先輸入週期'
      if (nextOccurrences(row.rule, date, row.shift, date, 1).length === 0) {
        return '從這一天起，這個週期沒有任何一期'
      }
      return { start: date }
    }
    case 'payee': {
      if (value.startsWith('@')) {
        const name = value.slice(1).trim()
        const account = [...ctx.accounts.values()].find((a) => a.name === name)
        if (!account) return `找不到帳戶「${name}」`
        if (account.id === row.accountId) return '不能轉帳給同一個帳戶'
        const next = { ...row, transferTo: account.id, payee: '' }
        return {
          transferTo: account.id,
          payee: '',
          categoryId:
            lineCategoryMode(next.accountId, next.transferTo, ctx) === 'none'
              ? null
              : row.categoryId,
        }
      }
      const next = { ...row, transferTo: null }
      return {
        transferTo: null,
        payee: value,
        categoryId:
          lineCategoryMode(next.accountId, null, ctx) === 'none'
            ? null
            : row.categoryId,
      }
    }
    case 'note':
      return { note: value }
    case 'category': {
      if (!value) return { categoryId: null }
      if (lineCategoryMode(row.accountId, row.transferTo, ctx) === 'none') {
        return '這個排程不需要類別'
      }
      const found = findCategory(value, ctx.categories.values())
      if (!found) return `找不到類別「${value}」：請從清單選，或輸入完整路徑`
      return { categoryId: found.id }
    }
    case 'account': {
      const account = [...ctx.accounts.values()].find(
        (a) => a.name === value && !a.closed,
      )
      if (!account) return `找不到帳戶「${value}」`
      if (account.id === row.transferTo) return '不能轉帳給同一個帳戶'
      return {
        accountId: account.id,
        categoryId:
          lineCategoryMode(account.id, row.transferTo, ctx) === 'none'
            ? null
            : row.categoryId,
      }
    }
    case 'outflow':
    case 'inflow': {
      const estimate = value.startsWith('~') || value.startsWith('～')
      const amount = evalAmount(
        estimate ? value.slice(1) : value,
        ctx.minorUnits,
      )
      if (amount === null)
        return '金額格式不對：可以輸入 1280、~1,200（預估）或 120*3'
      if (amount !== 0) {
        return { amount: column === 'outflow' ? -amount : amount, estimate }
      }
      const clears =
        (column === 'outflow' && row.amount < 0) ||
        (column === 'inflow' && row.amount > 0)
      return clears ? { amount: 0, estimate: false } : {}
    }
    case 'mode': {
      const mode = parseMode(value)
      if (!mode) return '預算方式是：不納入、到期月全額、平均攤提'
      return { budgetMode: mode }
    }
  }
}

/** A line's rule in the one way rules are shown (ADR-084). */
export function ruleText(row: ScheduleRow): string {
  if (!row.rule) return row.source
  return describeRRule(row.rule, row.shift) ?? row.source
}

/** The text a cell editor starts with. */
export function scheduleCellText(
  row: ScheduleRow,
  column: ScheduleColumn,
  ctx: Context,
  nextShown: Occurrence | null,
): string {
  switch (column) {
    case 'rule':
      return ruleText(row)
    case 'next':
      return nextShown?.nominal ?? row.start
    case 'payee':
      return row.transferTo
        ? `@${ctx.accounts.get(row.transferTo)?.name ?? ''}`
        : row.payee
    case 'note':
      return row.note
    case 'category':
      return row.categoryId
        ? (ctx.categories.get(row.categoryId)?.path ?? '')
        : ''
    case 'account':
      return ctx.accounts.get(row.accountId)?.name ?? ''
    case 'outflow':
    case 'inflow':
      return scheduleAmountText(row, column, ctx.minorUnits, true)
    case 'mode':
      return modeLabels[row.budgetMode]
  }
}

/** The page column a server problem's field points at. */
export function scheduleProblemColumn(field: string): ScheduleColumn | null {
  if (field === 'amount') return 'outflow'
  if (field === 'date') return 'next'
  return (scheduleColumns as Array<string>).includes(field)
    ? (field as ScheduleColumn)
    : null
}
