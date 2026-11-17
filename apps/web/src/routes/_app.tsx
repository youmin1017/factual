import { useQueryClient } from '@tanstack/react-query'
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { ChevronsUpDownIcon } from 'lucide-react'
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
import type { CurrentUser } from '#/lib/auth'

// Everything under this layout needs a session; /login is the only page
// outside it. The check is only for the UI: the API enforces access itself.
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(meQueryOptions)
    if (!user) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    return { user }
  },
  component: AppLayout,
})

// The frame of an editor: places on the left, the page in the middle, the
// status line along the bottom. On narrow screens the places move to the top.
function AppLayout() {
  const { user } = Route.useRouteContext()

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
            <div className="flex gap-1 md:flex-col">
              <NavLink to="/" exact>
                總覽
              </NavLink>
            </div>
            <div className="flex items-center gap-1 md:flex-col md:items-stretch">
              <p className="hidden px-2 pb-1 text-xs text-muted-foreground md:block">
                設定
              </p>
              <NavLink to="/profile">個人資料</NavLink>
              {user.isAdmin && (
                <NavLink to="/settings/oidc-providers">第三方登入</NavLink>
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

function NavLink({
  to,
  exact = false,
  children,
}: {
  to: '/' | '/profile' | '/settings/oidc-providers'
  exact?: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact }}
      // The kraft bar marks the current place, like a cursor in the margin.
      // The router sets data-status="active" on the current link.
      className="rounded-md border-l-2 border-transparent px-2 py-1.5 whitespace-nowrap text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:rounded-l-none data-[status=active]:border-kraft data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-accent-foreground"
    >
      {children}
    </Link>
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
