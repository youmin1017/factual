import {
  keepPreviousData,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Check, ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Amount } from '#/components/amount'
import { BudgetGrid } from '#/components/budget/budget-grid'
import { useCategoryApi } from '#/components/budget/category-api'
import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import { Switch } from '#/components/ui/switch'
import { api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import {
  accountsQuery,
  budgetMonthQuery,
  categoriesQuery,
  schedulesQuery,
  summaryQuery,
  upcomingQuery,
} from '#/lib/budget'
import {
  budgetLines,
  isMonth,
  monthLabel,
  monthOf,
  monthTotals,
  pageMonths,
  shiftMonth,
  targetTotal,
} from '#/lib/budget-month'
import { useKeymap } from '#/lib/preferences'
import { describeRRule } from '#/lib/schedule-rule'
import { cn } from '#/lib/utils'
import type { Allocation } from '#/components/budget/budget-grid'

interface BudgetSearch {
  month?: string
}

// The budget page (M6): what each envelope got in a month, what was spent,
// and what is left, with the pool everything comes from (ADR-025, ADR-026);
// the categories are edited here too (ADR-079), and one to three months
// can be shown side by side (ADR-081).
export const Route = createFileRoute('/_app/b/$budgetId/')({
  staticData: { crumb: '預算', wide: true },
  validateSearch: (search: Record<string, unknown>): BudgetSearch => ({
    month: isMonth(search.month) ? search.month : undefined,
  }),
  component: BudgetPage,
})

const COUNT_KEY = 'factual:budget-months'

/** How many months this viewer chose to see (kept in this browser only). */
function storedCount(): number {
  try {
    const n = Number(localStorage.getItem(COUNT_KEY))
    return n >= 1 && n <= 3 ? n : 1
  } catch {
    return 1
  }
}

/**
 * How many months fit beside the names in the space the page has: each
 * needs about 13.5rem for its three columns.
 */
function useFit(ref: React.RefObject<HTMLElement | null>): number {
  const [fit, setFit] = useState(3)
  useEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const rem =
      parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width / rem
      setFit(Math.max(1, Math.min(3, Math.floor((width - 10) / 13.5))))
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [ref])
  return fit
}

