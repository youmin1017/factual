import { isoDate, parseDate } from './register.ts'

// A small form edited from the keyboard, opened under a grid cell for a
// value with parts (ADR-107): the fields one per line, j/k (Tab) between
// them, h/l through a choice, digits typed over a number as in a
// spreadsheet, Enter to take it, Ctrl-c to leave it. The rule editor of the
// schedules page (ADR-084) works the same way. Pure: the page decides which
// fields a value has and what the values mean.

export interface Option {
  value: string
  label: string
}

interface FieldBase {
  key: string
  label: string
}

export type Field =
  | (FieldBase & { type: 'choice'; options: Array<Option> })
  | (FieldBase & {
      /** amount: a number or a sum (1200*3); date: ISO, typed as 11/5, t, -1. */
      type: 'amount' | 'number' | 'date' | 'text'
      suffix?: string
      placeholder?: string
    })

export interface FormState {
  /** Every value as text; a choice's is its option's value, a date's ISO. */
  values: Record<string, string>
  field: string
  /** What is being typed into a text field, not yet taken; null until a key edits it. */
  typed: string | null
  caret: number
  error: string | null
}

export type FormResult =
  | { state: FormState }
  /** Enter or Esc: the values, with what was being typed taken. */
  | { done: 'commit'; state: FormState }
  | { done: 'cancel' }

export function isTyped(field: Field): boolean {
  return field.type !== 'choice'
}

/** A value as the field shows it. */
export function shownValue(field: Field, value: string): string {
  if (field.type === 'choice')
    return field.options.find((o) => o.value === value)?.label ?? ''
  if (field.type === 'date') return value.replaceAll('-', '/')
  return value
}

export function openForm(
  values: Record<string, string>,
  fields: Array<Field>,
  at?: string,
): FormState {
  const field = fields.find((f) => f.key === at) ?? fields[0]
  return {
    values,
    field: field.key,
    typed: null,
    caret: shownValue(field, values[field.key] ?? '').length,
    error: null,
  }
}

/** Puts the cursor on another field, the caret at the end of its value. */
export function focusField(
  state: FormState,
  fields: Array<Field>,
  key: string,
): FormState {
  const field = fields.find((f) => f.key === key)
  if (!field) return state
  return {
    ...state,
    field: key,
    typed: null,
    caret: shownValue(field, state.values[key] ?? '').length,
  }
}

/** Takes what was typed into the current field; a date it cannot read is an error. */
export function takeTyped(
  state: FormState,
  fields: Array<Field>,
  today: Date,
): FormState {
  const field = fields.find((f) => f.key === state.field)
  if (!field || state.typed === null) return state
  let value = state.typed.trim()
  if (field.type === 'date' && value !== '') {
    const iso = parseDate(value, today)
    if (!iso)
      return { ...state, error: '看不懂這個日期：可以輸入 11/5、5、t 或 -1' }
    value = iso
  }
  return {
    ...state,
    values: { ...state.values, [field.key]: value },
    typed: null,
    error: null,
  }
}

/** Picks a choice's option: by a step from the current one, or by its place. */
export function choose(
  state: FormState,
  field: Field,
  step: number,
  index?: number,
): FormState {
  if (field.type !== 'choice' || field.options.length === 0) return state
  const at = field.options.findIndex((o) => o.value === state.values[field.key])
  const n = field.options.length
  const next =
    index !== undefined
      ? Math.min(index, n - 1)
      : ((((at < 0 ? 0 : at) + step) % n) + n) % n
  return {
    ...state,
    values: { ...state.values, [field.key]: field.options[next].value },
    error: null,
  }
}

const typable: Record<'amount' | 'number' | 'date', RegExp> = {
  amount: /^[\d.,+\-*/()]$/,
  number: /^[\d.]$/,
  date: /^[\d/.\-+tT]$/,
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return isoDate(new Date(y, m - 1, d + n))
}

