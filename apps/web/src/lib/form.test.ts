// Run with: node --experimental-strip-types src/lib/form.test.ts
import assert from 'node:assert/strict'
import { formKey, openForm, settleForm } from './form.ts'
import type { Field, FormState } from './form.ts'

const today = new Date(2026, 10, 20)
const fields: Array<Field> = [
  {
    key: 'kind',
    label: '類型',
    type: 'choice',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C' },
    ],
  },
  { key: 'amount', label: '金額', type: 'amount' },
  { key: 'date', label: '日期', type: 'date' },
  { key: 'name', label: '名稱', type: 'text' },
]

function press(state: FormState, ...keys: Array<string>): FormState {
  let s = state
  for (const k of keys) {
    const r = formKey(s, fields, k, today)
    assert.ok('state' in r, `key ${k} ended the form`)
    s = r.state
  }
  return s
}

const start = openForm(
  { kind: 'a', amount: '100', date: '2026-11-05', name: '' },
  fields,
)
assert.equal(start.field, 'kind')

// Choices step with h/l (wrapping) and are picked by place.
assert.equal(press(start, 'l').values.kind, 'b')
assert.equal(press(start, 'h').values.kind, 'c')
assert.equal(press(start, '3').values.kind, 'c')

// j moves on; the first digit replaces the value, later ones are appended.
let s = press(start, 'j', '2', '5', '0')
assert.equal(s.field, 'amount')
assert.equal(s.typed, '250')
s = press(s, 'j')
assert.equal(s.values.amount, '250')
assert.equal(s.field, 'date')

// Dates are typed as the register types them, and Ctrl-a steps a day.
s = press(s, '1', '1', '/', '7', 'j')
assert.equal(s.values.date, '2026-11-07')
s = press(s, '<S-Tab>', '<C-a>')
assert.equal(s.values.date, '2026-11-08')
const bad = press(s, '9', '9', '/', '9', '9', 'j')
assert.equal(bad.field, 'date')
assert.ok(bad.error)

// In a text field letters are typed, so only Tab and arrows move.
s = press(s, 'j')
assert.equal(s.field, 'name')
s = press(s, 'j', 'k')
assert.equal(s.typed, 'jk')
const r = formKey(s, fields, '<CR>', today)
assert.ok('done' in r && r.done === 'commit')
assert.equal(r.state.values.name, 'jk')
const c = formKey(s, fields, '<C-c>', today)
assert.ok('done' in c && c.done === 'cancel')

// A field that goes away gives the cursor to the first.
assert.equal(settleForm({ ...start, field: 'gone' }, fields).field, 'kind')

console.log('form: ok')
