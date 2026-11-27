import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { CopyIcon, TriangleAlertIcon } from 'lucide-react'
import { toast } from 'sonner'
import { ProviderGrid } from '#/components/providers/provider-grid'
import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { $api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { useKeymap } from '#/lib/preferences'

export const Route = createFileRoute('/_app/settings/oidc-providers')({
  staticData: { crumb: '第三方登入', section: '設定', wide: true },
  // Only for the UI; the API refuses non-admins on its own.
  beforeLoad: ({ context }) => {
    if (!context.user.isAdmin) throw redirect({ to: '/' })
  },
  component: OidcProvidersPage,
})

// The instance's login providers (ADR-046, ADR-125, ADR-126): a grid saved
// with :w, a new line started from a template.
function OidcProvidersPage() {
  const queryClient = useQueryClient()
  const keymap = useKeymap()
  const options = $api.queryOptions('get', '/oidc-providers')
  // The grid owns the lines once loaded; it reloads them after :w.
  const list = useQuery({
    ...options,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  async function reload() {
    await queryClient.invalidateQueries({
      queryKey: $api.queryOptions('get', '/auth/oidc/providers').queryKey,
    })
    const fresh = await queryClient.fetchQuery({ ...options, staleTime: 0 })
    return fresh.items
  }

  async function copyCallback() {
    if (!list.data) return
    await navigator.clipboard.writeText(list.data.callbackUrl)
    toast.success('已複製回呼網址')
  }

  if (list.isError) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {apiErrorMessage(list.error)}
      </p>
    )
  }
  if (!list.data) {
    return <p className="text-sm text-muted-foreground">載入中…</p>
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-semibold">第三方登入</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          用 Google、GitHub、Discord，或任何 OpenID Connect 服務（Authentik、
          Keycloak、Authelia…）登入。使用者先用密碼登入，再到「個人資料」連結自己的帳號，之後才能用它登入。在服務那邊建立應用程式時，重新導向
          URI 填這個回呼網址：
        </p>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <code
            className="min-w-0 rounded-sm bg-muted px-2 py-1 text-sm break-all text-foreground"
            data-testid="callback-url"
          >
            {list.data.callbackUrl}
          </code>
          <Button variant="outline" size="sm" onClick={copyCallback}>
            <CopyIcon />
            複製
          </Button>
        </div>
      </div>

      {!list.data.encryptionConfigured && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>伺服器尚未設定加密金鑰</AlertTitle>
          <AlertDescription>
            請設定環境變數 FACTUAL_ENCRYPTION_KEY（openssl rand -base64
            32）後重新啟動，否則無法使用第三方登入。
          </AlertDescription>
        </Alert>
      )}

      <ProviderGrid
        providers={list.data.items}
        keymap={keymap}
        reload={reload}
      />
    </div>
  )
}
