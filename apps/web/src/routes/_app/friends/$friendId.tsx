import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { ExpenseGrid } from '#/components/friends/expense-grid'
import { apiErrorMessage } from '#/lib/apiError'
import {
  accountsQuery,
  categoriesQuery,
  friendExpensesQuery,
  friendsQuery,
} from '#/lib/budget'
import { useKeymap } from '#/lib/preferences'
import { categoryRefs } from '#/lib/register'
import type { AccountRef, Context } from '#/lib/register'
import type { People } from '#/lib/split'

export const Route = createFileRoute('/_app/friends/$friendId')({
  staticData: { crumb: '分帳', wide: true },
  component: FriendPage,
})

// The shared expenses with one friend (M12, ADR-106), edited as a grid and
// saved with :w; saving also writes the user's side into their default
// budget, so its months and the friend account are reloaded after.
function FriendPage() {
  const { user, budgets } = Route.useRouteContext()
  const { friendId } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const keymap = useKeymap()

  const expenses = useQuery({
    ...friendExpensesQuery(friendId),
    // The grid owns the lines once loaded; it reloads them after :w.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const budgetId = expenses.data?.friend.budgetId ?? ''
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

  const { friend } = expenses.data
  const people: People = {
    me: user.id,
    friend: friend.id,
    friendName: friend.displayName,
  }
  // The accounts the user pays from or into: the budget's, not friend
  // accounts (those move only through shared expenses).
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

  async function reload() {
    // The user's side is in their budget (ADR-035): its months, registers
    // and accounts change with every save.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['budget-month', budgetId] }),
      queryClient.invalidateQueries({ queryKey: ['register', budgetId] }),
      queryClient.invalidateQueries({
        queryKey: accountsQuery(budgetId).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: ['get', '/budgets/{budgetId}/summary'],
      }),
      queryClient.invalidateQueries({ queryKey: friendsQuery.queryKey }),
    ])
    const fresh = await queryClient.fetchQuery({
      ...friendExpensesQuery(friendId),
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
          <h1 className="text-2xl font-semibold">{friend.displayName}</h1>
          <p className="text-sm text-muted-foreground">
            一起付的花費和還款。我的份記進「{budget.name}
            」的類別，往來帳戶記著誰欠誰。
            {friend.placeholder &&
              `${friend.displayName} 還沒有帳號，只有你看得到這些分帳。`}
          </p>
        </div>
      </div>
      <ExpenseGrid
        key={friendId}
        friendId={friendId}
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
