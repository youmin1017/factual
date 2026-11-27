import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
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
import { useEffect, useState } from 'react'
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from '#/components/ui/sidebar'
import { Wordmark } from '#/components/wordmark'
import { $api } from '#/lib/api'
import { meQueryOptions } from '#/lib/auth'
import { accountsQuery, budgetsQueryOptions, homeBudget } from '#/lib/budget'
import { formatAmount, setAmountGrouping } from '#/lib/money'
import { useListKeys, usePaneNavigation } from '#/lib/panes'
import { preferencesQuery, useKeymap } from '#/lib/preferences'
import { cn } from '#/lib/utils'
import type { LinkProps } from '@tanstack/react-router'
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

// The frame of an editor (ADR-130): shadcn's sidebar on the left (a sheet
// on narrow screens), the page beside it, the status line along the whole
// bottom, where the sidebar is opened and closed.
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
    <SidebarProvider key={grouping} className="h-dvh min-h-0 flex-col">
      <CloseSheetOnNavigate />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar>
          {/* The pane j/k move through (ADR-071); the rail stays out of it. */}
          <div
            data-pane="sidebar"
            data-editor
            onKeyDown={onSidebarKeyDown}
            className="flex min-h-0 flex-1 flex-col"
          >
            <SidebarHeader className="gap-1 px-3 pt-4">
              <Link
                to="/"
                className="flex items-center gap-2 px-2 pb-1 text-lg"
              >
                <Logo />
                <Wordmark />
              </Link>
              {budget && <BudgetSwitcher budgets={budgets} current={budget} />}
            </SidebarHeader>

            <SidebarContent className="gap-0">
              <SidebarGroup>
                <SidebarMenu aria-label="主選單">
                  {budget ? (
                    <>
                      <NavItem
                        to="/b/$budgetId"
                        params={{ budgetId: budget.id }}
                        exact
                      >
                        預算
                      </NavItem>
                      <NavItem
                        to="/b/$budgetId/schedules"
                        params={{ budgetId: budget.id }}
                      >
                        排程
                      </NavItem>
                      <NavItem
                        to="/b/$budgetId/goals"
                        params={{ budgetId: budget.id }}
                      >
                        目標
                      </NavItem>
                      <NavItem to="/friends">分帳</NavItem>
                      <NavItem
                        to="/b/$budgetId/payees"
                        params={{ budgetId: budget.id }}
                      >
                        收付款對象
                      </NavItem>
                    </>
                  ) : (
                    <NavItem to="/setup">建立帳本</NavItem>
                  )}
                </SidebarMenu>
              </SidebarGroup>

              {budget && <AccountsNav budget={budget} />}

              <SidebarGroup>
                <SidebarGroupLabel>設定</SidebarGroupLabel>
                <SidebarMenu>
                  <NavItem to="/profile">個人資料</NavItem>
                  <NavItem to="/settings/editor">編輯器</NavItem>
                  {user.isAdmin && (
                    <NavItem to="/settings/oidc-providers">第三方登入</NavItem>
                  )}
                  {user.isAdmin && (
                    <NavItem to="/settings/holidays">國定假日</NavItem>
                  )}
                </SidebarMenu>
              </SidebarGroup>
            </SidebarContent>

            <SidebarFooter className="px-3 pb-3">
              <UserMenu user={user} />
            </SidebarFooter>
          </div>
          <SidebarRail />
        </Sidebar>

        <SidebarInset
          data-pane="main"
          tabIndex={-1}
          className={cn(
            'min-w-0 outline-none',
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
        </SidebarInset>
      </div>

      <Statusline username={user.username} />
    </SidebarProvider>
  )
}

/** On narrow screens the sidebar is a sheet; going to a page closes it. */
function CloseSheetOnNavigate() {
  const { setOpenMobile } = useSidebar()
  const path = useLocation({ select: (l) => l.pathname })
  useEffect(() => {
    setOpenMobile(false)
  }, [path, setOpenMobile])
  return null
}

// The kraft bar marks the current place, like a cursor in the margin; the
// keyboard focus is a kraft tint, as the selection in the register is. The
// router sets data-status="active" on the current link.
const navLinkClass =
  'rounded-md border-l-2 border-transparent text-muted-foreground focus-visible:bg-kraft/20 focus-visible:text-foreground focus-visible:ring-0 data-[status=active]:rounded-l-none data-[status=active]:border-kraft data-[status=active]:font-medium data-[status=active]:text-foreground'

