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
  /**
   * The text of a number or date field while it is edited, not yet taken;
   * null until a key edits it (the first digit then replaces the value).
   */
  typed: string | null
  /** Where the caret is in a number or date field's text. */
  caret: number
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
    caret: 0,
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

/** Whether the field is text with a caret: a number or the end date. */
export function isText(field: FieldKey): boolean {
  return ['interval', 'day', 'month', 'count', 'until'].includes(field)
}

/** The editable text of a number or date field. */
function valueText(form: RuleForm, field: FieldKey): string {
  switch (field) {
    case 'interval':
      return String(form.interval)
    case 'day':
      return String(form.day)
    case 'month':
      return String(form.month)
    case 'count':
      return String(form.count)
    case 'until':
      return form.until ? slashDate(form.until) : ''
    default:
      return ''
  }
}

export interface FieldParts {
  before: string
  /** The part the caret moves in. */
  text: string
  after: string
  /** Where the caret is in `text`; null when the field is not being edited. */
  caret: number | null
}

/** A field as shown: what is being typed shows as typed, with the caret. */
export function fieldParts(state: RuleFormState, field: FieldKey): FieldParts {
  const f = state.form
  const at = state.field === field
  const plain = (text: string): FieldParts => ({
    before: '',
    text,
    after: '',
    caret: null,
  })
  if (isText(field)) {
    const text = (at ? state.typed : null) ?? valueText(f, field)
    const caret = at ? Math.min(state.caret, text.length) : null
    const around: Partial<Record<FieldKey, [string, string]>> = {
      interval: ['每 ', ` ${unit[f.freq]}`],
      day: ['', ' 日'],
      month: ['', ' 月'],
      count: ['', ' 次'],
    }
    const [before, after] = around[field] ?? ['', '']
    return { before, text, after, caret }
  }
  switch (field) {
    case 'freq':
      return plain(labelOf(freqs, f.freq))
    case 'weekdays':
      return plain(f.weekdays.map((d) => dayNames[d]).join('、'))
    case 'monthBy':
      return plain(labelOf(monthBys, f.monthBy))
    case 'nth':
      return plain(labelOf(nths, f.nth))
    case 'weekday':
      return plain(labelOf(weekdayChoices, f.weekday))
    case 'end':
      return plain(labelOf(ends, f.end))
    default:
      return plain(labelOf(shifts, f.shift))
  }
}

