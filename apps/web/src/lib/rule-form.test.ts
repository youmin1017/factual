// Run with: node --experimental-strip-types src/lib/rule-form.test.ts
import assert from 'node:assert/strict'
import {
  fieldText,
  formFields,
  formText,
  openRuleForm,
  ruleFormKey,
} from './rule-form.ts'
import type { RuleFormState } from './rule-form.ts'

const today = '2026-11-23' // a Monday

function open(text: string, start = today): RuleFormState {
  const s = openRuleForm(text, start, today)
  if (!s) throw new Error(`${text} does not open`)
  return s
}

/** Feeds keys; the state they leave, or what ended the editor. */
function keys(s: RuleFormState, ...ks: Array<string>) {
  for (const [i, k] of ks.entries()) {
    const r = ruleFormKey(s, k)
    if ('done' in r) {
      assert.equal(i, ks.length - 1, `${k} ended the editor early`)
      return r
    }
    s = r.state
  }
  return { state: s }
}

function state(r: ReturnType<typeof keys>): RuleFormState {
  if (!('state' in r)) throw new Error('the editor ended')
  return r.state
}

assert.equal(openRuleForm('下個月', today, today), null)

// /monthly: change the day by typing it, or with Ctrl-a / Ctrl-x.
let s = open('每月 23 日')
assert.deepEqual(formFields(s.form), [
  'freq',
  'interval',
  'monthBy',
  'day',
  'end',
  'shift',
])
assert.deepEqual(keys(s, 'j', 'j', 'j', '5', '<CR>'), {
  done: 'commit',
  text: '每月 5 日',
})
assert.deepEqual(keys(s, 'j', 'j', 'j', '<C-a>', '<C-a>', '<Esc>'), {
  done: 'commit',
  text: '每月 25 日',
})
// Two digits make one number; one past the largest starts over.
assert.equal(state(keys(s, 'G', 'k', 'k', '1', '5')).form.day, 15)
assert.equal(state(keys(s, 'j', 'j', 'j', '4', '5')).form.day, 5)
assert.equal(fieldText(state(keys(s, 'j', 'j', 'j', '1')), 'day'), '1 日')
// Stepping stays in range.
assert.equal(state(keys(s, 'j', 'j', 'j', '9', '<C-a>')).form.day, 10)
assert.equal(state(keys(s, 'j', 'j', 'j', '1', 'j', 'k', '<C-x>')).form.day, 1)

// The interval, the end and the holiday rule.
s = open('每月 5 日')
assert.deepEqual(keys(s, 'j', '3', '<CR>'), {
  done: 'commit',
  text: '每季 5 日',
})
assert.deepEqual(keys(s, 'j', '<C-a>', '<CR>'), {
  done: 'commit',
  text: '每 2 個月 5 日',
})
assert.deepEqual(keys(s, 'G', 'l', '<CR>'), {
  done: 'commit',
  text: '每月 5 日，遇假日延後',
})
assert.deepEqual(keys(s, 'G', 'h', '<CR>'), {
  done: 'commit',
  text: '每月 5 日，遇假日提前',
})
let r = state(keys(s, 'G', 'k', 'l'))
assert.equal(r.form.end, 'until')
assert.equal(r.form.until, '2027-11-23')
assert.deepEqual(
  keys(r, 'j', '2', '0', '2', '7', '/', '6', '/', '3', '0', '<CR>'),
  {
    done: 'commit',
    text: '每月 5 日，到 2027/6/30',
  },
)
assert.equal(state(keys(r, 'j', 'x', 'y')).form.until, '2027-11-23')
r = state(keys(r, 'j', '9', '9', '/', 'j'))
assert.match(r.error ?? '', /看不懂這個日期/)
assert.equal(r.field, 'until')
assert.deepEqual(keys(s, 'G', 'k', '3', 'j', '1', '2', '<CR>'), {
  done: 'commit',
  text: '每月 5 日，共 12 次',
})

// Monthly by weekday and on the last day.
s = open('每月 5 日')
assert.deepEqual(keys(s, 'j', 'j', 'l', '<CR>'), {
  done: 'commit',
  text: '每月最後一天',
})
assert.deepEqual(keys(s, 'j', 'j', '3', 'j', '2', 'j', '5', '<CR>'), {
  done: 'commit',
  text: '每月第 2 個週五',
})
// 2026-11-23 is the fourth Monday; l steps on to the fifth, then the last.
assert.deepEqual(keys(s, 'j', 'j', '3', '<CR>'), {
  done: 'commit',
  text: '每月第 4 個週一',
})
assert.deepEqual(keys(s, 'j', 'j', '3', 'j', 'l', 'l', '<CR>'), {
  done: 'commit',
  text: '每月最後一個週一',
})

// Weekly: toggle days with 1-7, or move along them with h/l and press x.
s = open('每週一')
assert.deepEqual(formFields(s.form), [
  'freq',
  'interval',
  'weekdays',
  'end',
  'shift',
])
assert.deepEqual(keys(s, 'j', 'j', '3', '5', '<CR>'), {
  done: 'commit',
  text: '每週一、三、五',
})
assert.deepEqual(keys(s, 'j', 'j', 'l', 'l', 'x', '1', '<CR>'), {
  done: 'commit',
  text: '每週三',
})
assert.equal(state(keys(s, 'j', 'j', '1')).error, '至少要選一天')
assert.equal(fieldText(state(keys(s, 'j', 'j', '5')), 'weekdays'), '一、五')

// Changing how often keeps what fits: weekly from a monthly rule.
s = open('每月 23 日')
assert.equal(formText(state(keys(s, 'h')).form), '每週一')
assert.equal(formText(state(keys(s, 'l')).form), '每年 11/23')
assert.equal(formText(state(keys(s, '1')).form), '每天')
// Yearly: a shorter month takes the day down.
s = open('每年 1/31')
assert.equal(formText(state(keys(s, 'j', 'j', '2')).form), '每年 2/29')

// i types the rule as text; / goes back to the templates; Ctrl-c drops it.
s = open('every 2 weeks on fri')
assert.deepEqual(keys(s, 'i'), { done: 'text', text: '每 2 週五' })
assert.deepEqual(keys(s, '/'), { done: 'text', text: '/' })
assert.deepEqual(keys(s, '<C-c>'), { done: 'cancel' })
// The start fills in what a rule leaves open.
assert.equal(formText(open('每週', '2026-11-27').form), '每週五')

console.log('rule-form: ok')
