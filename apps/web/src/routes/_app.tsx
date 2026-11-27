import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useMatches,
  useParams,
  useRouter,
} from '@tanstack/react-router'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  PlusIcon,
  SettingsIcon,
  UserIcon,
  UsersIcon,
} from 'lucide-react'
import { useState } from 'react'
import { Logo } from '#/components/logo'
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
import { accountsQuery, budgetsQueryOptions, homeBudget } from '#/lib/budget'
import { formatAmount, setAmountGrouping } from '#/lib/money'
import { useListKeys, usePaneNavigation } from '#/lib/panes'
import { preferencesQuery, useKeymap } from '#/lib/preferences'
import { cn } from '#/lib/utils'
import type { CurrentUser } from '#/lib/auth'
import type { Account, Budget } from '#/lib/budget'

// Everything under this layout needs a session; /login is the only page
// outside it. The check is only for the UI: the API enforces access itself.
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(meQueryOptions)
    if (!user) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    const [budgets] = await Promise.all([
      context.queryClient.ensureQueryData(budgetsQueryOptions),
      // How amounts are grouped is needed before the first amount is drawn.
      context.queryClient.ensureQueryData(preferencesQuery()),
    ])
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
  // The register takes the whole page and scrolls inside itself.
  const wide = useMatches().some((m) => m.staticData.wide)
  const budget = budgets.find((b) => b.id === budgetId) ?? homeBudget(budgets)
  const keymap = useKeymap()
  // Amounts are formatted with the user's grouping (ADR-122); changing it
  // draws the whole frame again (`key` below).
  const grouping = useQuery(preferencesQuery()).data?.amountGrouping ?? 3
  setAmountGrouping(grouping)
  usePaneNavigation(keymap)
  const onSidebarKeyDown = useListKeys(keymap, 'sidebar')

  return (
    // Keyed by the grouping so every amount, the sidebar's too, is drawn
    // again when it changes.
    <div key={grouping} className="flex h-dvh flex-col">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          data-pane="sidebar"
          data-editor
          onKeyDown={onSidebarKeyDown}
          className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b bg-sidebar px-4 pt-2 md:w-60 md:flex-col md:flex-nowrap md:items-stretch md:gap-6 md:border-r md:border-b-0 md:px-3 md:py-4"
        >
          <Link to="/" className="flex items-center gap-2 px-2 text-lg md:pt-1">
            <Logo />
            <Wordmark />
          </Link>

          <nav
            aria-label="主選單"
            className="order-last -mx-2 flex w-full items-center gap-1 overflow-x-auto pb-1 text-sm [scrollbar-width:none] md:order-none md:mx-0 md:w-auto md:min-h-0 md:flex-1 md:flex-col md:items-stretch md:gap-5 md:overflow-y-auto md:pb-0"
          >
            <div className="flex items-center gap-1 md:flex-col md:items-stretch">
              {budget ? (
                <>
                  <BudgetSwitcher budgets={budgets} current={budget} />
                  <Link
                    to="/b/$budgetId"
                    params={{ budgetId: budget.id }}
                    activeOptions={{ exact: true, includeSearch: false }}
                    className={navLinkClass}
                  >
                    預算
                  </Link>
                  {/* Narrow screens have no room for the accounts list. */}
                  <Link
                    to="/b/$budgetId/accounts/$accountId"
                    params={{ budgetId: budget.id, accountId: 'all' }}
                    className={cn(navLinkClass, 'md:hidden')}
                  >
                    明細
                  </Link>
                  <Link
                    to="/b/$budgetId/accounts"
                    params={{ budgetId: budget.id }}
                    activeOptions={{ exact: true }}
                    className={cn(navLinkClass, 'md:hidden')}
                  >
                    帳戶
                  </Link>
                  <Link
                    to="/b/$budgetId/schedules"
                    params={{ budgetId: budget.id }}
                    className={navLinkClass}
                  >
                    排程
                  </Link>
                  <Link
                    to="/b/$budgetId/goals"
                    params={{ budgetId: budget.id }}
                    className={navLinkClass}
                  >
                    目標
                  </Link>
                  <Link to="/friends" className={navLinkClass}>
                    分帳
                  </Link>
                  <Link
                    to="/b/$budgetId/payees"
                    params={{ budgetId: budget.id }}
                    className={navLinkClass}
                  >
                    收付款對象
                  </Link>
                </>
              ) : (
                <Link to="/setup" className={navLinkClass}>
                  建立帳本
                </Link>
              )}
            </div>
            {budget && <AccountsNav budget={budget} />}
            <div className="flex items-center gap-1 md:flex-col md:items-stretch">
              <p className="hidden px-2 pb-1 text-xs text-muted-foreground md:block">
                設定
              </p>
              <Link to="/profile" className={navLinkClass}>
                個人資料
              </Link>
              <Link to="/settings/editor" className={navLinkClass}>
                編輯器
              </Link>
              {user.isAdmin && (
                <Link to="/settings/oidc-providers" className={navLinkClass}>
                  第三方登入
                </Link>
              )}
              {user.isAdmin && (
                <Link to="/settings/holidays" className={navLinkClass}>
                  國定假日
                </Link>
              )}
            </div>
          </nav>

          <UserMenu user={user} />
        </aside>

        <main
          data-pane="main"
          tabIndex={-1}
          className={cn(
            'outline-none',
            'min-w-0 flex-1',
            wide ? 'overflow-hidden' : 'overflow-y-auto',
          )}
        >
          <div
            className={
              wide
                ? 'h-full w-full px-4 py-5 md:px-8'
                : 'w-full max-w-4xl px-6 py-8 md:px-10'
            }
          >
            <Outlet />
          </div>
        </main>
      </div>

      <Statusline username={user.username} />
    </div>
  )
}

