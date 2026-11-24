import { useEffect, useRef } from 'react'
import { Amount } from '#/components/amount'
import { payment, periodStates, rateText } from '#/lib/loan'
import { formatDate } from '#/lib/register'
import { cn } from '#/lib/utils'
import type { LoanPeriod } from '#/lib/loan'

/**
 * A loan's table as the bank's 還款明細 lays it out, one period a line;
 * `next` is marked and scrolled into view.
 */
export function PeriodTable({
  periods,
  minorUnits,
  now,
  next,
  className,
}: {
  periods: Array<LoanPeriod>
  minorUnits: number
  now: Date
  next?: number
  className?: string
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLTableRowElement>(null)
  // Only the table scrolls to the next period, never the page.
  useEffect(() => {
    const box = boxRef.current
    const row = nextRef.current
    if (box && row) box.scrollTop = row.offsetTop - box.clientHeight / 2
  }, [next])
  const head = 'px-2 py-1 text-right font-normal'
  const cell = 'px-2 py-1 text-right'
  return (
    <div
      ref={boxRef}
      className={cn(
        'relative overflow-auto rounded-md border border-rule',
        className,
      )}
    >
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
          <tr className="border-b border-rule">
            <th className="px-2 py-1 text-right font-normal">期</th>
            <th className="px-2 py-1 text-left font-normal">繳款日</th>
            <th className={head}>利率</th>
            <th className={head}>本金</th>
            <th className={head}>利息</th>
            <th className={head}>月付</th>
            <th className={head}>剩餘本金</th>
            <th className="px-2 py-1 text-left font-normal">狀態</th>
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => {
            const state = periodStates[p.state]
            const dim = p.state === 'before' || p.state === 'skipped'
            return (
              <tr
                key={p.n}
                ref={p.n === next ? nextRef : undefined}
                className={cn(
                  'border-b border-rule/50 last:border-0',
                  dim && 'text-muted-foreground',
                  p.n === next && 'bg-accent/40',
                )}
              >
                <td className="px-2 py-1 text-right font-mono">{p.n}</td>
                <td className="px-2 py-1 font-mono">
                  {formatDate(p.date, now)}
                </td>
                <td className="px-2 py-1 text-right font-mono">
                  {rateText(p.annualRate)}%
                </td>
                <td className={cell}>
                  <Amount value={p.principal} minorUnits={minorUnits} />
                </td>
                <td className={cell}>
                  <Amount value={p.interest} minorUnits={minorUnits} />
                </td>
                <td className={cell}>
                  <Amount value={payment(p)} minorUnits={minorUnits} />
                </td>
                <td className={cell}>
                  <Amount value={p.balance} minorUnits={minorUnits} />
                </td>
                <td className={cn('px-2 py-1', state.tone)}>{state.label}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
