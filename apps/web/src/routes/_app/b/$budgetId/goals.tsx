import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { GoalGrid } from '#/components/goals/goal-grid'
import { apiErrorMessage } from '#/lib/apiError'
import { accountsQuery, categoriesQuery, goalsQuery } from '#/lib/budget'
import { envelopeMap } from '#/lib/goals'
import { useKeymap } from '#/lib/preferences'
import { categoryRefs } from '#/lib/register'
import type { Context } from '#/lib/register'

export const Route = createFileRoute('/_app/b/$budgetId/goals')({
  staticData: { crumb: '目標', wide: true },
  component: GoalsPage,
})

// Savings goals (ADR-092..094): edited as a grid whose order is the
// priority, saved with :w; their monthly amounts join the budget's targets.
function GoalsPage() {
  const { budget } = Route.useRouteContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const accounts = useQuery(accountsQuery(budget.id))
  const categories = useQuery(categoriesQuery(budget.id))
  const goals = useQuery(goalsQuery(budget.id))
  const keymap = useKeymap()

  const failed = [accounts, categories, goals].find((q) => q.isError)
  if (failed) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {apiErrorMessage(failed.error)}
      </p>
    )
  }
  if (!accounts.data || !categories.data || !goals.data) {
    return <p className="text-sm text-muted-foreground">載入中…</p>
  }

  const ctx: Context = {
    accounts: new Map(
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
    ),
    categories: categoryRefs(categories.data),
    minorUnits: budget.minorUnits,
  }

  async function reload() {
    // Goals ask for money in the months' targets (ADR-093).
    await queryClient.invalidateQueries({
      queryKey: ['budget-month', budget.id],
    })
    return queryClient.fetchQuery({ ...goalsQuery(budget.id), staleTime: 0 })
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2 border-b pb-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">目標</h1>
          <p className="text-sm text-muted-foreground">
            想買的東西、旅行、備用金：越上面越優先。預算的餘額依序分給它的目標，每月要的金額算進預算的目標（:fill）。
          </p>
        </div>
      </div>
      <GoalGrid
        budgetId={budget.id}
        ctx={ctx}
        envelopes={envelopeMap(categories.data)}
        list={goals.data}
        keymap={keymap}
        reload={reload}
        onQuit={() =>
          void navigate({ to: '/b/$budgetId', params: { budgetId: budget.id } })
        }
      />
    </div>
  )
}
