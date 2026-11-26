import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ScheduleGrid } from '#/components/schedules/schedule-grid'
import { apiErrorMessage } from '#/lib/apiError'
import {
  accountsQuery,
  categoriesQuery,
  holidaysQuery,
  payeesQuery,
  schedulesQuery,
  summaryQuery,
} from '#/lib/budget'
import { useKeymap } from '#/lib/preferences'
import { categoryRefs } from '#/lib/register'
import { daysOff } from '#/lib/schedule-rule'
import type { AccountRef, Context } from '#/lib/register'

export const Route = createFileRoute('/_app/b/$budgetId/schedules')({
  staticData: { crumb: '排程', wide: true },
  component: SchedulesPage,
})

// Schedules (ADR-084): edited as a grid, saved with :w; what comes due is
// posted as transactions on its date (ADR-085).
function SchedulesPage() {
  const { budget } = Route.useRouteContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const year = new Date().getFullYear()

  const accounts = useQuery(accountsQuery(budget.id))
  const categories = useQuery(categoriesQuery(budget.id))
  const payees = useQuery(payeesQuery(budget.id))
  const holidays = useQuery(holidaysQuery(year))
  const schedules = useQuery({
    ...schedulesQuery(budget.id),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const keymap = useKeymap()

  const failed = [accounts, categories, payees, holidays, schedules].find(
    (q) => q.isError,
  )
  if (failed) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {apiErrorMessage(failed.error)}
      </p>
    )
  }
  if (
    !accounts.data ||
    !categories.data ||
    !payees.data ||
    !holidays.data ||
    !schedules.data
  ) {
    return <p className="text-sm text-muted-foreground">載入中…</p>
  }

  const refs = new Map<string, AccountRef>(
    accounts.data.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.name,
        onBudget: a.onBudget,
        // Friend accounts move only through shared expenses (ADR-106):
        // shown by name, never offered for an entry.
        closed: a.closed || a.kind === 'friend',
      },
    ]),
  )
  const ctx: Context = {
    accounts: refs,
    categories: categoryRefs(categories.data),
    minorUnits: budget.minorUnits,
  }

  async function reload() {
    // Saving posts what is due: registers, balances and months change too.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['register', budget.id] }),
      queryClient.invalidateQueries({ queryKey: ['budget-month', budget.id] }),
      queryClient.invalidateQueries({
        queryKey: accountsQuery(budget.id).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: summaryQuery(budget.id).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: payeesQuery(budget.id).queryKey,
      }),
      queryClient.invalidateQueries({ queryKey: ['upcoming', budget.id] }),
    ])
    return queryClient.fetchQuery({
      ...schedulesQuery(budget.id),
      staleTime: 0,
    })
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2 border-b pb-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">排程</h1>
          <p className="text-sm text-muted-foreground">
            訂閱、房租、帳單：到期當天自動入帳。預算方式決定它怎麼算進預算的目標（:fill）。
          </p>
        </div>
      </div>
      <ScheduleGrid
        budgetId={budget.id}
        ctx={ctx}
        schedules={schedules.data}
        payees={payees.data.map((p) => ({
          name: p.name,
          lastCategoryId: p.lastCategoryId,
        }))}
        keymap={keymap}
        off={daysOff(holidays.data)}
        reload={reload}
        onQuit={() =>
          void navigate({ to: '/b/$budgetId', params: { budgetId: budget.id } })
        }
      />
    </div>
  )
}