/** A page in the sidebar's menu. */
function NavItem({
  to,
  params,
  exact = false,
  children,
}: {
  to: LinkProps['to']
  params?: LinkProps['params']
  /** Active only on this page itself, not the pages under it. */
  exact?: boolean
  children: React.ReactNode
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild className={navLinkClass}>
        <Link
          to={to}
          params={params}
          activeOptions={
            exact ? { exact: true, includeSearch: false } : undefined
          }
        >
          {children}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

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
    <SidebarGroup aria-label="帳戶">
      <SidebarGroupLabel>帳戶</SidebarGroupLabel>
      <SidebarMenu>
        <AccountItem
          budget={budget}
          accountId="all"
          label="所有帳戶"
          balance={total(open)}
        />
        {groups.map((g) => (
          <SidebarMenuItem key={g.id}>
            <AccountButton
              budget={budget}
              accountId={g.id}
              label={g.label}
              balance={total(g.accounts)}
            />
            <SidebarMenuSub>
              {g.own.map((a) => (
                <AccountSubItem
                  key={a.id}
                  budget={budget}
                  accountId={a.id}
                  label={a.name}
                  balance={a.balance}
                />
              ))}
              {g.shared.length > 0 && (
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton asChild>
                    <button
                      type="button"
                      aria-expanded={sharedOpen}
                      onClick={toggleShared}
                      title={sharedOpen ? '收起朋友和群組' : '展開朋友和群組'}
                      className="w-full cursor-default text-muted-foreground focus-visible:bg-kraft/20 focus-visible:ring-0"
                    >
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-1">
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
                      </span>
                    </button>
                  </SidebarMenuSubButton>
                  {sharedOpen && (
                    <SidebarMenuSub className="mr-0 pr-0">
                      {g.shared.map((a) => (
                        <AccountSubItem
                          key={a.id}
                          budget={budget}
                          accountId={a.id}
                          label={a.name}
                          balance={a.balance}
                          icon={
                            a.groupId ? (
                              <UsersIcon aria-label="群組" />
                            ) : (
                              <UserIcon aria-label="朋友" />
                            )
                          }
                        />
                      ))}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuSubItem>
              )}
            </SidebarMenuSub>
          </SidebarMenuItem>
        ))}
        <SidebarMenuItem>
          <SidebarMenuButton asChild size="sm" className={navLinkClass}>
            <Link
              to="/b/$budgetId/accounts"
              params={{ budgetId: budget.id }}
              activeOptions={{ exact: true }}
            >
              <SettingsIcon />
              <span>管理帳戶</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
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

/** A register: its name and balance. */
function AccountLabel({
  label,
  balance,
  budget,
  icon,
}: {
  label: string
  balance: number
  budget: Budget
  icon?: React.ReactNode
}) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
      <span className="flex min-w-0 items-center gap-1.5">
        {icon && (
          <span className="shrink-0 self-center text-muted-foreground [&>svg]:size-3.5">
            {icon}
          </span>
        )}
        <span className="truncate">{label}</span>
      </span>
      <Balance value={balance} budget={budget} />
    </span>
  )
}

interface AccountProps {
  budget: Budget
  accountId: string
  label: string
  balance: number
  /** Before the name: a friend's or a group's account. */
  icon?: React.ReactNode
}

function AccountButton({ budget, accountId, label, balance }: AccountProps) {
  return (
    <SidebarMenuButton
      asChild
      className={cn(navLinkClass, 'text-sidebar-foreground')}
    >
      <Link
        to="/b/$budgetId/accounts/$accountId"
        params={{ budgetId: budget.id, accountId }}
      >
        <AccountLabel label={label} balance={balance} budget={budget} />
      </Link>
    </SidebarMenuButton>
  )
}

function AccountItem(props: AccountProps) {
  return (
    <SidebarMenuItem>
      <AccountButton {...props} />
    </SidebarMenuItem>
  )
}

function AccountSubItem({
  budget,
  accountId,
  label,
  balance,
  icon,
}: AccountProps) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild className={navLinkClass}>
        <Link
          to="/b/$budgetId/accounts/$accountId"
          params={{ budgetId: budget.id, accountId }}
        >
          <AccountLabel
            label={label}
            balance={balance}
            budget={budget}
            icon={icon}
          />
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
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
