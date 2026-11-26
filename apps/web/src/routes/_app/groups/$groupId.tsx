import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { ExpenseGrid } from '#/components/friends/expense-grid'
import { apiErrorMessage } from '#/lib/apiError'
import {
  accountsQuery,
  categoriesQuery,
  friendsQuery,
  groupExpensesQuery,
  groupsQuery,
} from '#/lib/budget'
import { useKeymap } from '#/lib/preferences'
import { categoryRefs } from '#/lib/register'
import { groupPeople } from '#/lib/split'
import type { AccountRef, Context } from '#/lib/register'

export const Route = createFileRoute('/_app/groups/$groupId')({
  staticData: { crumb: '分帳', wide: true },
  component: GroupPage,
})

// A group's shared expenses (M13, ADR-115), edited as a grid and saved with
// :w like a friend's; saving writes the user's side into the group account
// of their default budget, so its months and accounts are reloaded after.
function GroupPage() {
  const { user, budgets } = Route.useRouteContext()
  const { groupId } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const keymap = useKeymap()

  const expenses = useQuery({
    ...groupExpensesQuery(groupId),
    // The grid owns the lines once loaded; it reloads them after :w.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const budgetId = expenses.data?.group.budgetId ?? ''
  const budget = budgets.find((b) => b.id === budgetId)
  const accounts = useQuery({ ...accountsQuery(budgetId), enabled: !!budget })
  const categories = useQuery({
    ...categoriesQuery(budgetId),
    enabled: !!budget,
  })

  const failed = [expenses, accounts, categories].find((q) => q.isError)
  if (failed) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {apiErrorMessage(failed.error)}
      </p>
    )
  }
  if (expenses.data && !budget) {
    return (
      <p className="text-sm text-muted-foreground">
        分帳要記到預設帳本，先
        <Link to="/setup" className="underline underline-offset-4">
          建立帳本
        </Link>
        。
      </p>
    )
  }
  if (!expenses.data || !budget || !accounts.data || !categories.data) {
    return <p className="text-sm text-muted-foreground">載入中…</p>
  }

  const { group } = expenses.data
  const people = groupPeople(user.id, group)
  // The accounts the user pays from or into: the budget's, not friend or
  // group accounts (those move only through shared expenses).
  const refs = new Map<string, AccountRef>(
    accounts.data
      .filter((a) => a.kind !== 'friend')
      .map((a) => [
        a.id,
        { id: a.id, name: a.name, onBudget: a.onBudget, closed: a.closed },
      ]),
  )
  const ctx: Context = {
    accounts: refs,
    categories: categoryRefs(categories.data),
    minorUnits: budget.minorUnits,
  }

  async function refreshLists() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: groupsQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: friendsQuery.queryKey }),
      queryClient.invalidateQueries({
        queryKey: accountsQuery(budgetId).queryKey,
      }),
    ])
  }

  async function reload() {
    // The user's side is in their budget (ADR-035): its months, registers
    // and accounts change with every save.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['budget-month', budgetId] }),
      queryClient.invalidateQueries({ queryKey: ['register', budgetId] }),
      queryClient.invalidateQueries({
        queryKey: ['get', '/budgets/{budgetId}/summary'],
      }),
      refreshLists(),
    ])
    const fresh = await queryClient.fetchQuery({
      ...groupExpensesQuery(groupId),
      staleTime: 0,
    })
    return fresh.expenses
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2 border-b pb-4">
        <div className="min-w-0">
          <Link
            to="/friends"
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            分帳
          </Link>
          <h1 className="text-2xl font-semibold">
            {group.name}
            {group.archived && (
              <span className="ml-3 align-middle text-sm font-normal text-muted-foreground">
                已封存
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {people.members.map((m) => m.name).join('、')}
            。我的份記進「{budget.name}
            」的類別，群組往來帳戶記著群組欠我（或我欠群組）多少。名稱、成員和封存在
            <Link to="/friends" className="underline underline-offset-4">
              分帳頁
            </Link>
            修改。
          </p>
        </div>
      </div>
      <ExpenseGrid
        // A new member list or archiving starts the grid over on the
        // reloaded group (its drafts are kept).
        key={`${groupId}:${people.members.map((m) => m.id).join()}:${group.archived}`}
        scope={{ kind: 'group', groupId, archived: group.archived }}
        people={people}
        currency={budget.currency}
        ctx={ctx}
        expenses={expenses.data.expenses}
        keymap={keymap}
        reload={reload}
        onQuit={() => void navigate({ to: '/friends' })}
      />
    </div>
  )
}
