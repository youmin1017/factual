// Run with: node --experimental-strip-types src/lib/schedules.test.ts
import assert from 'node:assert/strict'
import {
  newScheduleRow,
  nextOf,
  parseMode,
  rowFromSchedule,
  ruleText,
  scheduleAmountText,
  scheduleCellText,
  scheduleFromRow,
  schedulePatch,
  scheduleStatus,
  toScheduleInput,
  validateSchedule,
} from './schedules.ts'
import type { Context } from './register.ts'
import type { Schedule, ScheduleRow } from './schedules.ts'

const ctx: Context = {
  accounts: new Map([
    ['bank', { id: 'bank', name: '台新', onBudget: true, closed: false }],
    ['card', { id: 'card', name: '玉山卡', onBudget: true, closed: false }],
    ['loan', { id: 'loan', name: '車貸', onBudget: false, closed: false }],
  ]),
  categories: new Map([
    [
      'food',
      {
        id: 'food',
        path: '飲食',
        name: '飲食',
        kind: 'expense',
        archived: false,
        isSystem: false,
      },
    ],
    [
      'fun',
      {
        id: 'fun',
        path: '娛樂/訂閱',
        name: '訂閱',
        kind: 'expense',
        archived: false,
        isSystem: false,
      },
    ],
  ]),
  minorUnits: 0,
}
const today = '2026-11-23'

function apply(
  row: ScheduleRow,
  col: Parameters<typeof schedulePatch>[1],
  text: string,
): ScheduleRow {
  const p = schedulePatch(row, col, text, ctx, today)
  if (typeof p === 'string') throw new Error(`${col} ${text}: ${p}`)
  return { ...row, ...p }
}

// A new line: typing a rule starts it at its first occurrence from today.
let row = newScheduleRow('s1', 'card')
assert.equal(scheduleStatus(row), 'new')
assert.deepEqual(validateSchedule(row, ctx), {
  field: 'rule',
  message: '請輸入週期，例如：每月 5 日',
})
row = apply(row, 'rule', ' 每月5號 假日順延 ')
// Kept the one way rules are shown.
assert.equal(row.source, '每月 5 日，遇假日延後')
assert.equal(row.rule, 'FREQ=MONTHLY;BYMONTHDAY=5')
assert.equal(row.shift, 'nextWorkday')
assert.equal(row.start, '2026-12-05')
// 2026-12-05 is a Saturday.
assert.deepEqual(nextOf(row, today), {
  nominal: '2026-12-05',
  date: '2026-12-07',
})
assert.equal(validateSchedule(row, ctx)?.field, 'outflow')

row = apply(row, 'payee', 'Netflix')
row = apply(row, 'outflow', '390')
assert.equal(row.amount, -390)
assert.equal(validateSchedule(row, ctx)?.field, 'category')
row = apply(row, 'category', '訂閱')
assert.equal(row.categoryId, 'fun')
assert.equal(validateSchedule(row, ctx), null)
assert.equal(row.budgetMode, 'full')

// An estimate is typed with ~ and shown with it.
row = apply(row, 'outflow', '~1,200')
assert.equal(row.amount, -1200)
assert.equal(row.estimate, true)
assert.equal(scheduleAmountText(row, 'outflow', 0), '~1,200')
assert.equal(scheduleAmountText(row, 'outflow', 0, true), '~1200')
assert.equal(scheduleAmountText(row, 'inflow', 0), '')
assert.equal(scheduleCellText(row, 'outflow', ctx, null), '~1200')

// The budget mode by label, its start, or its code.
assert.equal(parseMode('平均'), 'spread')
assert.equal(parseMode('攤'), 'spread')
assert.equal(parseMode('全'), 'full')
assert.equal(parseMode('不'), 'notBudgeted')
assert.equal(parseMode('spread'), 'spread')
assert.equal(parseMode('x'), null)
assert.equal(typeof schedulePatch(row, 'mode', 'x', ctx, today), 'string')

// 下次 sets the start; a date the rule does not give starts from there.
row = apply(row, 'next', '2027/1/5')
assert.equal(row.start, '2027-01-05')
assert.deepEqual(nextOf(row, today), {
  nominal: '2027-01-05',
  date: '2027-01-05',
})

// A transfer to a tracking account still needs a category; one between
// budget accounts has none.
row = apply(row, 'payee', '@車貸')
assert.equal(row.transferTo, 'loan')
assert.equal(row.categoryId, 'fun')
row = apply(row, 'payee', '@台新')
assert.equal(row.categoryId, null)
assert.equal(validateSchedule(row, ctx), null)
assert.equal(
  typeof schedulePatch(row, 'category', '飲食', ctx, today),
  'string',
)
assert.equal(
  typeof schedulePatch(row, 'payee', '@玉山卡', ctx, today),
  'string',
)
assert.equal(scheduleCellText(row, 'payee', ctx, null), '@台新')
assert.equal(toScheduleInput(row).payee, '')

