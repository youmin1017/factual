/**
 * The rule editor (ADR-084): a schedule's rule as a short form of fields,
 * moved through with j/k and changed with h/l, Ctrl-a/Ctrl-x or digits, as
 * a Vim user edits numbers. It is opened from a `/` template or on a rule
 * already written, and writes the rule back as `describeRule` shows it.
 * Pure, tested with plain node.
 */
import { parseDate } from './register.ts'
import {
  addDays,
  describeRule,
  isoWeekday,
  maxMonthDays,
  parseRule,
  readRRule,
} from './schedule-rule.ts'
import type { Freq, HolidayShift, Rule } from './schedule-rule.ts'

export type MonthBy = 'day' | 'last' | 'weekday'
export type RuleEnd = 'never' | 'until' | 'count'

export interface RuleForm {
  freq: Freq
  interval: number
  /** Weekly: the days, Monday 0 to Sunday 6, at least one. */
  weekdays: Array<number>
  /** Monthly: on a day, on the last day, or on the nth weekday. */
  monthBy: MonthBy
  /** Monthly and yearly: the day of the month. */
  day: number
  /** Monthly by weekday: 1 to 5, or -1 for the last. */
  nth: number
  weekday: number
  /** Yearly: 1 to 12. */
  month: number
  end: RuleEnd
  /** ISO; used when `end` is `until`. */
  until: string
  count: number
  shift: HolidayShift
}

export type FieldKey =
  | 'freq'
  | 'interval'
  | 'weekdays'
  | 'monthBy'
  | 'day'
  | 'nth'
  | 'weekday'
  | 'month'
  | 'end'
  | 'until'
  | 'count'
  | 'shift'

export interface RuleFormState {
  form: RuleForm
  field: FieldKey
  /** In the weekdays field: the day the cursor is on. */
  dayCursor: number
  /** What is being typed into a number or date field, not yet taken. */
  typed: string | null
  /** The date fields count from (today), for defaults and typed dates. */
  today: string
  error: string | null
}

export type RuleFormResult =
  | { state: RuleFormState }
  /** Enter or Esc: write the rule (shown as `describeRule` writes it). */
  | { done: 'commit'; text: string }
  | { done: 'cancel' }
  /** `i`: type the rule as text instead, starting from `text`. */
  | { done: 'text'; text: string }

const dayNames = '一二三四五六日'

interface Choice<T> {
  value: T
  label: string
}

const freqs: Array<Choice<Freq>> = [
  { value: 'DAILY', label: '每天' },
  { value: 'WEEKLY', label: '每週' },
  { value: 'MONTHLY', label: '每月' },
  { value: 'YEARLY', label: '每年' },
]
const monthBys: Array<Choice<MonthBy>> = [
  { value: 'day', label: '某一天' },
  { value: 'last', label: '最後一天' },
  { value: 'weekday', label: '第幾個星期幾' },
]
const nths: Array<Choice<number>> = [
  ...[1, 2, 3, 4, 5].map((n) => ({ value: n, label: `第 ${n} 個` })),
  { value: -1, label: '最後一個' },
]
const weekdayChoices: Array<Choice<number>> = [...dayNames].map((c, i) => ({
  value: i,
  label: `週${c}`,
}))
const ends: Array<Choice<RuleEnd>> = [
  { value: 'never', label: '不結束' },
  { value: 'until', label: '到某一天' },
  { value: 'count', label: '共幾次' },
]
const shifts: Array<Choice<HolidayShift>> = [
  { value: 'noShift', label: '照原日期' },
  { value: 'nextWorkday', label: '延到下一個工作日' },
  { value: 'prevWorkday', label: '提前到上一個工作日' },
]

const unit: Record<Freq, string> = {
  DAILY: '天',
  WEEKLY: '週',
  MONTHLY: '個月',
  YEARLY: '年',
}

export const fieldLabels: Record<FieldKey, string> = {
  freq: '頻率',
  interval: '間隔',
  weekdays: '星期',
  monthBy: '哪一天',
  day: '日',
  nth: '第幾個',
  weekday: '星期',
  month: '月',
  end: '結束',
  until: '到',
  count: '次數',
  shift: '遇假日',
}