function BudgetPage() {
  const { budget } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const queryClient = useQueryClient()
  const thisMonth = monthOf(new Date())
  const first = search.month ?? thisMonth
  const rootRef = useRef<HTMLDivElement>(null)
  const [chosen, setChosen] = useState(storedCount)
  const fit = useFit(rootRef)
  const count = Math.min(chosen, fit)
  const shownMonths = Array.from({ length: count }, (_, i) =>
    shiftMonth(first, i),
  )

  const categories = useQuery(categoriesQuery(budget.id))
  const accounts = useQuery(accountsQuery(budget.id))
  const summary = useQuery(summaryQuery(budget.id))
  // Names for the schedules in a target's parts, and what is coming up.
  const schedules = useQuery(schedulesQuery(budget.id))
  const upcoming = useQuery(upcomingQuery(budget.id))
  const monthData = useQueries({
    queries: shownMonths.map((m) => ({
      ...budgetMonthQuery(budget.id, m),
      // The months on screen stay while the next ones load.
      placeholderData: keepPreviousData,
    })),
  })
  const keymap = useKeymap()
  const categoryApi = useCategoryApi(budget.id)
  const [showArchived, setShowArchived] = useState(false)

  function choose(n: number) {
    setChosen(n)
    try {
      localStorage.setItem(COUNT_KEY, String(n))
    } catch {
      // Not kept; the page still shows what was chosen.
    }
  }

  const failed = [categories, accounts, summary, ...monthData].find(
    (q) => q.isError,
  )
  if (failed) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {apiErrorMessage(failed.error)}
      </p>
    )
  }
  const loaded = monthData.flatMap((q) => (q.data ? [q.data] : []))
  if (
    !categories.data ||
    !accounts.data ||
    !summary.data ||
    loaded.length < count
  ) {
    return (
      <p ref={rootRef} className="text-sm text-muted-foreground">
        載入中…
      </p>
    )
  }

  const months = pageMonths(categories.data, loaded, { showArchived })
  const shown = loaded[0].month
  const last = loaded[loaded.length - 1].month
  const totals = monthTotals(months[0].lines)
  const anyArchived = categories.data.some((c) => c.archived)
  const s = summary.data
  const balanced = s.onBudgetBalance === s.pool + s.envelopeBalance
  // Card spending already left its envelope; the money waits in the bank
  // for the payment (ADR-028).
  const cards = accounts.data.filter(
    (a) => a.kind === 'credit_card' && !a.closed && a.balance < 0,
  )
  const mu = budget.minorUnits
  const pool = loaded[0].pool
  const target = targetTotal(months[0].lines)

  const accountName = new Map(accounts.data.map((a) => [a.id, a.name]))
  const scheduleNames = new Map(
    (schedules.data ?? []).map((sc) => {
      const who =
        sc.payee ||
        (sc.transferAccountId
          ? `轉到${accountName.get(sc.transferAccountId) ?? ''}`
          : sc.note || '排程')
      const rule = describeRRule(sc.rule, sc.holidayShift) ?? sc.source
      return [sc.id, `${who}（${rule}）`]
    }),
  )
  // Scheduled money that goes through envelopes or the pool.
  const coming = (upcoming.data ?? []).filter((o) => o.categoryId)
  const comingOut = coming
    .filter((o) => o.amount < 0)
    .reduce((sum, o) => sum - o.amount, 0)
  const comingIn = coming
    .filter((o) => o.amount > 0)
    .reduce((sum, o) => sum + o.amount, 0)

  async function setBase(categoryId: string, amount: number) {
    const { error } = await api.PUT(
      '/budgets/{budgetId}/categories/{categoryId}/base',
      {
        params: { path: { budgetId: budget.id, categoryId } },
        body: { amount },
      },
    )
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: categoriesQuery(budget.id).queryKey,
      }),
      queryClient.invalidateQueries({ queryKey: ['budget-month', budget.id] }),
    ])
    return error ? apiErrorMessage(error) : null
  }

  function goTo(next: string) {
    void navigate({ search: { month: next === thisMonth ? undefined : next } })
  }

  async function allocate(m: string, set: Array<Allocation>) {
    const key = budgetMonthQuery(budget.id, m).queryKey
    // Shown at once; the server's numbers follow.
    queryClient.setQueryData(key, (old) => {
      if (!old) return old
      const envelopes = [...old.envelopes]
      let p = old.pool
      for (const a of set) {
        const i = envelopes.findIndex((e) => e.categoryId === a.categoryId)
        const from = i < 0 ? 0 : envelopes[i].allocated
        p -= a.amount - from
        if (i < 0)
          envelopes.push({
            categoryId: a.categoryId,
            allocated: a.amount,
            activity: 0,
            carried: 0,
          })
        else envelopes[i] = { ...envelopes[i], allocated: a.amount }
      }
      return { ...old, pool: p, envelopes }
    })
    const { error } = await api.PUT(
      '/budgets/{budgetId}/months/{month}/allocations',
      {
        params: { path: { budgetId: budget.id, month: m } },
        body: { allocations: set },
      },
    )
    // Later months carry this one's balances, so they all reload.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['budget-month', budget.id] }),
      queryClient.invalidateQueries({
        queryKey: summaryQuery(budget.id).queryKey,
      }),
    ])
    return error ? apiErrorMessage(error) : null
  }

  async function lastMonth(m: string) {
    const before = await queryClient.fetchQuery(
      budgetMonthQuery(budget.id, shiftMonth(m, -1)),
    )
    return budgetLines(categories.data ?? [], before.envelopes)
  }

  return (
    <div
      ref={rootRef}
      // As wide as the months need, so a name and its amounts stay close.
      style={{ maxWidth: `${16 + 28 * count}rem` }}
      className="flex h-full w-full flex-col gap-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-b pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="上個月"
              onClick={() => goTo(shiftMonth(shown, -1))}
            >
              <ChevronLeft />
            </Button>
            <h1 className="text-2xl font-semibold tabular-nums">
              {monthLabel(shown)}
              {count > 1 && (
                <span className="text-muted-foreground">
                  {' – '}
                  {monthLabel(last)}
                </span>
              )}
            </h1>
            <Button
              variant="ghost"
              size="icon"
              aria-label="下個月"
              onClick={() => goTo(shiftMonth(shown, 1))}
            >
              <ChevronRight />
            </Button>
            {shown !== thisMonth && (
              <Button variant="link" size="sm" onClick={() => goTo(thisMonth)}>
                回到本月
              </Button>
            )}
            <div
              role="group"
              aria-label="一次顯示幾個月"
              className="ml-2 flex items-center rounded-md border border-rule text-xs"
            >
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={chosen === n}
                  disabled={n > fit}
                  title={n > fit ? '視窗太窄，放不下' : `一次顯示 ${n} 個月`}
                  onClick={() => choose(n)}
                  className={cn(
                    'h-7 px-2.5 text-muted-foreground first:rounded-l-md last:rounded-r-md hover:text-foreground disabled:opacity-40',
                    chosen === n && 'bg-accent text-foreground',
                  )}
                >
                  {n} 個月
                </button>
              ))}
            </div>
          </div>
          {count === 1 && (
            <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-1 pl-2 text-sm">
              <div className="flex gap-2">
                <dt className="text-muted-foreground">本月收入</dt>
                <dd>
                  <Amount value={loaded[0].income} minorUnits={mu} />
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">本月分配</dt>
                <dd>
                  <Amount value={totals.allocated} minorUnits={mu} />
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">本月花費</dt>
                <dd>
                  <Amount value={totals.activity} minorUnits={mu} />
                </dd>
              </div>
              {target > 0 && (
                <div
                  className="flex gap-2"
                  title="每個預算的基本額加上它涵蓋的排程；:fill 照目標分配"
                >
                  <dt className="text-muted-foreground">本月目標</dt>
                  <dd>
                    <Amount value={target} minorUnits={mu} />
                  </dd>
                </div>
              )}
            </dl>
          )}
        </div>
        <div className="text-right">
          <p className="text-sm text-muted-foreground">資金池（還沒分配）</p>
          <p className="text-3xl">
            <Amount value={pool} minorUnits={mu} />
          </p>
          {pool < 0 && (
            <p className="text-sm text-destructive">
              分配的比收入多：從預算退回一些到資金池
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-1 text-sm text-muted-foreground">
        <p className="flex items-center gap-1.5">
          {balanced ? (
            <Check className="size-4 text-positive" aria-label="對得上" />
          ) : (
            <TriangleAlert
              className="size-4 text-destructive"
              aria-label="對不上"
            />
          )}
          <span>
            預算內帳戶 <Amount value={s.onBudgetBalance} minorUnits={mu} /> ＝
            資金池 <Amount value={s.pool} minorUnits={mu} /> ＋ 所有預算{' '}
            <Amount value={s.envelopeBalance} minorUnits={mu} />
          </span>
        </p>
        {cards.length > 0 && (
          <p title="刷卡時已經從預算扣掉，錢留在預算內帳戶裡等著繳卡費">
            信用卡待繳：
            {cards.map((c, i) => (
              <span key={c.id}>
                {i > 0 && '、'}
                <Link
                  to="/b/$budgetId/accounts/$accountId"
                  params={{ budgetId: budget.id, accountId: c.id }}
                  className="text-foreground underline-offset-4 hover:underline"
                >
                  {c.name}
                </Link>{' '}
                <Amount value={-c.balance} minorUnits={mu} />
              </span>
            ))}
          </p>
        )}
        {coming.length > 0 && (
          <p title="接下來 30 天還沒入帳的排程（暫停的不算）">
            <Link
              to="/b/$budgetId/schedules"
              params={{ budgetId: budget.id }}
              className="text-foreground underline-offset-4 hover:underline"
            >
              接下來 30 天的排程
            </Link>
            ：支出 <Amount value={comingOut} minorUnits={mu} />
            {comingIn > 0 && (
              <>
                、收入 <Amount value={comingIn} minorUnits={mu} />
              </>
            )}
            （{coming.length} 筆）
          </p>
        )}
        {anyArchived && (
          <div className="flex items-center gap-2">
            <Switch
              id="show-archived"
              checked={showArchived}
              onCheckedChange={setShowArchived}
            />
            <Label htmlFor="show-archived" className="font-normal">
              顯示已封存
            </Label>
          </div>
        )}
      </div>

      <BudgetGrid
        months={months}
        categories={categories.data}
        minorUnits={mu}
        keymap={keymap}
        canManage={budget.role === 'owner'}
        onToggleArchived={() => setShowArchived((on) => !on)}
        onMonth={(delta) => goTo(shiftMonth(shown, delta))}
        onMonthCount={(n) => {
          choose(n)
          return n > fit ? `視窗太窄，現在只放得下 ${fit} 個月` : null
        }}
        allocate={allocate}
        lastMonth={lastMonth}
        categoryApi={categoryApi}
        scheduleNames={scheduleNames}
        setBase={setBase}
      />
    </div>
  )
}
