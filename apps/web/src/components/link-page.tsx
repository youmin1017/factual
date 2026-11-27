import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { CircleAlertIcon } from 'lucide-react'
import { Logo } from '#/components/logo'
import { ThemeToggle } from '#/components/theme'
import { Alert, AlertTitle } from '#/components/ui/alert'
import { Wordmark } from '#/components/wordmark'
import { $api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { meQueryOptions } from '#/lib/auth'
import type { Schemas } from '#/lib/api'
import type { CurrentUser } from '#/lib/auth'

// The pages a one-time link opens (ADR-132): /join/<token> and
// /reset/<token>, laid out as the login page is, ledger paper beside the
// form.

/** The link behind a token, or why it cannot be used. */
export function useLink(token: string) {
  return $api.useQuery(
    'get',
    '/auth/links/{token}',
    { params: { path: { token } } },
    { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
  )
}

/** After a link logged someone in: forget the last user's data and go home. */
export function useEnterApp() {
  const router = useRouter()
  const queryClient = useQueryClient()
  return (user: CurrentUser) => {
    queryClient.clear()
    queryClient.setQueryData(meQueryOptions.queryKey, user)
    router.history.push('/')
  }
}

export function LinkPage({
  title,
  intro,
  link,
  error,
  children,
}: {
  title: string
  intro: React.ReactNode
  link: ReturnType<typeof useLink>
  error: string
  children: (link: Schemas['LinkInfo']) => React.ReactNode
}) {
  // Someone logged in who follows a link becomes the user it makes.
  const me = useQuery(meQueryOptions).data
  return (
    <main className="relative flex min-h-dvh flex-col md:flex-row">
      <div className="ledger-paper flex flex-col justify-center px-10 pt-16 pb-8 [--ledger-margin:1.5rem] sm:px-20 sm:[--ledger-margin:4rem] md:flex-1 md:py-16">
        <h1 className="flex items-center gap-4 text-5xl leading-[4rem] sm:text-6xl">
          <Logo className="size-12 sm:size-14" />
          <Wordmark blink />
        </h1>
        <p className="leading-8 text-muted-foreground">
          多人記帳與分帳：預算、信用卡、存錢目標和朋友間的帳。
        </p>
      </div>

      <div className="flex shrink-0 items-center border-t border-rule bg-card px-10 py-12 sm:px-20 md:w-[28rem] md:border-t-0 md:border-l md:px-12">
        <div className="mx-auto w-full max-w-sm">
          <h2 className="text-xl font-semibold">{title}</h2>
          {link.isPending ? (
            <p className="mt-4 text-sm text-muted-foreground">讀取連結中…</p>
          ) : link.isError ? (
            <Alert variant="destructive" role="alert" className="mt-4">
              <CircleAlertIcon />
              <AlertTitle>{apiErrorMessage(link.error)}</AlertTitle>
            </Alert>
          ) : (
            <>
              <div className="mt-1 text-sm text-muted-foreground">{intro}</div>
              {me && (
                <p className="mt-2 text-sm text-muted-foreground">
                  你現在以 {me.displayName} 登入；完成後會換成這個帳號。
                </p>
              )}
              {error && (
                <Alert variant="destructive" role="alert" className="mt-4">
                  <CircleAlertIcon />
                  <AlertTitle>{error}</AlertTitle>
                </Alert>
              )}
              {children(link.data)}
            </>
          )}
        </div>
      </div>

      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
    </main>
  )
}

/** When the link expires, as people say it. */
export function expiresText(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
