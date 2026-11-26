import { useEffect, useState } from 'react'
import { PeriodTable } from '#/components/loans/period-table'
import { Skeleton } from '#/components/ui/skeleton'
import { api } from '#/lib/api'
import { parseLoanFields } from '#/lib/loan'
import { formatAmount } from '#/lib/money'
import { formatDate } from '#/lib/register'
import type { LoanFieldValues, LoanPreview } from '#/lib/loan'

const ROW_HEIGHT = 32

/**
 * The end of a loan's terms on the accounts page (ADR-110): what they come
 * to, previewed on the server as they change (`POST .../loans/preview`),
 * with the table of every period's principal and interest, or what is
 * still missing. While the periods are being computed, skeletons hold
 * their place.
 */
export function LoanPreviewLine({
  budgetId,
  minorUnits,
  values,
}: {
  budgetId: string
  minorUnits: number
  values: LoanFieldValues
}) {
  /** The preview, and the terms it was computed for. */
  const [result, setResult] = useState<{
    key: string
    preview: LoanPreview | null
  } | null>(null)
  /** Terms whose preview has taken long enough to show skeletons for. */
  const [slowKey, setSlowKey] = useState<string | null>(null)
  const terms = parseLoanFields(values, minorUnits)
  const missing = 'field' in terms ? terms.message : null
  const key = missing ? '' : JSON.stringify(terms)

  useEffect(() => {
    const parsed = parseLoanFields(values, minorUnits)
    if ('field' in parsed) return
    const asked = JSON.stringify(parsed)
    // Set when the terms change again before the answer comes.
    const stale = { gone: false }
    // The terms change only when a cell is taken, so the preview is asked
    // at once; it takes a few milliseconds, and skeletons show only when
    // it takes longer than that.
    const slow = setTimeout(() => {
      if (!stale.gone) setSlowKey(asked)
    }, 150)
    void (async () => {
      try {
        const { data } = await api.POST('/budgets/{budgetId}/loans/preview', {
          params: { path: { budgetId } },
          body: parsed,
        })
        if (!stale.gone) setResult({ key: asked, preview: data ?? null })
      } catch {
        if (!stale.gone) setResult({ key: asked, preview: null })
      } finally {
        clearTimeout(slow)
      }
    })()
    return () => {
      stale.gone = true
      clearTimeout(slow)
    }
  }, [values, minorUnits, budgetId])

  const computing = !missing && result?.key !== key
  const skeleton = computing && slowKey === key
  // While a quick preview is on its way the last one stays, so nothing flashes.
  const preview = skeleton || missing ? null : (result?.preview ?? null)
  const money = (n: number) => formatAmount(n, minorUnits)
  const last = preview?.periods.at(-1)
  const now = new Date()
  // The next period to pay, marked and scrolled to in the table.
  const next = preview?.periods.findIndex((p) => p.state === 'planned')
  return (
    <>
      <div
        className="flex items-center border-b border-rule/60 bg-card/40 pl-[calc(28px+1.5rem)] text-xs text-muted-foreground"
        style={{ height: ROW_HEIGHT }}
        aria-busy={skeleton || undefined}
      >
        {missing ? (
          <span>還沒填完：{missing}</span>
        ) : skeleton ? (
          <span className="flex items-center gap-2" aria-label="計算中">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-20" />
          </span>
        ) : preview ? (
          <span>
            每月{' '}
            <span className="amount text-foreground">
              {money(preview.payment)}
            </span>
            {' · '}共 {preview.periods.length} 期 · 總利息{' '}
            <span className="amount">{money(preview.totalInterest)}</span>
            {last && ` · ${formatDate(last.date, now)} 還清`}
          </span>
        ) : computing ? null : (
          <span className="text-destructive">算不出還款表，請稍後再試</span>
        )}
      </div>
      {!missing && (skeleton || preview) && (
        <div className="border-b border-rule/60 bg-card/40 py-2 pr-4 pl-[calc(28px+1.5rem)]">
          {preview ? (
            <PeriodTable
              periods={preview.periods}
              minorUnits={minorUnits}
              now={now}
              next={
                next !== undefined && next >= 0
                  ? preview.periods[next].n
                  : undefined
              }
              className="max-h-56 max-w-3xl"
            />
          ) : (
            <TableSkeleton />
          )}
        </div>
      )}
    </>
  )
}

/** The period table's place while it is computed: its head and a few lines. */
function TableSkeleton() {
  const widths = ['w-6', 'w-20', 'w-12', 'w-16', 'w-14', 'w-16', 'w-20', 'w-10']
  return (
    <div
      aria-hidden
      className="max-h-56 max-w-3xl overflow-hidden rounded-md border border-rule"
    >
      {Array.from({ length: 7 }, (_, row) => (
        <div
          key={row}
          className="flex h-[25px] items-center justify-between gap-3 border-b border-rule/40 px-2 last:border-b-0"
        >
          {widths.map((w, i) => (
            <Skeleton
              key={i}
              className={`h-3 ${w} ${row === 0 ? 'opacity-60' : ''}`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Where a saved loan's terms go while they are read (skeleton lines in the
 * two columns), or why they could not be.
 */
export function LoanTermsPlaceholder({
  failed,
  onRetry,
}: {
  failed: boolean
  onRetry: () => void
}) {
  if (failed) {
    return (
      <div
        className="flex items-center gap-2 border-b border-rule/60 bg-card/40 pl-[calc(28px+1.5rem)] text-xs text-destructive"
        style={{ height: ROW_HEIGHT }}
        role="alert"
      >
        讀不到貸款條件
        <button
          type="button"
          onClick={onRetry}
          className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          再試一次
        </button>
      </div>
    )
  }
  return (
    <div aria-busy aria-label="讀取貸款條件">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          className="grid grid-cols-2 items-center gap-8 border-b border-rule/40 bg-card/40 pr-4 pl-[calc(28px+1.5rem)]"
          style={{ height: ROW_HEIGHT }}
        >
          {[0, 1].map((c) => (
            <div key={c} className="flex items-center gap-6">
              <Skeleton className="h-3 w-16 opacity-60" />
              <Skeleton className="h-3 w-28" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
