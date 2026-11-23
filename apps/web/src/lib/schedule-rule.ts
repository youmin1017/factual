/**
 * Schedule rules (ADR-084): the short Chinese a rule is typed in (`每月 5
 * 日`, `每 2 週五`, `每年 3/15 到 2030/3/15 遇假日延後`), the iCalendar RRULE
 * it is stored as, and the dates it gives, for previews. Only the RRULE
 * subset the parser writes is expanded here; the server expands rules with
 * rrule-go and is what posts. Pure, tested with plain node.
 *
 * Dates are ISO strings (yyyy-mm-dd) and day arithmetic is done in UTC, so
 * no time zone moves a day.
 */

export type HolidayShift = 'noShift' | 'nextWorkday' | 'prevWorkday'

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

/** A weekday, Monday 0 to Sunday 6, with its ordinal in the month (0 = every). */
interface ByDay {
  n: number
  day: number
}

export interface Rule {
  freq: Freq
  interval: number
  byDay: Array<ByDay>
  byMonthDay: Array<number>
  byMonth: Array<number>
  count: number | null
  /** Last possible date, inclusive. */
  until: string | null
}

export interface ParsedRule {
  rule: string
  shift: HolidayShift
}

const dayCodes = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const dayNames = '一二三四五六日'

// ---------- reading what is typed

/** Full-width digits, letters and marks to ASCII. */
function toAscii(text: string): string {
  return text.replaceAll(/[！-～]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  )
}

/** Full-width digits and marks to ASCII, the variants of 週 and 日 to one, no spaces. */
function normalize(text: string): string {
  return toAscii(text)
    .replaceAll(/星期|禮拜|礼拜|周/g, '週')
    .replaceAll(/[號号]/g, '日')
    .replaceAll(/\s+/g, '')
}

const zhDigits: Record<string, number> = {
  一: 1,
  二: 2,
  兩: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 12, 十二, 兩 → a number; null otherwise. */
function readNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s)
  if (s in zhDigits) return zhDigits[s]
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(s)
  if (m) return (m[1] ? zhDigits[m[1]] : 1) * 10 + (m[2] ? zhDigits[m[2]] : 0)
  return null
}

const NUM = '(\\d+|[一二兩两三四五六七八九十]+)'

function weekday(c: string): number {
  return c === '天' ? 6 : dayNames.indexOf(c)
}

/** The ISO date of a typed y/m/d, or null. */
function ymd(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1) return null
  return t.toISOString().slice(0, 10)
}

const examples =
  '例如：每月 5 日、每週一三五、每 2 週五、每季 10 日、每年 3/15，或 monthly on the 5th、every 2 weeks on fri'

/**
 * Reads a rule as typed. Returns the RRULE and how it moves off days off,
 * or a message saying what was not understood.
 */
