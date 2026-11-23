// Run with: node --experimental-strip-types src/lib/schedule-rule.test.ts
import assert from 'node:assert/strict'
import {
  daysOff,
  nextOccurrences,
  occurrences,
  parseRule,
  readRRule,
  shiftDate,
} from './schedule-rule.ts'

function rule(text: string): string {
  const r = parseRule(text)
  if ('error' in r) throw new Error(`${text}: ${r.error}`)
  return r.rule
}

function shiftOf(text: string): string {
  const r = parseRule(text)
  if ('error' in r) throw new Error(`${text}: ${r.error}`)
  return r.shift
}

// What is typed becomes an RRULE.
const written: Array<[string, string]> = [
  ['每天', 'FREQ=DAILY'],
  ['每 3 天', 'FREQ=DAILY;INTERVAL=3'],
  ['每週一', 'FREQ=WEEKLY;BYDAY=MO'],
  ['每週一三五', 'FREQ=WEEKLY;BYDAY=MO,WE,FR'],
  ['每星期日', 'FREQ=WEEKLY;BYDAY=SU'],
  ['每 2 週五', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR'],
  ['每兩週五', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR'],
  ['每月 5 日', 'FREQ=MONTHLY;BYMONTHDAY=5'],
  ['每月5號', 'FREQ=MONTHLY;BYMONTHDAY=5'],
  ['每月２５日', 'FREQ=MONTHLY;BYMONTHDAY=25'],
  ['每月最後一天', 'FREQ=MONTHLY;BYMONTHDAY=-1'],
  ['每月第 2 個週三', 'FREQ=MONTHLY;BYDAY=2WE'],
  ['每月最後一個週五', 'FREQ=MONTHLY;BYDAY=-1FR'],
  ['每 3 個月 10 日', 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10'],
  ['每季 10 日', 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10'],
  ['每半年 1 日', 'FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=1'],
  ['每年 3/15', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15'],
  ['每年 3 月 15 日', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15'],
  ['每十二個月', 'FREQ=MONTHLY;INTERVAL=12'],
  ['每月 5 日 到 2027/6/30', 'FREQ=MONTHLY;BYMONTHDAY=5;UNTIL=20270630'],
  ['每月 5 日，共 12 次', 'FREQ=MONTHLY;BYMONTHDAY=5;COUNT=12'],
]
for (const [text, want] of written) assert.equal(rule(text), want, text)

assert.equal(shiftOf('每月 5 日'), 'noShift')
assert.equal(shiftOf('每月 5 日 遇假日延後'), 'nextWorkday')
assert.equal(shiftOf('每月 5 日 假日順延'), 'nextWorkday')
assert.equal(shiftOf('每月 1 日 遇假日提前'), 'prevWorkday')

for (const text of [
  '',
  '每',
  '下個月',
  '每月 32 日',
  '每年 2/30',
  '每月 5 日 下雨天',
  '每月 5 日 到 2027/2/30',
]) {
  assert.ok('error' in parseRule(text), `${text} should not parse`)
}

// The same rules in English (any case; full-width letters too).
const english: Array<[string, string]> = [
  ['daily', 'FREQ=DAILY'],
  ['Every day', 'FREQ=DAILY'],
  ['every 3 days', 'FREQ=DAILY;INTERVAL=3'],
  ['weekly', 'FREQ=WEEKLY'],
  ['weekly on mon', 'FREQ=WEEKLY;BYDAY=MO'],
  ['every Monday', 'FREQ=WEEKLY;BYDAY=MO'],
  ['every mon, wed and fri', 'FREQ=WEEKLY;BYDAY=MO,WE,FR'],
  ['every Tuesdays & Thursdays', 'FREQ=WEEKLY;BYDAY=TU,TH'],
  ['every weekday', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
  ['every 2 weeks on fri', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR'],
  ['every other week on friday', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR'],
  ['biweekly fri', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR'],
  ['monthly', 'FREQ=MONTHLY'],
  ['monthly on the 5th', 'FREQ=MONTHLY;BYMONTHDAY=5'],
  ['every month on 25', 'FREQ=MONTHLY;BYMONTHDAY=25'],
  ['monthly on day 1', 'FREQ=MONTHLY;BYMONTHDAY=1'],
  ['every month on the last day', 'FREQ=MONTHLY;BYMONTHDAY=-1'],
  ['monthly, end of month', 'FREQ=MONTHLY;BYMONTHDAY=-1'],
  ['monthly on the 2nd wed', 'FREQ=MONTHLY;BYDAY=2WE'],
  ['every month on the last friday', 'FREQ=MONTHLY;BYDAY=-1FR'],
  ['every 3 months on the 10th', 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10'],
  ['quarterly on 10', 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10'],
  ['semiannually on the 1st', 'FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=1'],
  ['yearly on 3/15', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15'],
  ['annually on March 15th', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15'],
  ['every year on 15 mar', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15'],
  ['every 2 years on dec 1', 'FREQ=YEARLY;INTERVAL=2;BYMONTH=12;BYMONTHDAY=1'],
  [
    'monthly on the 5th until 2027/6/30',
    'FREQ=MONTHLY;BYMONTHDAY=5;UNTIL=20270630',
  ],
  ['monthly on the 5th, 12 times', 'FREQ=MONTHLY;BYMONTHDAY=5;COUNT=12'],
  ['ｍｏｎｔｈｌｙ ｏｎ ５', 'FREQ=MONTHLY;BYMONTHDAY=5'],
]
for (const [text, want] of english) assert.equal(rule(text), want, text)
assert.equal(shiftOf('monthly on the 5th, next workday'), 'nextWorkday')
assert.equal(
  shiftOf('monthly on 5 if holiday, next business day'),
  'nextWorkday',
)
assert.equal(shiftOf('monthly on 1 prev workday'), 'prevWorkday')
assert.equal(shiftOf('monthly on 1, previous business day'), 'prevWorkday')
for (const text of [
  'every',
  'sometimes',
  'monthly on 32',
  'yearly on feb 30',
  'monthly on 5 when it rains',
  'every zero days',
]) {
  assert.ok('error' in parseRule(text), `${text} should not parse`)
}

// RRULEs read back.
for (const [, r] of written) {
  const back = readRRule(r)
  assert.ok(back, r)
}
assert.equal(readRRule('FREQ=HOURLY'), null)
assert.equal(readRRule('FREQ=MONTHLY;BYSETPOS=1'), null)

function dates(
  text: string,
  start: string,
  from: string,
  n = 4,
): Array<string> {
  const r = readRRule(rule(text))
  assert.ok(r)
  return occurrences(r, start, from, n)
}

// The dates rules give (2026-11-23 is a Monday).
assert.deepEqual(dates('每月 5 日', '2026-11-23', '2026-11-23', 3), [
  '2026-12-05',
  '2027-01-05',
  '2027-02-05',
])
assert.deepEqual(dates('每月最後一天', '2027-01-01', '2027-01-01', 3), [
  '2027-01-31',
  '2027-02-28',
  '2027-03-31',
])
// RFC 5545: months without a 31st are skipped.
assert.deepEqual(dates('每月 31 日', '2027-01-01', '2027-01-01', 3), [
  '2027-01-31',
  '2027-03-31',
  '2027-05-31',
])
assert.deepEqual(dates('每週一三五', '2026-11-23', '2026-11-23', 4), [
  '2026-11-23',
  '2026-11-25',
  '2026-11-27',
  '2026-11-30',
])
// Every other week counts weeks from the start's.
assert.deepEqual(dates('每 2 週五', '2026-11-23', '2026-11-23', 3), [
  '2026-11-27',
  '2026-12-11',
  '2026-12-25',
])
assert.deepEqual(dates('每月第 2 個週三', '2026-11-01', '2026-11-01', 2), [
  '2026-11-11',
  '2026-12-09',
])
assert.deepEqual(dates('每月最後一個週五', '2026-11-01', '2026-11-01', 2), [
  '2026-11-27',
  '2026-12-25',
])
assert.deepEqual(dates('每季 10 日', '2026-11-10', '2026-11-01', 3), [
  '2026-11-10',
  '2027-02-10',
  '2027-05-10',
])
assert.deepEqual(dates('每年 3/15', '2026-11-23', '2026-11-23', 2), [
  '2027-03-15',
  '2028-03-15',
])
assert.deepEqual(dates('每 3 天', '2026-11-23', '2026-11-25', 2), [
  '2026-11-26',
  '2026-11-29',
])
// Without a day, the start's.
assert.deepEqual(dates('每月', '2026-11-23', '2026-11-23', 2), [
  '2026-11-23',
  '2026-12-23',
])
// COUNT counts from the start; UNTIL is inclusive.
assert.deepEqual(dates('每月 5 日 共 3 次', '2026-11-01', '2026-12-01', 5), [
  '2026-12-05',
  '2027-01-05',
])
assert.deepEqual(
  dates('每月 5 日 到 2027/1/5', '2026-11-01', '2026-11-01', 5),
  ['2026-11-05', '2026-12-05', '2027-01-05'],
)

// Moving off days off: 2026-12-05 is a Saturday; 2027-02-09 and 02-10
// are 補假 in the government's calendar.
const off = daysOff({
  days: [
    { date: '2027-02-09', off: true },
    { date: '2027-02-10', off: true },
  ],
})
assert.equal(shiftDate('2026-12-05', 'nextWorkday', off), '2026-12-07')
assert.equal(shiftDate('2026-12-05', 'prevWorkday', off), '2026-12-04')
assert.equal(shiftDate('2026-12-05', 'noShift', off), '2026-12-05')
assert.equal(shiftDate('2027-02-09', 'nextWorkday', off), '2027-02-11')
assert.deepEqual(
  nextOccurrences(
    'FREQ=MONTHLY;BYMONTHDAY=9',
    '2027-01-09',
    'nextWorkday',
    '2027-02-01',
    1,
    off,
  ),
  [{ nominal: '2027-02-09', date: '2027-02-11' }],
)
assert.deepEqual(
  nextOccurrences('nonsense', '2027-01-09', 'noShift', '2027-02-01', 1),
  [],
)

console.log('schedule-rule: ok')

// Every rule is shown one way, and that text reads back to the same rule.
{
  const { describeRRule } = await import('./schedule-rule.ts')
  const shown: Array<[string, string]> = [
    ['every day', '每天'],
    ['每3天', '每 3 天'],
    ['every mon, wed and fri', '每週一、三、五'],
    ['biweekly fri', '每 2 週五'],
    ['monthly on the 5th', '每月 5 日'],
    ['每月5號 假日順延', '每月 5 日，遇假日延後'],
    ['every month on the last day', '每月最後一天'],
    ['每月第2個週三', '每月第 2 個週三'],
    ['monthly on the last fri', '每月最後一個週五'],
    ['quarterly on the 10th', '每季 10 日'],
    ['每半年 1 日', '每半年 1 日'],
    ['every 2 months on the 3rd', '每 2 個月 3 日'],
    ['yearly on mar 15', '每年 3/15'],
    ['every 2 years on 3/15', '每 2 年 3/15'],
    ['每月', '每月'],
    ['每週', '每週'],
    [
      'monthly on the 5th until 2027-06-30, prev workday',
      '每月 5 日，到 2027/6/30，遇假日提前',
    ],
    ['每月 5 日 共 12 次', '每月 5 日，共 12 次'],
  ]
  for (const [typed, want] of shown) {
    const r = parseRule(typed)
    if ('error' in r) throw new Error(`${typed}: ${r.error}`)
    assert.equal(describeRRule(r.rule, r.shift), want, typed)
    const back = parseRule(want)
    assert.deepEqual(back, r, `${want} reads back`)
  }
}
console.log('schedule-rule shown: ok')

// Templates: filled in for today, each a rule shown as rules are.
{
  const { ruleTemplates } = await import('./schedule-rule.ts')
  const list = ruleTemplates('2026-11-23') // a Monday
  const byCommand = new Map(list.map((t) => [t.command, t.text]))
  assert.equal(byCommand.get('每月'), '每月 23 日')
  assert.equal(byCommand.get('每週'), '每週一')
  assert.equal(byCommand.get('平日'), '每週一、二、三、四、五')
  assert.equal(byCommand.get('每年'), '每年 11/23')
  assert.ok(list.find((t) => t.command === '每月')?.aliases.includes('monthly'))
  for (const today of [
    '2026-11-23',
    '2027-01-01',
    '2027-02-11',
    '2027-03-12',
    '2027-05-31',
  ]) {
    for (const t of ruleTemplates(today)) {
      const r = parseRule(t.text)
      assert.ok(!('error' in r), `${t.command}: ${t.text}`)
    }
  }
}
console.log('schedule-rule templates: ok')
