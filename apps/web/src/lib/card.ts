/**
 * A credit card's register and its statements (ADR-088): which statement a
 * row is billed in, and what `:defer` moves. Pure, tested with plain node.
 */
import { formatDate } from './register.ts'
import type { Schemas } from './api'
import type { Row } from './register.ts'

export type CardStatements = Schemas['CardStatements']

/** The statement the row's entries on its account are billed in, if any. */
export function rowStatement(row: Row): string | null {
  return (
    row.base?.entries.find(
      (e) => e.accountId === row.accountId && e.statementId,
    )?.statementId ?? null
  )
}

/** Where a saved row of the card is billed, for the status line. */
export function billingText(
  row: Row,
  data: CardStatements,
  now: Date,
): string | null {
  if (!row.base || row.planned || row.base.isOpening) return null
  const latest = data.statements.at(0)
  const id = rowStatement(row)
  if (id) {
    const st = data.statements.find((s) => s.id === id)
    if (!st) return null
    const closing = formatDate(st.periodEnd, now)
    return st.id === latest?.id
      ? `列在 ${closing} 結帳的帳單（:defer 移到下一期）`
      : `列在 ${closing} 結帳的帳單`
  }
  const next = data.open ? formatDate(data.open.periodEnd, now) : null
  const when = next ? `${next} 結帳時列入` : '下次結帳時列入'
  if (latest && row.date <= latest.periodEnd) {
    return `還沒列入帳單，${when}（:defer 放回 ${formatDate(latest.periodEnd, now)} 那期）`
  }
  return `本期消費，${when}`
}

/**
 * `:defer` on rows of the card: those billed in the latest statement leave
 * it (the next closing bills them); otherwise unbilled ones dated up to its
 * closing day go back in. A message when there is nothing to move.
 */
export function deferPlan(
  rows: Array<Row>,
  cardId: string,
  data: CardStatements,
): { billed: boolean; ids: Array<string> } | string {
  const latest = data.statements.at(0)
  if (!latest) return '這張卡還沒有結過帳，本期的消費結帳時才會列入'
  const mine = rows.filter(
    (r) => r.base && !r.planned && !r.base.isOpening && r.accountId === cardId,
  )
  if (mine.length === 0) return '這裡沒有已儲存的刷卡交易'
  const unique = (list: Array<Row>) => [...new Set(list.map((r) => r.id))]
  const inLatest = mine.filter((r) => rowStatement(r) === latest.id)
  if (inLatest.length > 0) return { billed: false, ids: unique(inLatest) }
  const back = mine.filter(
    (r) => !rowStatement(r) && (r.base?.date ?? r.date) <= latest.periodEnd,
  )
  if (back.length > 0) return { billed: true, ids: unique(back) }
  return '只能調整最近一期帳單：把那期的交易移到下一期，或把還沒列入、日期在結帳日以前的放回去'
}
