import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { CircleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { BrandIcon } from '#/components/brand-icon'
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
    <main className="relative flex min-h-dvh flex-col md:flex-row">
      {/* A page of the ledger: ruled paper, the margin line, a few entries. */}
      <div className="ledger-paper flex flex-col justify-center px-10 pt-16 pb-8 [--ledger-margin:1.5rem] sm:px-20 sm:[--ledger-margin:4rem] md:flex-1 md:py-16">
        <h1 className="text-5xl leading-[4rem] sm:text-6xl">
          <Wordmark blink />
        </h1>
        <p className="leading-8 text-muted-foreground">
          多人記帳與分帳：預算、信用卡、存錢目標和朋友間的帳。
        </p>
        <SampleEntries />
      </div>

      {/* The form: the first entry to make is who you are. */}
      <div className="flex shrink-0 items-center border-t border-rule bg-card px-10 py-12 sm:px-20 md:w-[28rem] md:border-t-0 md:border-l md:px-12">
        <div className="mx-auto w-full max-w-sm">
          <h2 className="text-xl font-semibold">登入</h2>
          <p className="mt-1 text-sm text-muted-foreground">登入後繼續。</p>

          {error && (
            <Alert variant="destructive" role="alert" className="mt-4">
              <CircleAlertIcon />
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          )}

          <form className="mt-6 space-y-4" onSubmit={onSubmit}>
            <div className="space-y-2">
              <Label htmlFor="username">帳號</Label>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                autoFocus
                required
                maxLength={64}
                className="font-mono"
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
                className="font-mono"
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
                  className="w-full justify-start"
                >
                  <a href={oidcLoginUrl(p.code, target)}>
                    <BrandIcon slug={p.icon} />
                    使用 {p.name} 登入
                  </a>
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
    </main>
  )
}

// What a page of the register looks like, written on the ruled lines.
const sample = [
  { date: '11/05', payee: '全聯', category: '飲食/食材', amount: '-1,730' },
  { date: '11/05', payee: '⇄ 台新活存', category: '—', amount: '5,000' },
  { date: '11/03', payee: '鼎泰豐', category: '飲食/外食', amount: '-2,400' },
  { date: '11/01', payee: '公司', category: '薪資', amount: '52,000' },
]

function SampleEntries() {
  return (
    <div
      aria-hidden="true"
      className="mt-8 hidden max-w-lg font-mono text-sm md:block"
    >
      {sample.map((row) => (
        <div
          key={row.payee}
          className="grid h-8 grid-cols-[3.5rem_1fr_1fr_6rem] items-end pb-1 text-muted-foreground"
        >
          <span>{row.date}</span>
          <span className="truncate text-foreground">{row.payee}</span>
          <span className="truncate">{row.category}</span>
          <span
            className={
              row.amount.startsWith('-')
                ? 'amount text-right text-foreground'
                : 'amount text-right text-positive'
            }
          >
            {row.amount}
          </span>
        </div>
      ))}
    </div>
  )
}