// A saved schedule is clean until changed; the server's next is shown
// while its rule and start are untouched.
const saved: Schedule = {
  id: 's2',
  source: '每月 5 日',
  rule: 'FREQ=MONTHLY;BYMONTHDAY=5',
  start: '2026-11-05',
  holidayShift: 'noShift',
  payee: '房東',
  note: '',
  accountId: 'bank',
  transferAccountId: null,
  categoryId: 'food',
  amount: -12000,
  estimate: false,
  budgetMode: 'full',
  paused: false,
  nextOccurrence: '2027-01-05',
  nextDate: '2027-01-05',
  skips: ['2026-12-05'],
}
let s = rowFromSchedule(saved)
assert.equal(scheduleStatus(s), 'clean')
assert.deepEqual(nextOf(s, today), {
  nominal: '2027-01-05',
  date: '2027-01-05',
})
// Retyping the same rule, however written, changes nothing.
s = apply(s, 'rule', 'monthly on the 5th')
assert.equal(s.start, '2026-11-05')
assert.equal(scheduleStatus(s), 'clean')
// English is kept as rules are shown, too.
assert.equal(apply(s, 'rule', 'every 2 weeks on fri').source, '每 2 週五')
assert.equal(ruleText({ ...s, source: 'monthly on the 5th' }), '每月 5 日')
// A different rule starts again from today.
s = apply(s, 'rule', '每月 10 日')
assert.equal(s.start, '2026-12-10')
assert.deepEqual(nextOf(s, today), {
  nominal: '2026-12-10',
  date: '2026-12-10',
})
assert.equal(
  scheduleStatus({ ...rowFromSchedule(saved), deleted: true }),
  'deleted',
)
assert.equal(
  scheduleStatus({ ...rowFromSchedule(saved), paused: true }),
  'changed',
)

// Ended rules have no next.
assert.equal(
  nextOf(
    rowFromSchedule({ ...saved, nextOccurrence: null, nextDate: null }),
    today,
  ),
  null,
)
assert.equal(
  typeof schedulePatch(
    newScheduleRow('x', 'bank'),
    'rule',
    '每月 5 日 到 2020/1/1',
    ctx,
    today,
  ),
  'string',
)
assert.equal(
  typeof schedulePatch(newScheduleRow('x', 'bank'), 'next', '12/5', ctx, today),
  'string',
)

// :schedule on a register row: monthly on its day, from after it, never today.
{
  const { newRow } = await import('./register.ts')
  const paid = {
    ...newRow('t1', '2026-11-05', 'card'),
    payee: '健身房',
    categoryId: 'food',
    amount: -1500,
  }
  const made = scheduleFromRow(paid, 's9', '2026-11-23')
  assert.ok(typeof made !== 'string')
  assert.equal(made.input.source, '每月 5 日')
  assert.equal(made.input.rule, 'FREQ=MONTHLY;BYMONTHDAY=5')
  assert.equal(made.first, '2026-12-05')
  assert.equal(made.input.start, '2026-12-05')
  assert.equal(made.input.amount, -1500)
  assert.equal(made.input.budgetMode, 'full')
  // Entered today for today: the next one is next month's.
  const todays = scheduleFromRow(
    { ...paid, date: '2026-11-23' },
    's9',
    '2026-11-23',
  )
  assert.ok(typeof todays !== 'string')
  assert.equal(todays.first, '2026-12-23')
  // The 31st becomes the month's last day.
  const late = scheduleFromRow(
    { ...paid, date: '2026-10-31' },
    's9',
    '2026-11-23',
  )
  assert.ok(typeof late !== 'string')
  assert.equal(late.input.source, '每月最後一天')
  assert.equal(late.first, '2026-11-30')
  assert.equal(
    scheduleFromRow({ ...paid, amount: 0 }, 's9', '2026-11-23'),
    '金額是 0 的交易不能變成排程',
  )
}

// :installment N: the first stays on the row (with the remainder), the
// rest still to come become a counted schedule; past dates count as paid.
{
  const { newRow } = await import('./register.ts')
  const { installmentPlan } = await import('./schedules.ts')
  const laptop = {
    ...newRow('t2', '2026-11-15', 'card'),
    payee: 'Apple',
    categoryId: 'food',
    amount: -10000,
  }
  const plan = installmentPlan(laptop, 3, 's10', '2026-11-23')
  assert.ok(typeof plan !== 'string')
  assert.equal(plan.first, -3334)
  assert.equal(plan.each, -3333)
  assert.equal(plan.first + plan.each * 2, -10000)
  assert.equal(plan.left, 2)
  assert.equal(plan.past, 0)
  assert.equal(plan.input.source, '每月 15 日，共 2 次')
  assert.equal(plan.input.start, '2026-12-15')
  assert.equal(plan.input.amount, -3333)
  assert.equal(plan.input.budgetMode, 'full')
  assert.equal(plan.input.note, '分期（共 3 期）')
  // Bought in July in 12: August to November are past.
  const old = installmentPlan(
    { ...laptop, date: '2026-07-15', amount: -12000 },
    12,
    's11',
    '2026-11-23',
  )
  assert.ok(typeof old !== 'string')
  assert.equal(old.past, 4)
  assert.equal(old.left, 7)
  assert.equal(old.input.start, '2026-12-15')
  assert.equal(old.input.source, '每月 15 日，共 7 次')
  // The 31st: the month's last day.
  const late = installmentPlan(
    { ...laptop, date: '2026-10-31' },
    3,
    's12',
    '2026-11-23',
  )
  assert.ok(typeof late !== 'string')
  assert.equal(late.input.start, '2026-11-30')
  assert.equal(late.input.source, '每月最後一天，共 2 次')
  assert.equal(
    typeof installmentPlan(
      { ...laptop, date: '2025-01-15' },
      3,
      's',
      '2026-11-23',
    ),
    'string',
  )
  assert.equal(
    installmentPlan({ ...laptop, amount: 500 }, 3, 's', '2026-11-23'),
    '只有支出可以分期',
  )
  assert.equal(installmentPlan(laptop, 1, 's', '2026-11-23'), '期數是 2 到 120')
}

console.log('schedules: ok')