export function parseRule(text: string): ParsedRule | { error: string } {
  const ascii = toAscii(text)
  if (/[a-z]/i.test(ascii)) return parseEnglish(ascii)
  let s = normalize(text)
  if (!s) return { error: `請輸入週期，${examples}` }
  const rule: Rule = {
    freq: 'MONTHLY',
    interval: 1,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    count: null,
    until: null,
  }
  let m: RegExpExecArray | null
  const take = (re: RegExp): RegExpExecArray | null => {
    const found = re.exec(s)
    if (found) s = s.slice(found[0].length)
    return found
  }
  const every = (n: string | undefined): number | null =>
    n === undefined ? 1 : readNumber(n)

  if ((m = take(new RegExp(`^每(?:${NUM}個?)?週`)))) {
    rule.freq = 'WEEKLY'
    const n = every(m[1])
    if (!n) return { error: `看不懂「${m[1]}」週` }
    rule.interval = n
    const days = take(/^[一二三四五六日天、,和]+/)
    for (const c of days?.[0] ?? '') {
      const d = weekday(c)
      if (d >= 0 && !rule.byDay.some((b) => b.day === d))
        rule.byDay.push({ n: 0, day: d })
    }
    rule.byDay.sort((a, b) => a.day - b.day)
  } else if ((m = take(new RegExp(`^每(?:${NUM}個?)?[天日]`)))) {
    rule.freq = 'DAILY'
    const n = every(m[1])
    if (!n) return { error: `看不懂「${m[1]}」天` }
    rule.interval = n
  } else if ((m = take(new RegExp(`^每(?:${NUM}個?)?月|^每(季)|^每(半年)`)))) {
    rule.freq = 'MONTHLY'
    const n = m[2] ? 3 : m[3] ? 6 : every(m[1])
    if (!n) return { error: `看不懂「${m[1]}」個月` }
    rule.interval = n
    if (take(/^(?:最後一天|月底|最後一日)/)) {
      rule.byMonthDay = [-1]
    } else if ((m = take(/^第(\d|[一二三四五])個?週([一二三四五六日天])/))) {
      rule.byDay = [{ n: readNumber(m[1]) ?? 1, day: weekday(m[2]) }]
    } else if ((m = take(/^最後一個?週([一二三四五六日天])/))) {
      rule.byDay = [{ n: -1, day: weekday(m[1]) }]
    } else if ((m = take(/^(\d{1,2})日?/))) {
      const d = Number(m[1])
      if (d < 1 || d > 31) return { error: '每月的日期是 1 到 31' }
      rule.byMonthDay = [d]
    }
  } else if ((m = take(new RegExp(`^每(?:${NUM}個?)?年`)))) {
    rule.freq = 'YEARLY'
    const n = every(m[1])
    if (!n) return { error: `看不懂「${m[1]}」年` }
    rule.interval = n
    if ((m = take(/^(\d{1,2})[/月.-](\d{1,2})日?/))) {
      const month = Number(m[1])
      const d = Number(m[2])
      if (!ymd(2024, month, d)) return { error: `沒有 ${month}/${d} 這一天` }
      rule.byMonth = [month]
      rule.byMonthDay = [d]
    }
  } else {
    return { error: `看不懂這個週期，${examples}` }
  }

  let shift: HolidayShift = 'noShift'
  while (s) {
    if (take(/^[，,、；;。]+/)) continue
    if (
      (m = take(/^(?:到|至|直到)(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?/))
    ) {
      const until = ymd(Number(m[1]), Number(m[2]), Number(m[3]))
      if (!until) return { error: '結束日期不存在' }
      rule.until = until
      continue
    }
    if ((m = take(new RegExp(`^共${NUM}次`)))) {
      const n = readNumber(m[1])
      if (!n) return { error: `看不懂「${m[1]}」次` }
      rule.count = n
      continue
    }
    if (take(/^遇?(?:假日|休假日|非工作日)(?:延後|順延|往後)/)) {
      shift = 'nextWorkday'
      continue
    }
    if (take(/^遇?(?:假日|休假日|非工作日)(?:提前|提早|往前)/)) {
      shift = 'prevWorkday'
      continue
    }
    return {
      error: `看不懂「${s}」：週期後面可以接「到 2027/6/30」「共 12 次」「遇假日延後」或「遇假日提前」`,
    }
  }
  return { rule: writeRRule(rule), shift }
}

// ---------- English

const enDays: Record<string, number> = {
  mo: 0,
  mon: 0,
  tu: 1,
  tue: 1,
  we: 2,
  wed: 2,
  th: 3,
  thu: 3,
  fr: 4,
  fri: 4,
  sa: 5,
  sat: 5,
  su: 6,
  sun: 6,
}
const DAY_WORD =
  'mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday|r)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|mo|tu|we|th|fr|sa|su'

/** mon, Monday, Mondays, thurs → 0..6. */
function dayOf(word: string): number | undefined {
  const days: Record<string, number | undefined> = enDays
  return days[word.slice(0, 3)] ?? days[word.slice(0, 2)]
}

const enMonths: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}
const MONTH_WORD =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'

const enOrdinals: Record<string, number> = {
  first: 1,
  '1st': 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  fourth: 4,
  '4th': 4,
  fifth: 5,
  '5th': 5,
  last: -1,
}

const enNumbers: Record<string, number> = {
  one: 1,
  two: 2,
  other: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
}
const EN_NUM =
  '(\\d+|one|two|other|three|four|five|six|seven|eight|nine|ten|eleven|twelve)'

function enNumber(s: string | undefined): number {
  if (s === undefined) return 1
  return /^\d+$/.test(s) ? Number(s) : (enNumbers[s] ?? 0)
}

/**
 * The same rules in English: `daily`, `every 3 days`, `weekly on mon, wed`,
 * `every 2 weeks on fri`, `every weekday`, `monthly on the 5th`, `every
 * month on the last day`, `monthly on the 2nd wed`, `quarterly on the 10th`,
 * `every 3 months on 10`, `yearly on 3/15` or `on march 15`; then `until
 * 2027/6/30`, `12 times`, `next workday` or `prev workday`.
 */
