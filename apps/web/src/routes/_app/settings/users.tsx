import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { UserGrid } from '#/components/users/user-grid'
import { $api, api } from '#/lib/api'
import { apiErrorMessage, errorCodeMessage } from '#/lib/apiError'
import { can, meQueryOptions } from '#/lib/auth'
import { useKeymap } from '#/lib/preferences'
import { accountLines } from '#/lib/users'
import type { Message, UsersData } from '#/components/users/user-grid'
import type { CurrentUser } from '#/lib/auth'

interface UsersSearch {
  /** The provider an identity was just linked with (the link flow's return). */
  linked?: string
  /** An error code from the link flow. */
  error?: string
}

export const Route = createFileRoute('/_app/settings/users')({
  staticData: { crumb: '使用者', section: '設定', wide: true },
  validateSearch: (search: Record<string, unknown>): UsersSearch => ({
    linked: typeof search.linked === 'string' ? search.linked : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  component: UsersPage,
})

/**
 * Everything the page shows. Who may manage users gets them all and the
 * links; anyone else only themselves, from /me. Both get their own sign-in
 * accounts.
 */
async function loadUsers(me: CurrentUser): Promise<UsersData> {
  const [page, identities, providers] = await Promise.all([
    can(me, 'manage_users')
      ? api.GET('/users').then((r) => r.data)
      : Promise.resolve(undefined),
    api.GET('/me/identities').then((r) => r.data ?? []),
    api.GET('/auth/oidc/providers').then((r) => r.data ?? []),
  ])
  const users = page?.users ?? [
    {
      id: me.id,
      username: me.username,
      displayName: me.displayName,
      role: me.role,
      active: true,
      hasPassword: me.hasPassword,
      identities: identities.length,
      lastLoginAt: null,
      createdAt: '',
    },
  ]
  return {
    users,
    links: page?.links ?? [],
    accounts: accountLines(providers, identities),
    hasPassword: me.hasPassword,
  }
}

// The users and the caller's own account in one grid (ADR-131, ADR-132,
// ADR-136): roles, disabling, links to join or to reset a password, and the
// caller's username, display name, password and sign-in accounts.
function UsersPage() {
  const { user } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const queryClient = useQueryClient()
  const keymap = useKeymap()
  const manage = can(user, 'manage_users')
  // The grid owns the lines once loaded; it reloads them after :w.
  const data = useQuery({
    queryKey: ['users-page', user.id],
    queryFn: () => loadUsers(user),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  // The link flow comes back here with ?linked=<code> or ?error=<code>.
  const [notice] = useState<Message | null>(() =>
    search.linked
      ? { text: '已連結第三方帳號', tone: 'info' }
      : search.error
        ? { text: errorCodeMessage(search.error), tone: 'error' }
        : null,
  )
  useEffect(() => {
    if (search.linked || search.error)
      void navigate({ search: {}, replace: true })
  }, [search.linked, search.error, navigate])

  async function reload(): Promise<UsersData> {
    // A new name or password shows elsewhere too (the sidebar, the status line).
    const me = await queryClient.fetchQuery({ ...meQueryOptions, staleTime: 0 })
    void queryClient.invalidateQueries({
      queryKey: $api.queryOptions('get', '/me/identities').queryKey,
    })
    return loadUsers(me ?? user)
  }

  if (data.isError) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {apiErrorMessage(data.error)}
      </p>
    )
  }
  if (!data.data) {
    return <p className="text-sm text-muted-foreground">載入中…</p>
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-semibold">
          {manage ? '使用者' : '我的帳號'}
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          自己那一列可以直接改帳號（登入用）和顯示名稱；底下的「密碼」和「第三方帳號」按
          za 展開，改好按 :w 儲存。
          {manage &&
            ' 只有收到邀請連結的人能註冊：按 o 新增一條邀請連結，:w 儲存後會自動複製，之後也能按「複製連結」再複製；連結用過一次就失效，7 天後也會失效。忘記密碼的人：游標移到他那一列打 :reset。停用（x）的人會被登出、不能再登入。'}
        </p>
      </div>
      <UserGrid
        me={user.id}
        manage={manage}
        data={data.data}
        keymap={keymap}
        notice={notice}
        reload={reload}
      />
    </div>
  )
}