/** The value a field shows, as one string. */
export function fieldText(state: RuleFormState, field: FieldKey): string {
  const p = fieldParts(state, field)
  return p.before + p.text + p.after
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

/** Puts the cursor on `field`, the caret at the end of its value. */
export function focusField(
  state: RuleFormState,
  field: FieldKey,
): RuleFormState {
  return {
    ...state,
    field,
    typed: null,
    caret: valueText(state.form, field).length,
    dayCursor: state.form.weekdays.at(0) ?? 0,
  }
}

/** Moves to another field, after taking what was typed. */
function moveTo(
  state: RuleFormState,
  pick: (fields: Array<FieldKey>, at: number) => FieldKey,
): RuleFormState {
  const s = take(state)
  if (s.error && s.typed !== null) return s
  const fields = formFields(s.form)
  return focusField(s, pick(fields, fields.indexOf(s.field)))
}

/** After a change, a field that is no longer shown gives way to the first. */
function settle(state: RuleFormState): RuleFormState {
  const form = state.form
  if (form.end === 'until' && !form.until) {
    state = { ...state, form: { ...form, until: addDays(state.today, 365) } }
  }
  const fields = formFields(state.form)
  return fields.includes(state.field) ? state : focusField(state, fields[0])
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

/** A number field's text after an edit, its value taken at once when it is one. */
function editNumber(
  state: RuleFormState,
  text: string,
  caret: number,
): RuleFormState {
  const field = state.field
  const [lo, hi] = numberRange[field]?.(state.form) ?? [1, 99]
  const n = Number(text)
  const form =
    text !== '' && Number.isInteger(n) && n >= lo && n <= hi
      ? setNumber(state.form, field, n)
      : state.form
  return { ...state, typed: text, caret, form, error: null }
}

/** The date `iso` moved by `step` years, months or days (`part` 0, 1, 2). */
function stepDate(iso: string, part: number, step: number): string {
  if (part === 2) return addDays(iso, step)
  const [y, m, d] = iso.split('-').map(Number)
  const months = y * 12 + (m - 1) + (part === 0 ? 12 * step : step)
  const ny = Math.floor(months / 12)
  const nm = (months % 12) + 1
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`
}

/** The runs of digits in `text`, as [start, end) pairs. */
function digitRuns(text: string): Array<[number, number]> {
  return [...text.matchAll(/\d+/g)].map((m) => [m.index, m.index + m[0].length])
}

/**
 * Ctrl-a / Ctrl-x in the end date: the year, month or day the caret is in
 * (as Vim changes the number under the cursor), the day when it is in none.
 */
function stepUntil(state: RuleFormState, step: number): RuleFormState {
  const text = state.typed ?? valueText(state.form, 'until')
  const runs = digitRuns(text)
  let part = 2
  if (runs.length === 3) {
    const found = runs.findIndex(
      ([a, b]) => state.caret >= a && state.caret <= b,
    )
    if (found >= 0) part = found
  }
  const s = take(state)
  if (s.error && s.typed !== null) return s
  const until = stepDate(s.form.until || s.today, part, step)
  const shown = slashDate(until)
  return {
    ...s,
    form: { ...s.form, until },
    typed: shown,
    caret: digitRuns(shown)[part][1],
    error: null,
  }
}

/** Keys that edit the text of a number or date field. */
function editText(state: RuleFormState, key: string): RuleFormResult | null {
  const field = state.field
  const date = field === 'until'
  const text = state.typed ?? valueText(state.form, field)
  const caret = Math.min(state.caret, text.length)
  const ok = (s: RuleFormState): RuleFormResult => ({ state: settle(s) })
  const edited = (next: string, at: number): RuleFormResult =>
    date
      ? ok({ ...state, typed: next, caret: at, error: null })
      : ok(editNumber(state, next, at))

  switch (key) {
    case 'h':
    case '<Left>':
      return ok({ ...state, typed: text, caret: Math.max(0, caret - 1) })
    case 'l':
    case '<Right>':
      return ok({
        ...state,
        typed: text,
        caret: Math.min(text.length, caret + 1),
      })
    case '^':
    case '<Home>':
      return ok({ ...state, typed: text, caret: 0 })
    case '$':
    case '<End>':
      return ok({ ...state, typed: text, caret: text.length })
    case '<BS>':
      if (caret === 0) return { state }
      return edited(text.slice(0, caret - 1) + text.slice(caret), caret - 1)
    case 'x':
    case '<Del>':
      if (caret >= text.length) return { state }
      return edited(text.slice(0, caret) + text.slice(caret + 1), caret)
    case '<C-a>':
    case '<C-x>': {
      const step = key === '<C-a>' ? 1 : -1
      if (date) return ok(stepUntil(state, step))
      const s = take(state)
      if (s.error && s.typed !== null) return { state: s }
      const form = stepNumber(s.form, field, step)
      const shown = valueText(form, field)
      return ok({
        ...s,
        form,
        typed: shown,
        caret: Math.min(caret, shown.length),
      })
    }
  }

  const typable = date ? /^[\d/.\-+t]$/ : /^\d$/
  if (!typable.test(key)) return null
  // Before any other key, typing replaces the value, as in a spreadsheet.
  if (state.typed === null) return edited(key, 1)
  const next = text.slice(0, caret) + key + text.slice(caret)
  if (!date) {
    const [, hi] = numberRange[field]?.(state.form) ?? [1, 99]
    // At the end, one past the largest starts over with the digit; in the
    // middle the digit is not taken.
    if (Number(next) > hi)
      return caret === text.length ? edited(key, 1) : { state }
  }
  return edited(next, caret + 1)
}

/** One key in the rule editor. */
export function ruleFormKey(state: RuleFormState, key: string): RuleFormResult {
  const field = state.field
  const ok = (s: RuleFormState): RuleFormResult => ({ state: settle(s) })
  const clean = { ...state, error: null }

  switch (key) {
    case 'j':
    case '<Down>':
    case '<Tab>':
    case '<C-n>':
      return ok(moveTo(state, (fs, i) => fs[Math.min(fs.length - 1, i + 1)]))
    case 'k':
    case '<Up>':
    case '<S-Tab>':
    case '<C-p>':
      return ok(moveTo(state, (fs, i) => fs[Math.max(0, i - 1)]))
    case 'g':
      return ok(moveTo(state, (fs) => fs[0]))
    case 'G':
      return ok(moveTo(state, (fs) => fs[fs.length - 1]))
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
  }

  if (isText(field)) return editText(state, key) ?? { state }

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

  // A choice: h/l and Ctrl-a/Ctrl-x step through it.
  const step = ['l', '<Right>', '<C-a>', '+'].includes(key)
    ? 1
    : ['h', '<Left>', '<C-x>', '-'].includes(key)
      ? -1
      : 0
  if (step !== 0) return ok({ ...clean, form: choose(state.form, field, step) })
  // A digit picks the choice by its place: 1 is the first.
  if (/^[1-9]$/.test(key))
    return ok({ ...clean, form: choose(state.form, field, 0, Number(key) - 1) })
  return { state }
}