// The kraft bar marks the current place, like a cursor in the margin; the
// keyboard focus is a kraft tint, as the selection in the register is. The
// router sets data-status="active" on the current link.
const navLinkClass =
  'rounded-md border-l-2 border-transparent px-2 py-1.5 whitespace-nowrap text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-kraft/20 focus-visible:text-foreground data-[status=active]:rounded-l-none data-[status=active]:border-kraft data-[status=active]:font-medium data-[status=active]:text-foreground'

/**
 * The accounts, as in Actual: all of them, the budget accounts and the
 * tracking accounts, each a register one click away (ADR-071). Friend and
 * group accounts (ADR-106, ADR-115) count on budget but are not the user's
 * own money: they come after the budget's own accounts, under 分帳往來,
 * which folds away as the list grows (ADR-127).
 */
function AccountsNav({ budget }: { budget: Budget }) {
  const { data } = useQuery(accountsQuery(budget.id))
  const [sharedOpen, setSharedOpen] = useState(readSharedOpen)
  const open = (data ?? []).filter((a) => !a.closed)
  const onBudget = open.filter((a) => a.onBudget)
  const groups = [
    {
      id: 'on-budget',
      label: '預算內',
      accounts: onBudget,
      own: onBudget.filter((a) => a.kind !== 'friend'),
      shared: onBudget
        .filter((a) => a.kind === 'friend')
        // Groups first, then friends, each by name.
        .toSorted(
          (x, y) =>
            Number(!x.groupId) - Number(!y.groupId) ||
            x.name.localeCompare(y.name, 'zh-Hant'),
        ),
    },
    {
      id: 'off-budget',
      label: '預算外',
      accounts: open.filter((a) => !a.onBudget),
      own: open.filter((a) => !a.onBudget),
      shared: [],
    },
  ].filter((g) => g.accounts.length > 0)
  const total = (list: Array<Account>) =>
    list.reduce((sum, a) => sum + a.balance, 0)

  function toggleShared() {
    const next = !sharedOpen
    setSharedOpen(next)
    try {
      localStorage.setItem(SHARED_OPEN_KEY, next ? '1' : '0')
    } catch {
      // Only a convenience.
    }
  }

  return (
    <div className="hidden flex-col gap-0.5 md:flex" aria-label="帳戶">
      <AccountLink
        budget={budget}
        accountId="all"
        label="所有帳戶"
        balance={total(open)}
        strong
      />
      {groups.map((g) => (
        <div key={g.id} className="mt-2 flex flex-col gap-0.5">
          <AccountLink
            budget={budget}
            accountId={g.id}
            label={g.label}
            balance={total(g.accounts)}
            strong
          />
          {g.own.map((a) => (
            <AccountLink
              key={a.id}
              budget={budget}
              accountId={a.id}
              label={a.name}
              balance={a.balance}
            />
          ))}
          {g.shared.length > 0 && (
            <>
              <button
                type="button"
                aria-expanded={sharedOpen}
                onClick={toggleShared}
                title={sharedOpen ? '收起朋友和群組' : '展開朋友和群組'}
                className={cn(
                  navLinkClass,
                  'mt-1 flex items-baseline justify-between gap-3 py-1 pl-4 text-left',
                )}
              >
                <span className="flex min-w-0 items-center gap-1 self-center text-xs">
                  {sharedOpen ? (
                    <ChevronDownIcon className="size-3.5 shrink-0" />
                  ) : (
                    <ChevronRightIcon className="size-3.5 shrink-0" />
                  )}
                  <span className="truncate">分帳往來</span>
                  <span className="text-muted-foreground/70">
                    {g.shared.length}
                  </span>
                </span>
                <Balance value={total(g.shared)} budget={budget} />
              </button>
              {sharedOpen &&
                g.shared.map((a) => (
                  <AccountLink
                    key={a.id}
                    budget={budget}
                    accountId={a.id}
                    label={a.name}
                    balance={a.balance}
                    icon={
                      a.groupId ? (
                        <UsersIcon aria-label="群組" className="size-3.5" />
                      ) : (
                        <UserIcon aria-label="朋友" className="size-3.5" />
                      )
                    }
                  />
                ))}
            </>
          )}
        </div>
      ))}
      <Link
        to="/b/$budgetId/accounts"
        params={{ budgetId: budget.id }}
        activeOptions={{ exact: true }}
        className={cn(navLinkClass, 'mt-2 flex items-center gap-1.5 text-xs')}
      >
        <SettingsIcon className="size-3.5" />
        管理帳戶
      </Link>
    </div>
  )
}