/** The fields the form shows, in order, for what it is set to. */
export function formFields(form: RuleForm): Array<FieldKey> {
  const fields: Array<FieldKey> = ['freq', 'interval']
  if (form.freq === 'WEEKLY') fields.push('weekdays')
  if (form.freq === 'MONTHLY') {
    fields.push('monthBy')
    if (form.monthBy === 'day') fields.push('day')
    if (form.monthBy === 'weekday') fields.push('nth', 'weekday')
  }
  if (form.freq === 'YEARLY') fields.push('month', 'day')
  fields.push('end')
  if (form.end === 'until') fields.push('until')
  if (form.end === 'count') fields.push('count')
  fields.push('shift')
  return fields
}

/** A rule as the form edits it; what the rule leaves open comes from `start`. */
export function formFromRule(
  rule: Rule,
  shift: HolidayShift,
  start: string,
): RuleForm {
  const [, m, d] = start.split('-').map(Number)
  const wd = isoWeekday(start)
  const form: RuleForm = {
    freq: rule.freq,
    interval: rule.interval,
    weekdays: rule.byDay.filter((b) => b.n === 0).map((b) => b.day),
    monthBy: 'day',
    day: d,
    nth: Math.min(Math.floor((d - 1) / 7) + 1, 5),
    weekday: wd,
    month: m,
    end: rule.count ? 'count' : rule.until ? 'until' : 'never',
    until: rule.until ?? '',
    count: rule.count ?? 12,
    shift,
  }
  if (form.weekdays.length === 0) form.weekdays = [wd]
  const day = rule.byMonthDay.at(0)
  const by = rule.byDay.at(0)
  if (rule.freq === 'MONTHLY') {
    if (day === -1) form.monthBy = 'last'
    else if (day !== undefined) form.day = day
    else if (by) {
      form.monthBy = 'weekday'
      form.nth = by.n || 1
      form.weekday = by.day
    }
  }
  if (rule.freq === 'YEARLY') {
    form.month = rule.byMonth.at(0) ?? m
    form.day = day !== undefined && day > 0 ? day : d
  }
  return form
}

export function ruleOfForm(form: RuleForm): Rule {
  const rule: Rule = {
    freq: form.freq,
    interval: form.interval,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    count: form.end === 'count' ? form.count : null,
    until: form.end === 'until' && form.until ? form.until : null,
  }
  switch (form.freq) {
    case 'WEEKLY':
      rule.byDay = [...form.weekdays]
        .sort((a, b) => a - b)
        .map((day) => ({ n: 0, day }))
      break
    case 'MONTHLY':
      if (form.monthBy === 'day') rule.byMonthDay = [Math.min(form.day, 31)]
      if (form.monthBy === 'last') rule.byMonthDay = [-1]
      if (form.monthBy === 'weekday')
        rule.byDay = [{ n: form.nth, day: form.weekday }]
      break
    case 'YEARLY':
      rule.byMonth = [form.month]
      rule.byMonthDay = [Math.min(form.day, maxMonthDays(form.month))]
      break
  }
  return rule
}

/** The rule the form gives, as rules are shown. */
export function formText(form: RuleForm): string {
  return describeRule(ruleOfForm(form), form.shift)
}

/**
 * The editor opened on rule text (a template or a rule already written);
 * null when the text is not a rule. `start` fills in what the rule leaves
 * open (the weekday of `每週`).
 */
export function openRuleForm(
  text: string,
  start: string,
  today: string,
): RuleFormState | null {
  const parsed = parseRule(text)
  if ('error' in parsed) return null
  const rule = readRRule(parsed.rule)
  if (!rule) return null
  return {
    form: formFromRule(rule, parsed.shift, start || today),
    field: 'freq',
    dayCursor: 0,
    typed: null,
    today,
    error: null,
  }
}

// ---------- what each field shows

function labelOf<T>(choices: Array<Choice<T>>, value: T): string {
  return choices.find((c) => c.value === value)?.label ?? ''
}

function slashDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${y}/${m}/${d}`
}

/** The value a field shows; what is being typed shows as typed. */
export function fieldText(state: RuleFormState, field: FieldKey): string {
  const f = state.form
  const typed = state.field === field ? state.typed : null
  switch (field) {
    case 'freq':
      return labelOf(freqs, f.freq)
    case 'interval':
      return `每 ${typed ?? f.interval} ${unit[f.freq]}`
    case 'weekdays':
      return f.weekdays.map((d) => dayNames[d]).join('、')
    case 'monthBy':
      return labelOf(monthBys, f.monthBy)
    case 'day':
      return `${typed ?? f.day} 日`
    case 'nth':
      return labelOf(nths, f.nth)
    case 'weekday':
      return labelOf(weekdayChoices, f.weekday)
    case 'month':
      return `${typed ?? f.month} 月`
    case 'end':
      return labelOf(ends, f.end)
    case 'until':
      return typed ?? (f.until ? slashDate(f.until) : '')
    case 'count':
      return `${typed ?? f.count} 次`
    case 'shift':
      return labelOf(shifts, f.shift)
  }
}

/** Whether h/l step through choices (shown with ‹ ›). */
export function isChoice(field: FieldKey): boolean {
  return ['freq', 'monthBy', 'nth', 'weekday', 'end', 'shift'].includes(field)
}

export const weekdayLabels = [...dayNames]

// ---------- keys

const numberRange: Partial<
  Record<FieldKey, (f: RuleForm) => [number, number]>
> = {
  interval: () => [1, 99],
  day: (f) => [1, f.freq === 'YEARLY' ? maxMonthDays(f.month) : 31],
  month: () => [1, 12],
  count: () => [1, 999],
}

function cycle<T>(choices: Array<Choice<T>>, value: T, step: number): T {
  const i = choices.findIndex((c) => c.value === value)
  const n = choices.length
  return choices[(((i + step) % n) + n) % n].value
}

/** A choice field stepped by `step`, or set to its `index`th choice (0-based). */
function choose(
  form: RuleForm,
  field: FieldKey,
  step: number,
  index?: number,
): RuleForm {
  const pick = <T>(choices: Array<Choice<T>>, value: T): T =>
    index === undefined
      ? cycle(choices, value, step)
      : (choices.at(index)?.value ?? value)
  switch (field) {
    case 'freq':
      return { ...form, freq: pick(freqs, form.freq) }
    case 'monthBy':
      return { ...form, monthBy: pick(monthBys, form.monthBy) }
    case 'nth':
      return { ...form, nth: pick(nths, form.nth) }
    case 'weekday':
      return { ...form, weekday: pick(weekdayChoices, form.weekday) }
    case 'end': {
      const end = pick(ends, form.end)
      return { ...form, end }
    }
    case 'shift':
      return { ...form, shift: pick(shifts, form.shift) }
    default:
      return form
  }
}

function setNumber(form: RuleForm, field: FieldKey, n: number): RuleForm {
  const next = { ...form, [field]: n }
  // A shorter month takes the day down with it.
  if (field === 'month') next.day = Math.min(next.day, maxMonthDays(next.month))
  return next
}

function stepNumber(form: RuleForm, field: FieldKey, step: number): RuleForm {
  const range = numberRange[field]?.(form)
  if (!range) return form
  const [lo, hi] = range
  const value = form[field as 'interval'] + step
  return setNumber(form, field, Math.max(lo, Math.min(hi, value)))
}

/** Takes what was typed into the field; an error when it is not a value. */
function take(state: RuleFormState): RuleFormState {
  if (state.typed === null) return state
  const s = { ...state, typed: null }
  if (state.field === 'until') {
    const [y, m, d] = state.today.split('-').map(Number)
    const date = parseDate(state.typed, new Date(y, m - 1, d))
    if (!date)
      return {
        ...state,
        error: '看不懂這個日期：可以輸入 12/31、2027/6/30 或 +90',
      }
    return { ...s, form: { ...s.form, until: date }, error: null }
  }
  const range = numberRange[state.field]?.(state.form)
  const n = Number(state.typed)
  if (!range || state.typed === '') return s
  if (!Number.isInteger(n) || n < range[0] || n > range[1]) {
    return {
      ...state,
      error: `${fieldLabels[state.field]}是 ${range[0]} 到 ${range[1]}`,
    }
  }
  return { ...s, form: setNumber(s.form, s.field, n), error: null }
}

/** Moves `step` fields, after taking what was typed. */
function move(state: RuleFormState, step: number): RuleFormState {
  const s = take(state)
  if (s.error && s.typed !== null) return s
  const fields = formFields(s.form)
  const i = fields.indexOf(s.field)
  const field = fields[Math.max(0, Math.min(fields.length - 1, i + step))]
  return { ...s, field, dayCursor: s.form.weekdays.at(0) ?? 0 }
}

/** After a change, a field that is no longer shown gives way to the one before. */
function settle(state: RuleFormState): RuleFormState {
  const form = state.form
  if (form.end === 'until' && !form.until) {
    state = { ...state, form: { ...form, until: addDays(state.today, 365) } }
  }
  const fields = formFields(state.form)
  return fields.includes(state.field) ? state : { ...state, field: fields[0] }
}

function toggleDay(state: RuleFormState, day: number): RuleFormState {
  const days = state.form.weekdays
  if (days.includes(day)) {
    if (days.length === 1) return { ...state, error: '至少要選一天' }
    return {
      ...state,
      dayCursor: day,
      error: null,
      form: { ...state.form, weekdays: days.filter((d) => d !== day) },
    }
  }
  return {
    ...state,
    dayCursor: day,
    error: null,
    form: {
      ...state.form,
      weekdays: [...days, day].sort((a, b) => a - b),
    },
  }
}

/** One key in the rule editor. */
export function ruleFormKey(state: RuleFormState, key: string): RuleFormResult {
  const field = state.field
  const ok = (s: RuleFormState): RuleFormResult => ({ state: settle(s) })
  const clean = { ...state, error: null }
  const typing = numberRange[field] !== undefined || field === 'until'

  switch (key) {
    case 'j':
    case '<Down>':
    case '<Tab>':
    case '<C-n>':
      return ok(move(state, 1))
    case 'k':
    case '<Up>':
    case '<S-Tab>':
    case '<C-p>':
      return ok(move(state, -1))
    case 'g':
      return ok({ ...take(state), field: 'freq' })
    case 'G': {
      const fields = formFields(state.form)
      return ok({ ...take(state), field: fields[fields.length - 1] })
    }
    case '<CR>':
    case '<Esc>': {
      const s = take(state)
      if (s.typed !== null && s.error) return { state: s }
      return { done: 'commit', text: formText(s.form) }
    }
    case '<C-c>':
      return { done: 'cancel' }
    case 'i':
    case 'a':
    case 'c':
    case 's':
      return { done: 'text', text: formText(take(state).form) }
    case '/':
      // In a date, `/` is typed (2027/6/30).
      if (field !== 'until') return { done: 'text', text: '/' }
      break
    case '<BS>':
      if (state.typed === null) return { state }
      return ok({ ...clean, typed: state.typed.slice(0, -1) })
  }

  const step =
    key === 'l' || key === '<Right>' || key === '<C-a>' || key === '+'
      ? 1
      : key === 'h' || key === '<Left>' || key === '<C-x>' || key === '-'
        ? -1
        : 0

  if (field === 'weekdays') {
    if (key === 'h' || key === '<Left>')
      return ok({ ...clean, dayCursor: (state.dayCursor + 6) % 7 })
    if (key === 'l' || key === '<Right>')
      return ok({ ...clean, dayCursor: (state.dayCursor + 1) % 7 })
    if ([' ', '<Space>', 'x', '<C-a>', '<C-x>'].includes(key))
      return ok(toggleDay(state, state.dayCursor))
    if (/^[1-7]$/.test(key)) return ok(toggleDay(state, Number(key) - 1))
    return { state }
  }

  if (field === 'until') {
    if (step !== 0 && key !== '+' && key !== '-' && state.typed === null) {
      const from = state.form.until || state.today
      return ok({
        ...clean,
        form: { ...state.form, until: addDays(from, step) },
      })
    }
    if (/^[\d/.\-+t]$/.test(key)) {
      return ok({ ...clean, typed: (state.typed ?? '') + key })
    }
    return { state }
  }

  if (isChoice(field)) {
    if (step !== 0)
      return ok({ ...clean, form: choose(state.form, field, step) })
    // A digit picks the choice by its place: 1 is the first.
    if (/^[1-9]$/.test(key))
      return ok({
        ...clean,
        form: choose(state.form, field, 0, Number(key) - 1),
      })
    return { state }
  }

  if (typing) {
    if (step !== 0) {
      const s = take(state)
      if (s.typed !== null) return { state: s }
      return ok({ ...s, error: null, form: stepNumber(s.form, field, step) })
    }
    if (/^\d$/.test(key)) {
      // Digits build the number; one past the largest starts over.
      const [, hi] = numberRange[field]?.(state.form) ?? [1, 99]
      const joined = (state.typed ?? '') + key
      const typed = Number(joined) > hi ? key : joined
      const n = Number(typed)
      const form =
        n >= 1 && n <= hi ? setNumber(state.form, field, n) : state.form
      return ok({ ...clean, typed, form })
    }
  }
  return { state }
}
