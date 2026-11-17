import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useParams,
  useRouter,
} from '@tanstack/react-router'
import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from 'lucide-react'
import { Statusline } from '#/components/statusline'
import { ThemeMenuItems } from '#/components/theme'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Wordmark } from '#/components/wordmark'
import { $api } from '#/lib/api'
import { meQueryOptions } from '#/lib/auth'
import { budgetsQueryOptions, homeBudget } from '#/lib/budget'
import type { CurrentUser } from '#/lib/auth'
import type { Budget } from '#/lib/budget'

// Everything under this layout needs a session; /login is the only page
// outside it. The check is only for the UI: the API enforces access itself.
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(meQueryOptions)
    if (!user) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    const budgets =
      await context.queryClient.ensureQueryData(budgetsQueryOptions)
    return { user, budgets }
  },
  component: AppLayout,
})

// The frame of an editor: places on the left, the page in the middle, the
// status line along the bottom. On narrow screens the places move to the top.
function AppLayout() {
  const { user } = Route.useRouteContext()
  const budgets = useQuery(budgetsQueryOptions).data ?? []
  // The budget in the URL, or the one the wordmark leads to.
  const { budgetId } = useParams({ strict: false })
  const budget = budgets.find((b) => b.id === budgetId) ?? homeBudget(budgets)

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b bg-sidebar px-4 pt-2 md:w-56 md:flex-col md:flex-nowrap md:items-stretch md:gap-6 md:border-r md:border-b-0 md:px-3 md:py-4">
          <Link to="/" className="px-2 text-lg md:pt-1">
            <Wordmark />
          </Link>

          <nav
            aria-label="主選單"
            className="order-last -mx-2 flex w-full items-center gap-1 overflow-x-auto pb-1 text-sm [scrollbar-width:none] md:order-none md:mx-0 md:w-auto md:flex-1 md:flex-col md:items-stretch md:gap-5 md:overflow-visible md:pb-0"
          >
            <div className="flex items-center gap-1 md:flex-col md:items-stretch">
              {budget ? (
                <>
                  <BudgetSwitcher budgets={budgets} current={budget} />
                  <Link
                    to="/b/$budgetId/accounts"
                    params={{ budgetId: budget.id }}
                    className={navLinkClass}
                  >
                    帳戶
                  </Link>
                  <Link
                    to="/b/$budgetId/categories"
                    params={{ budgetId: budget.id }}
                    className={navLinkClass}
                  >
                    類別
                  </Link>
                </>
              ) : (
                <Link to="/setup" className={navLinkClass}>
                  建立帳本
                </Link>
              )}
            </div>
            <div className="flex items-center gap-1 md:flex-col md:items-stretch">
              <p className="hidden px-2 pb-1 text-xs text-muted-foreground md:block">
                設定
              </p>
              <Link to="/profile" className={navLinkClass}>
                個人資料
              </Link>
              {user.isAdmin && (
                <Link to="/settings/oidc-providers" className={navLinkClass}>
                  第三方登入
                </Link>
              )}
            </div>
          </nav>

          <UserMenu user={user} />
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="w-full max-w-4xl px-6 py-8 md:px-10">
            <Outlet />
          </div>
        </main>
      </div>

      <Statusline username={user.username} />
    </div>
  )
}

// The kraft bar marks the current place, like a cursor in the margin. The
// router sets data-status="active" on the current link.
const navLinkClass =
  'rounded-md border-l-2 border-transparent px-2 py-1.5 whitespace-nowrap text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:rounded-l-none data-[status=active]:border-kraft data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-accent-foreground'

/** The budget being looked at; switches between budgets and creates one. */
function BudgetSwitcher({
  budgets,
  current,
}: {
  budgets: Array<Budget>
  current: Budget
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="budget-switcher"
        className="flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring md:pb-1"
      >
        <span className="truncate">{current.name}</span>
        <ChevronsUpDownIcon className="size-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          帳本
        </DropdownMenuLabel>
        {budgets.map((b) => (
          <DropdownMenuItem key={b.id} asChild>
            <Link to="/b/$budgetId/accounts" params={{ budgetId: b.id }}>
              <CheckIcon className={b.id === current.id ? '' : 'invisible'} />
              <span className="truncate">{b.name}</span>
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/setup">
            <PlusIcon />
            新增帳本
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UserMenu({ user }: { user: CurrentUser }) {
  const router = useRouter()
  const queryClient = useQueryClient()

  const logout = $api.useMutation('post', '/auth/logout', {
    onSettled: async () => {
      queryClient.clear()
      queryClient.setQueryData(meQueryOptions.queryKey, null)
      await router.navigate({ to: '/login' })
    },
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="user-menu"
        className="ml-auto flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring md:ml-0"
      >
        <span className="truncate">{user.displayName || user.username}</span>
        <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          {user.username}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          外觀
        </DropdownMenuLabel>
        <ThemeMenuItems />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={logout.isPending}
          onSelect={() => logout.mutate({})}
        >
          登出
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