function parseEnglish(text: string): ParsedRule | { error: string } {
  let s = text.toLowerCase().replaceAll(/\s+/g, ' ').trim()
  const rule: Rule = {
    freq: 'MONTHLY',
    interval: 1,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    count: null,
    until: null,
  }
  const take = (re: RegExp): RegExpExecArray | null => {
    const found = re.exec(s)
    if (found) s = s.slice(found[0].length).trim()
    return found
  }
  /** The first of several patterns that matches. */
  const takeAny = (...res: Array<RegExp>): RegExpExecArray | null => {
    for (const re of res) {
      const found = take(re)
      if (found) return found
    }
    return null
  }
  const on = () => take(/^,?\s*(?:on\s+)?(?:the\s+)?/)
  const days = () => {
    const found = take(
      new RegExp(`^(?:(?:${DAY_WORD})s?\\b(?:\\s*(?:,|&|and)\\s*|\\s+)?)+`),
    )
    if (!found) return
    for (const w of found[0].split(/[\s,&]+/)) {
      if (!w || w === 'and') continue
      const d = dayOf(w)
      if (d !== undefined && !rule.byDay.some((b) => b.day === d))
        rule.byDay.push({ n: 0, day: d })
    }
    rule.byDay.sort((a, b) => a.day - b.day)
  }
  let m: RegExpExecArray | null

  if ((m = take(new RegExp(`^every\\s+${EN_NUM}\\s+days?\\b`)))) {
    rule.freq = 'DAILY'
    rule.interval = enNumber(m[1])
  } else if (take(/^(?:daily|every\s+day)\b/)) {
    rule.freq = 'DAILY'
  } else if (take(/^(?:every\s+weekdays?|weekdays)\b/)) {
    rule.freq = 'WEEKLY'
    rule.byDay = [0, 1, 2, 3, 4].map((day) => ({ n: 0, day }))
  } else if (
    (m = takeAny(
      new RegExp(`^every\\s+${EN_NUM}\\s+weeks?\\b`),
      /^(?:weekly|every\s+week)\b/,
      /^(?:biweekly|fortnightly)\b/,
    ))
  ) {
    rule.freq = 'WEEKLY'
    rule.interval = /^(?:biweekly|fortnightly)/.test(m[0]) ? 2 : enNumber(m[1])
    on()
    days()
  } else if (take(new RegExp(`^every\\s+(?=(?:${DAY_WORD})s?\\b)`))) {
    rule.freq = 'WEEKLY'
    days()
  } else if (
    (m = takeAny(
      new RegExp(`^every\\s+${EN_NUM}\\s+months?\\b`),
      /^(?:monthly|every\s+month)\b/,
      /^(?:quarterly|every\s+quarter)\b/,
      /^(?:semi-?annually|half-?yearly|every\s+half\s+year)\b/,
    ))
  ) {
    rule.freq = 'MONTHLY'
    rule.interval = /quarter/.test(m[0])
      ? 3
      : /semi|half/.test(m[0])
        ? 6
        : enNumber(m[1])
    on()
    if (take(/^(?:last\s+day|end(?:\s+of(?:\s+the)?\s+month)?)\b/)) {
      rule.byMonthDay = [-1]
    } else if (
      (m = take(
        new RegExp(
          `^(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\\s+(${DAY_WORD})\\b`,
        ),
      ))
    ) {
      rule.byDay = [{ n: enOrdinals[m[1]], day: dayOf(m[2]) ?? 0 }]
    } else if ((m = take(/^(?:day\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/))) {
      const d = Number(m[1])
      if (d < 1 || d > 31) return { error: '每月的日期是 1 到 31' }
      rule.byMonthDay = [d]
    }
  } else if (
    (m = takeAny(
      new RegExp(`^every\\s+${EN_NUM}\\s+years?\\b`),
      /^(?:yearly|annually|every\s+year)\b/,
    ))
  ) {
    rule.freq = 'YEARLY'
    rule.interval = enNumber(m[1])
    on()
    let month = 0
    let d = 0
    if ((m = take(/^(\d{1,2})[/.-](\d{1,2})\b/))) {
      month = Number(m[1])
      d = Number(m[2])
    } else if (
      (m = take(
        new RegExp(`^(${MONTH_WORD})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`),
      ))
    ) {
      month = enMonths[m[1].slice(0, 3)]
      d = Number(m[2])
    } else if (
      (m = take(
        new RegExp(
          `^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_WORD})\\b`,
        ),
      ))
    ) {
      month = enMonths[m[2].slice(0, 3)]
      d = Number(m[1])
    }
    if (month) {
      if (!ymd(2024, month, d)) return { error: `沒有 ${month}/${d} 這一天` }
      rule.byMonth = [month]
      rule.byMonthDay = [d]
    }
  } else {
    return { error: `看不懂這個週期，${examples}` }
  }
  if (rule.interval < 1) return { error: '看不懂間隔' }

  let shift: HolidayShift = 'noShift'
  const holiday =
    '(?:(?:if|on)\\s+(?:a\\s+)?(?:holiday|day\\s+off)s?\\s*,?\\s*)?(?:move\\s+)?(?:to\\s+)?(?:the\\s+)?'
  while (s) {
    if (take(/^[,;.]+/)) continue
    if (
      (m = take(
        /^(?:until|till|through|ending)\s+(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\b/,
      ))
    ) {
      const until = ymd(Number(m[1]), Number(m[2]), Number(m[3]))
      if (!until) return { error: '結束日期不存在' }
      rule.until = until
      continue
    }
    if ((m = take(new RegExp(`^(?:for\\s+)?${EN_NUM}\\s+times\\b`)))) {
      const n = enNumber(m[1])
      if (!n) return { error: '看不懂次數' }
      rule.count = n
      continue
    }
    if (
      take(
        new RegExp(
          `^${holiday}(?:next|following|later)\\s+(?:work|business|working)\\s*day\\b`,
        ),
      )
    ) {
      shift = 'nextWorkday'
      continue
    }
    if (
      take(
        new RegExp(
          `^${holiday}(?:prev|previous|preceding|earlier)\\s+(?:work|business|working)\\s*day\\b`,
        ),
      )
    ) {
      shift = 'prevWorkday'
      continue
    }
    return {
      error: `看不懂「${s}」：後面可以接 until 2027/6/30、12 times、next workday 或 prev workday`,
    }
  }
  return { rule: writeRRule(rule), shift }
}

// ---------- RRULE text

export function writeRRule(r: Rule): string {
  const parts = [`FREQ=${r.freq}`]
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`)
  if (r.byMonth.length) parts.push(`BYMONTH=${r.byMonth.join(',')}`)
  if (r.byMonthDay.length) parts.push(`BYMONTHDAY=${r.byMonthDay.join(',')}`)
  if (r.byDay.length) {
    parts.push(
      `BYDAY=${r.byDay.map((b) => `${b.n || ''}${dayCodes[b.day]}`).join(',')}`,
    )
  }
  if (r.count) parts.push(`COUNT=${r.count}`)
  if (r.until) parts.push(`UNTIL=${r.until.replaceAll('-', '')}`)
  return parts.join(';')
}

/** Reads the RRULE subset this module writes; null for anything else. */
export function readRRule(text: string): Rule | null {
  const r: Rule = {
    freq: 'MONTHLY',
    interval: 1,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    count: null,
    until: null,
  }
  let freq = false
  for (const part of text.split(';')) {
    const [key, value = ''] = part.split('=')
    const ints = () => value.split(',').map(Number)
    switch (key) {
      case 'FREQ':
        if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(value))
          return null
        r.freq = value as Freq
        freq = true
        break
      case 'INTERVAL':
        r.interval = Number(value)
        break
      case 'BYMONTH':
        r.byMonth = ints()
        break
      case 'BYMONTHDAY':
        r.byMonthDay = ints()
        break
      case 'BYDAY':
        for (const v of value.split(',')) {
          const m = /^(-?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(v)
          if (!m) return null
          r.byDay.push({
            n: m[1] ? Number(m[1]) : 0,
            day: dayCodes.indexOf(m[2]),
          })
        }
        break
      case 'COUNT':
        r.count = Number(value)
        break
      case 'UNTIL': {
        const m = /^(\d{4})(\d{2})(\d{2})/.exec(value)
        if (!m) return null
        r.until = `${m[1]}-${m[2]}-${m[3]}`
        break
      }
      default:
        return null
    }
  }
  const numbers = [r.interval, ...r.byMonth, ...r.byMonthDay]
  if (!freq || numbers.some((n) => !Number.isInteger(n))) return null
  return r
}

// ---------- dates the rule gives

const DAY = 86_400_000

function toDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / DAY
}

function toIso(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10)
}

/** Monday 0 to Sunday 6. */
function weekdayOf(day: number): number {
  return (new Date(day * DAY).getUTCDay() + 6) % 7
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
}

/** Whether `day` matches the rule anchored at `start` (both day numbers). */
function matches(r: Rule, start: number, day: number): boolean {
  const s = new Date(start * DAY)
  const t = new Date(day * DAY)
  const [sy, sm, sd] = [s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()]
  const [ty, tm, td] = [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()]
  const wd = weekdayOf(day)
  const monthDayOk = (days: Array<number>) =>
    days.some((v) => (v > 0 ? td === v : td === daysInMonth(ty, tm) + v + 1))
  switch (r.freq) {
    case 'DAILY':
      return (day - start) % r.interval === 0
    case 'WEEKLY': {
      // Weeks start on Monday (WKST=MO).
      const weeks = Math.floor((day - wd - (start - weekdayOf(start))) / 7)
      if (weeks % r.interval !== 0) return false
      return r.byDay.length
        ? r.byDay.some((b) => b.day === wd)
        : wd === weekdayOf(start)
    }
    case 'MONTHLY': {
      const months = (ty - sy) * 12 + (tm - sm)
      if (months % r.interval !== 0) return false
      if (r.byMonthDay.length) return monthDayOk(r.byMonthDay)
      if (r.byDay.length) {
        return r.byDay.some((b) => {
          if (b.day !== wd) return false
          if (b.n === 0) return true
          const nth =
            b.n > 0
              ? Math.floor((td - 1) / 7) + 1
              : -(Math.floor((daysInMonth(ty, tm) - td) / 7) + 1)
          return nth === b.n
        })
      }
      return td === sd
    }
    case 'YEARLY': {
      if ((ty - sy) % r.interval !== 0) return false
      const months = r.byMonth.length ? r.byMonth : [sm + 1]
      if (!months.includes(tm + 1)) return false
      return r.byMonthDay.length ? monthDayOk(r.byMonthDay) : td === sd
    }
  }
}

/**
 * The dates the rule gives from `start` on, those on or after `from`, at
 * most `limit` of them and none after `until` (when given).
 */
export function occurrences(
  rule: Rule,
  start: string,
  from: string,
  limit: number,
  until?: string,
): Array<string> {
  const first = toDay(start)
  const lowest = toDay(from)
  const last = Math.min(
    rule.until ? toDay(rule.until) : Infinity,
    until ? toDay(until) : Infinity,
    first + 366 * 30,
  )
  const out: Array<string> = []
  let n = 0
  for (let day = first; day <= last && out.length < limit; day++) {
    if (!matches(rule, first, day)) continue
    n++
    if (rule.count !== null && n > rule.count) break
    if (day >= lowest) out.push(toIso(day))
  }
  return out
}

/** A date moved off days off as the schedule says (ADR-087). */
export function shiftDate(
  iso: string,
  shift: HolidayShift,
  off: (iso: string) => boolean,
): string {
  if (shift === 'noShift') return iso
  const step = shift === 'nextWorkday' ? 1 : -1
  let day = toDay(iso)
  for (let i = 0; i < 31 && off(toIso(day)); i++) day += step
  return toIso(day)
}

/** The weekend rule, for years without an imported calendar. */
export function weekend(iso: string): boolean {
  return weekdayOf(toDay(iso)) >= 5
}

/**
 * Days off from the API's calendar (`GET /holidays`), which lists only the
 * days that differ from the weekend rule.
 */
export function daysOff(calendar: {
  days: Array<{ date: string; off: boolean }>
}): (iso: string) => boolean {
  const listed = new Map(calendar.days.map((d) => [d.date, d.off]))
  return (iso) => listed.get(iso) ?? weekend(iso)
}

export interface Occurrence {
  /** The date the rule gives. */
  nominal: string
  /** When it is posted, moved off days off. */
  date: string
}

/** The next `n` occurrences from `from` of a stored rule, or [] when it cannot be read. */
export function nextOccurrences(
  rruleText: string,
  start: string,
  shift: HolidayShift,
  from: string,
  n: number,
  off: (iso: string) => boolean = weekend,
): Array<Occurrence> {
  const rule = readRRule(rruleText)
  if (!rule) return []
  return occurrences(rule, start, from, n).map((nominal) => ({
    nominal,
    date: shiftDate(nominal, shift, off),
  }))
}

// ---------- the one way a rule is shown

/** Monday 0 to Sunday 6 of an ISO date. */
export function isoWeekday(iso: string): number {
  return weekdayOf(toDay(iso))
}

/** The ISO date `n` days after `iso`. */
export function addDays(iso: string, n: number): string {
  return toIso(toDay(iso) + n)
}

/** Days in a month (1 to 12) of a leap year, the most it can have. */
export function maxMonthDays(month: number): number {
  return daysInMonth(2024, month - 1)
}

function slashDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${y}/${m}/${d}`
}

/**
 * The text a rule is shown as (ADR-084), however it was typed: `每月 5 日`,
 * `每 2 週一、五`, `每年 3/15，到 2030/3/15，遇假日延後`. `parseRule` reads
 * every one of them back to the same rule.
 */
export function describeRule(r: Rule, shift: HolidayShift): string {
  const n = r.interval
  let text: string
  switch (r.freq) {
    case 'DAILY':
      text = n === 1 ? '每天' : `每 ${n} 天`
      break
    case 'WEEKLY':
      text =
        (n === 1 ? '每週' : `每 ${n} 週`) +
        r.byDay.map((b) => dayNames[b.day]).join('、')
      break
    case 'MONTHLY': {
      text =
        n === 1
          ? '每月'
          : n === 3
            ? '每季'
            : n === 6
              ? '每半年'
              : `每 ${n} 個月`
      const day = r.byMonthDay.at(0)
      const by = r.byDay.at(0)
      if (day === -1) text += '最後一天'
      else if (day !== undefined) text += ` ${day} 日`
      else if (by && by.n === -1) text += `最後一個週${dayNames[by.day]}`
      else if (by) text += `第 ${by.n || 1} 個週${dayNames[by.day]}`
      break
    }
    case 'YEARLY':
      text = n === 1 ? '每年' : `每 ${n} 年`
      if (r.byMonth.length && r.byMonthDay.length)
        text += ` ${r.byMonth[0]}/${r.byMonthDay[0]}`
      break
  }
  const parts = [text]
  if (r.until) parts.push(`到 ${slashDate(r.until)}`)
  if (r.count) parts.push(`共 ${r.count} 次`)
  if (shift === 'nextWorkday') parts.push('遇假日延後')
  if (shift === 'prevWorkday') parts.push('遇假日提前')
  return parts.join('，')
}

/** A stored rule as shown; null when it is not one this module reads. */
export function describeRRule(
  rruleText: string,
  shift: HolidayShift,
): string | null {
  const r = readRRule(rruleText)
  return r ? describeRule(r, shift) : null
}

// ---------- templates (`/` in the rule cell)

export interface RuleTemplate {
  /** What is typed after `/`: `每月`. */
  command: string
  /** The same in English: `monthly`, `every month`. */
  aliases: Array<string>
  /** The rule it starts from, for today's date, as rules are shown. */
  text: string
}

/**
 * The rules offered when the rule cell starts with `/`, filled in for
 * `today` (ISO): its weekday, day of the month and date. Each opens the
 * rule editor, where it is adjusted.
 */
export function ruleTemplates(today: string): Array<RuleTemplate> {
  const [, m, d] = today.split('-').map(Number)
  const wd = dayNames[isoWeekday(today)]
  return [
    {
      command: '每月',
      aliases: ['monthly', 'every month'],
      text: `每月 ${d} 日`,
    },
    { command: '每週', aliases: ['weekly', 'every week'], text: `每週${wd}` },
    { command: '每天', aliases: ['daily', 'every day'], text: '每天' },
    {
      command: '平日',
      aliases: ['weekdays', 'every weekday'],
      text: '每週一、二、三、四、五',
    },
    {
      command: '隔週',
      aliases: ['biweekly', 'every 2 weeks'],
      text: `每 2 週${wd}`,
    },
    {
      command: '月底',
      aliases: ['month-end', 'end of month'],
      text: '每月最後一天',
    },
    {
      command: '每季',
      aliases: ['quarterly', 'every 3 months'],
      text: `每季 ${d} 日`,
    },
    {
      command: '每年',
      aliases: ['yearly', 'every year'],
      text: `每年 ${m}/${d}`,
    },
  ]
}