/** Whether 分帳往來 is open in the sidebar; kept per browser. */
const SHARED_OPEN_KEY = 'factual:sidebar:shared-open'

function readSharedOpen(): boolean {
  try {
    return localStorage.getItem(SHARED_OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

function Balance({ value, budget }: { value: number; budget: Budget }) {
  return (
    <span
      className={cn(
        'amount shrink-0 text-xs',
        value < 0 ? 'amount-negative' : 'text-muted-foreground',
      )}
    >
      {formatAmount(value, budget.minorUnits)}
    </span>
  )
}

function AccountLink({
  budget,
  accountId,
  label,
  balance,
  strong = false,
  icon,
}: {
  budget: Budget
  accountId: string
  label: string
  balance: number
  strong?: boolean
  /** Before the name: a friend's or a group's account. */
  icon?: React.ReactNode
}) {
  return (
    <Link
      to="/b/$budgetId/accounts/$accountId"
      params={{ budgetId: budget.id, accountId }}
      className={cn(
        navLinkClass,
        'flex items-baseline justify-between gap-3 py-1',
        strong ? 'text-foreground' : icon ? 'pl-6' : 'pl-4',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {icon && (
          <span className="shrink-0 self-center text-muted-foreground">
            {icon}
          </span>
        )}
        <span className="truncate">{label}</span>
      </span>
      <Balance value={balance} budget={budget} />
    </Link>
  )
}

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
        className="flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-kraft/20 focus-visible:text-foreground md:pb-1"
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
            <Link to="/b/$budgetId" params={{ budgetId: b.id }}>
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
        className="ml-auto flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-sidebar-accent focus-visible:bg-kraft/20 md:ml-0"
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
