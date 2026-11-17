import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PageHeader, Section } from '#/components/section'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#/components/ui/alert-dialog'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { $api } from '#/lib/api'
import { apiErrorMessage, errorCodeMessage } from '#/lib/apiError'
import { meQueryOptions, oidcLinkUrl } from '#/lib/auth'
import { formatDateTime } from '#/lib/format'
import type { Schemas } from '#/lib/api'

type LinkedIdentity = Schemas['LinkedIdentity']

interface ProfileSearch {
  /** Provider code the link flow just linked. */
  linked?: string
  /** Error code from the link flow. */
  error?: string
}

export const Route = createFileRoute('/_app/profile')({
  staticData: { crumb: '個人資料', section: '設定' },
  validateSearch: (search: Record<string, unknown>): ProfileSearch => ({
    linked: typeof search.linked === 'string' ? search.linked : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  component: ProfilePage,
})

function ProfilePage() {
  const { user } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  // The link flow returns here with ?linked=<code> or ?error=<code>.
  useEffect(() => {
    if (!search.linked && !search.error) return
    // The id keeps a re-run of this effect from showing the toast twice.
    if (search.linked) {
      toast.success('已連結第三方帳號', { id: 'oidc-link' })
    }
    if (search.error) {
      toast.error(errorCodeMessage(search.error), { id: 'oidc-link' })
    }
    void navigate({ search: {}, replace: true })
  }, [search.linked, search.error, navigate])

  return (
    <div>
      <PageHeader title="個人資料" />

      <Section title="帳號">
        <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">帳號</dt>
          <dd className="font-mono">{user.username}</dd>
          <dt className="text-muted-foreground">顯示名稱</dt>
          <dd>{user.displayName}</dd>
          <dt className="text-muted-foreground">角色</dt>
          <dd>{user.isAdmin ? '站台管理員' : '一般使用者'}</dd>
        </dl>
      </Section>

      <LinkedIdentities hasPassword={user.hasPassword} />
      <PasswordForm hasPassword={user.hasPassword} />
    </div>
  )
}

function LinkedIdentities({ hasPassword }: { hasPassword: boolean }) {
  const queryClient = useQueryClient()
  const providers = $api.useQuery('get', '/auth/oidc/providers')
  const identities = $api.useQuery('get', '/me/identities')
  const [unlinking, setUnlinking] = useState<LinkedIdentity | null>(null)

  const unlink = $api.useMutation('delete', '/me/identities/{id}', {
    onSuccess: async () => {
      toast.success('已解除連結')
      setUnlinking(null)
      await queryClient.invalidateQueries({
        queryKey: $api.queryOptions('get', '/me/identities').queryKey,
      })
    },
    onError: (e) => {
      toast.error(apiErrorMessage(e))
      setUnlinking(null)
    },
  })

  // Every enabled provider, plus identities whose provider was disabled since.
  const mine = identities.data ?? []
  const rows = [
    ...(providers.data ?? []).map((p) => ({
      code: p.code,
      name: p.name,
      enabled: true,
      identity: mine.find((i) => i.providerCode === p.code),
    })),
    ...mine
      .filter((i) => !providers.data?.some((p) => p.code === i.providerCode))
      .map((i) => ({
        code: i.providerCode,
        name: i.providerName,
        enabled: false,
        identity: i,
      })),
  ]
  const loading = providers.isPending || identities.isPending

  return (
    <Section
      title="第三方登入"
      description={
        hasPassword
          ? '連結之後就能用該帳號直接登入。'
          : '連結之後就能用該帳號直接登入。你尚未設定密碼，至少要保留一種登入方式。'
      }
    >
      <>
        {loading && <p className="text-sm text-muted-foreground">載入中…</p>}
        {!loading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            管理員尚未設定任何第三方登入。
          </p>
        )}
        <ul className="divide-y border-y empty:hidden">
          {rows.map((row) => (
            <li
              key={row.code}
              className="flex items-center justify-between gap-4 py-3"
              data-testid={`identity-${row.code}`}
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {row.name}
                  {!row.enabled && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      已停用
                    </span>
                  )}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {row.identity?.email ||
                    (row.identity ? '已連結' : '尚未連結')}
                </p>
                {row.identity && (
                  <p className="text-xs text-muted-foreground">
                    {row.identity.lastLoginAt
                      ? `上次登入 ${formatDateTime(row.identity.lastLoginAt)}`
                      : '尚未用來登入'}
                  </p>
                )}
              </div>
              {row.identity ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setUnlinking(row.identity ?? null)}
                >
                  解除連結
                </Button>
              ) : (
                <Button asChild size="sm">
                  <a href={oidcLinkUrl(row.code)}>連結</a>
                </Button>
              )}
            </li>
          ))}
        </ul>
      </>

      <AlertDialog
        open={unlinking !== null}
        onOpenChange={(open) => !open && setUnlinking(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>解除連結</AlertDialogTitle>
            <AlertDialogDescription>
              確定要解除「{unlinking?.providerName}
              」的連結嗎？之後將無法用它登入。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={unlink.isPending}
              onClick={(event) => {
                event.preventDefault()
                if (unlinking) {
                  unlink.mutate({ params: { path: { id: unlinking.id } } })
                }
              }}
            >
              解除連結
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  )
}

const MIN_PASSWORD_LENGTH = 8

function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const queryClient = useQueryClient()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')

  const change = $api.useMutation('put', '/me/password', {
    onSuccess: async () => {
      toast.success(hasPassword ? '密碼已變更' : '密碼已設定')
      setCurrent('')
      setNext('')
      setConfirm('')
      await queryClient.invalidateQueries({ queryKey: meQueryOptions.queryKey })
    },
    onError: (e) => setError(apiErrorMessage(e)),
  })

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`新密碼至少要 ${MIN_PASSWORD_LENGTH} 個字元`)
      return
    }
    if (next !== confirm) {
      setError('兩次輸入的新密碼不一致')
      return
    }
    change.mutate({ body: { currentPassword: current, newPassword: next } })
  }

  return (
    <Section
      title={hasPassword ? '變更密碼' : '設定密碼'}
      description={
        hasPassword
          ? '變更後，其他裝置上的登入會被登出。'
          : '設定密碼後，除了第三方登入也能用帳號密碼登入。'
      }
    >
      <form className="max-w-sm space-y-4" onSubmit={onSubmit}>
        {hasPassword && (
          <div className="space-y-2">
            <Label htmlFor="current-password">目前的密碼</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="new-password">新密碼</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-password">再次輸入新密碼</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={change.isPending}>
          {change.isPending ? '儲存中…' : '儲存'}
        </Button>
      </form>
    </Section>
  )
}
