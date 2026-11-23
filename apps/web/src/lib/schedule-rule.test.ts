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
