import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { SplittingGrid } from '#/components/friends/splitting-grid'
import { apiErrorMessage } from '#/lib/apiError'
import { friendsQuery, groupsQuery, homeBudget } from '#/lib/budget'
import { formatAmount } from '#/lib/money'
import { useKeymap } from '#/lib/preferences'

export const Route = createFileRoute('/_app/friends/')({
  staticData: { crumb: '分帳', wide: true },
  component: FriendsPage,
})

// Groups and friends to split with (ADR-104, ADR-115, ADR-116), as one grid
// saved with :w: friends added by name before they have an account, each
// with a friend account in the default budget whose balance is what they
// owe; groups of them with one group account each.
function FriendsPage() {
  const { budgets, user } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const keymap = useKeymap()
  // The grid owns the lines once loaded; it reloads them after :w.
  const owned = { staleTime: Infinity, refetchOnWindowFocus: false }
  const friends = useQuery({ ...friendsQuery, ...owned })
  const groups = useQuery({ ...groupsQuery, ...owned })
  const budget = homeBudget(budgets)
  const minorUnits = budget?.minorUnits ?? 0

  const failed = [friends, groups].find((q) => q.isError)
  if (failed) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {apiErrorMessage(failed.error)}
      </p>
    )
  }

  async function reload() {
    // Friend and group accounts are listed with the budget's accounts, and
    // a friend's or group's page shows names and members.
    await Promise.all(
      [
        '/budgets/{budgetId}/accounts',
        '/friends/{friendId}/expenses',
        '/groups/{groupId}/expenses',
      ].map((path) =>
        queryClient.invalidateQueries({ queryKey: ['get', path] }),
      ),
    )
    const [f, g] = await Promise.all([
      queryClient.fetchQuery({ ...friendsQuery, staleTime: 0 }),
      queryClient.fetchQuery({ ...groupsQuery, staleTime: 0 }),
    ])
    return { friends: f, groups: g }
  }

  const all = [...(friends.data ?? []), ...(groups.data ?? [])]
  const owed = all.reduce((sum, x) => sum + Math.max(0, x.balance), 0)
  const owing = all.reduce((sum, x) => sum + Math.min(0, x.balance), 0)

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-semibold">分帳</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          朋友還沒有帳號也能先記：輸入名字就好，只有你看得到。每位朋友和每個群組在「
          {budget?.name ?? '預設帳本'}
          」有一個往來帳戶，餘額就是對方欠你（負的是你欠對方）多少；你的份照常算進預算。
          {friends.data && groups.data && (
            <>
              {' '}
              別人欠我{' '}
              <span className="amount text-positive">
                {formatAmount(owed, minorUnits)}
              </span>
              {' · '}我欠別人{' '}
              <span className="amount amount-negative">
                {formatAmount(-owing, minorUnits)}
              </span>
            </>
          )}
        </p>
      </div>

      {!budget ? (
        <p className="text-sm text-muted-foreground">
          先
          <Link to="/setup" className="underline underline-offset-4">
            建立帳本
          </Link>
          ，分帳要記到帳本裡。
        </p>
      ) : !friends.data || !groups.data ? (
        <p className="text-sm text-muted-foreground">載入中…</p>
      ) : (
        <SplittingGrid
          me={user.id}
          groups={groups.data}
          friends={friends.data}
          minorUnits={minorUnits}
          keymap={keymap}
          reload={reload}
        />
      )}
    </div>
  )
}
