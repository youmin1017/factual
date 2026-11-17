import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { CircleAlertIcon, KeyRoundIcon } from 'lucide-react'
import { useState } from 'react'
import { ThemeToggle } from '#/components/theme'
import { Alert, AlertTitle } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Wordmark } from '#/components/wordmark'
import { $api } from '#/lib/api'
import { apiErrorMessage, errorCodeMessage } from '#/lib/apiError'
import { meQueryOptions, oidcLoginUrl, safeRedirect } from '#/lib/auth'

interface LoginSearch {
  /** App path to return to after logging in. */
  redirect?: string
  /** Error code from an OIDC callback. */
  error?: string
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions)
    if (me) throw redirect({ href: safeRedirect(search.redirect) })
  },
  component: LoginPage,
})

function LoginPage() {
  const search = Route.useSearch()
  const router = useRouter()
  const queryClient = useQueryClient()
  const target = safeRedirect(search.redirect)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  // Errors from an OIDC callback arrive as ?error=<code>.
  const [error, setError] = useState(
    search.error ? errorCodeMessage(search.error) : '',
  )

  // Third-party logins: the browser leaves for the provider and comes back
  // through /api/auth/oidc/callback.
  const providers = $api.useQuery(
    'get',
    '/auth/oidc/providers',
    {},
    { retry: false },
  )

  const login = $api.useMutation('post', '/auth/login', {
    onSuccess: (user) => {
      queryClient.setQueryData(meQueryOptions.queryKey, user)
      router.history.push(target)
    },
    onError: (e) => setError(apiErrorMessage(e)),
  })

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    login.mutate({ body: { username, password } })
  }

  return (
    // A page of the ledger: ruled paper, the margin line, and the first entry
    // to make is who you are.
    <main className="ledger-paper relative flex min-h-dvh flex-col [--ledger-margin:1.5rem] sm:[--ledger-margin:4rem]">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>

      <div className="flex flex-1 items-center px-10 py-16 sm:px-28">
        <div className="w-full max-w-xs">
          <h1 className="text-5xl leading-[4rem] sm:text-6xl">
            <Wordmark blink />
          </h1>
          <p className="leading-8 text-muted-foreground">
            多人記帳與分帳。登入後繼續。
          </p>

          {error && (
            <Alert variant="destructive" role="alert" className="mt-4 bg-card">
              <CircleAlertIcon />
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          )}

          <form className="mt-8 space-y-4" onSubmit={onSubmit}>
            <div className="space-y-2">
              <Label htmlFor="username">帳號</Label>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                autoFocus
                required
                maxLength={64}
                className="bg-card font-mono dark:bg-card"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密碼</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={256}
                className="bg-card font-mono dark:bg-card"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={login.isPending}>
              {login.isPending ? '登入中…' : '登入'}
            </Button>
          </form>

          {providers.data && providers.data.length > 0 && (
            <div className="mt-8 space-y-3 border-t pt-6">
              <p className="text-sm text-muted-foreground">
                或使用已連結的帳號
              </p>
              {providers.data.map((p) => (
                <Button
                  key={p.code}
                  asChild
                  variant="outline"
                  className="w-full justify-start bg-card dark:bg-card"
                >
                  <a href={oidcLoginUrl(p.code, target)}>
                    <KeyRoundIcon />
                    使用 {p.name} 登入
                  </a>
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