/** Keys that edit the text of a typed field, or null for keys it does not use. */
function editText(
  state: FormState,
  field: Field & { type: 'amount' | 'number' | 'date' | 'text' },
  key: string,
  today: Date,
): FormState | null {
  const text = state.typed ?? shownValue(field, state.values[field.key] ?? '')
  const caret = Math.min(state.caret, text.length)
  const edited = (next: string, at: number): FormState => ({
    ...state,
    typed: next,
    caret: at,
    error: null,
  })
  // Letters are typed into a text field; the others have no use for them.
  const plain = field.type !== 'text'
  switch (key) {
    case '<Left>':
      return { ...state, typed: text, caret: Math.max(0, caret - 1) }
    case '<Right>':
      return { ...state, typed: text, caret: Math.min(text.length, caret + 1) }
    case '<Home>':
      return { ...state, typed: text, caret: 0 }
    case '<End>':
      return { ...state, typed: text, caret: text.length }
    case '<BS>':
      return caret === 0
        ? state
        : edited(text.slice(0, caret - 1) + text.slice(caret), caret - 1)
    case '<Del>':
      return caret >= text.length
        ? state
        : edited(text.slice(0, caret) + text.slice(caret + 1), caret)
    case '<C-u>':
      return edited('', 0)
  }
  if (plain) {
    switch (key) {
      case 'h':
        return { ...state, typed: text, caret: Math.max(0, caret - 1) }
      case 'l':
        return {
          ...state,
          typed: text,
          caret: Math.min(text.length, caret + 1),
        }
      case 'x':
        return caret >= text.length
          ? state
          : edited(text.slice(0, caret) + text.slice(caret + 1), caret)
      case '<C-a>':
      case '<C-x>': {
        const step = key === '<C-a>' ? 1 : -1
        if (field.type === 'date') {
          const base = state.values[field.key] || isoDate(today)
          const next = addDays(base, step)
          const shown = shownValue(field, next)
          return {
            ...state,
            values: { ...state.values, [field.key]: next },
            typed: null,
            caret: shown.length,
            error: null,
          }
        }
        const n = Number(text.replaceAll(',', ''))
        if (!Number.isFinite(n)) return state
        const shown = String(Math.max(0, n + step))
        return edited(shown, shown.length)
      }
    }
    if (!typable[field.type as keyof typeof typable].test(key)) return null
  } else if ([...key].length !== 1) {
    return null
  }
  // Before any other key, typing replaces the value, as in a spreadsheet.
  if (state.typed === null) return edited(key, 1)
  return edited(text.slice(0, caret) + key + text.slice(caret), caret + 1)
}

/**
 * One key in a form. `fields` are the fields its values have now: after a
 * change the caller works them out again, and a field no longer there gives
 * way to the first.
 */
export function formKey(
  state: FormState,
  fields: Array<Field>,
  key: string,
  today: Date,
): FormResult {
  const field = fields.find((f) => f.key === state.field) ?? fields[0]
  const text = field.type === 'text'
  const move = (step: number | 'first' | 'last'): FormResult => {
    const s = takeTyped(state, fields, today)
    if (s.error) return { state: s }
    const at = fields.findIndex((f) => f.key === field.key)
    const next =
      step === 'first'
        ? 0
        : step === 'last'
          ? fields.length - 1
          : Math.max(0, Math.min(fields.length - 1, at + step))
    return { state: focusField(s, fields, fields[next].key) }
  }

  switch (key) {
    case '<Tab>':
    case '<Down>':
    case '<C-n>':
      return move(1)
    case '<S-Tab>':
    case '<Up>':
    case '<C-p>':
      return move(-1)
    case '<CR>':
    case '<Esc>': {
      const s = takeTyped(state, fields, today)
      return s.error ? { state: s } : { done: 'commit', state: s }
    }
    case '<C-c>':
      return { done: 'cancel' }
  }
  if (!text) {
    switch (key) {
      case 'j':
        return move(1)
      case 'k':
        return move(-1)
      case 'g':
        return move('first')
      case 'G':
        return move('last')
    }
  }

  if (field.type !== 'choice') {
    return { state: editText(state, field, key, today) ?? state }
  }
  const step = ['l', '<Right>', '<C-a>', ' ', '<Space>'].includes(key)
    ? 1
    : ['h', '<Left>', '<C-x>'].includes(key)
      ? -1
      : 0
  if (step !== 0) return { state: choose(state, field, step) }
  if (/^[1-9]$/.test(key))
    return { state: choose(state, field, 0, Number(key) - 1) }
  return { state }
}

/** After the fields changed, the cursor stays on a field that is still there. */
export function settleForm(state: FormState, fields: Array<Field>): FormState {
  return fields.some((f) => f.key === state.field)
    ? state
    : focusField(state, fields, fields[0].key)
}
