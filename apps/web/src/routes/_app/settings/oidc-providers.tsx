import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { CopyIcon, InfoIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '#/components/section'
import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
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
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Switch } from '#/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import { $api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import type { Schemas } from '#/lib/api'

type Provider = Schemas['OidcProvider']
type ProviderInput = Schemas['OidcProviderInput']

export const Route = createFileRoute('/_app/settings/oidc-providers')({
  staticData: { crumb: '第三方登入', section: '設定' },
  // Only for the UI; the API refuses non-admins on its own.
  beforeLoad: ({ context }) => {
    if (!context.user.isAdmin) throw redirect({ to: '/' })
  },
  component: OidcProvidersPage,
})

const DEFAULT_SCOPES = 'openid email profile'

const emptyInput: ProviderInput = {
  code: '',
  name: '',
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: DEFAULT_SCOPES,
  sort: 0,
  enabled: true,
  remark: '',
}

function OidcProvidersPage() {
  const queryClient = useQueryClient()
  const list = $api.useQuery('get', '/oidc-providers')
  const listKey = $api.queryOptions('get', '/oidc-providers').queryKey

  // `null` = closed, `'new'` = creating, otherwise the provider being edited.
  const [editing, setEditing] = useState<Provider | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Provider | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: listKey })

  const remove = $api.useMutation('delete', '/oidc-providers/{id}', {
    onSuccess: async () => {
      toast.success('登入方式已刪除')
      setDeleting(null)
      await refresh()
    },
    onError: (e) => {
      toast.error(apiErrorMessage(e))
      setDeleting(null)
    },
  })

  async function copyCallback() {
    if (!list.data) return
    await navigator.clipboard.writeText(list.data.callbackUrl)
    toast.success('已複製回呼網址')
  }

  const items = list.data?.items ?? []

  return (
    <div className="space-y-6">
      <PageHeader title="第三方登入">
        <Button onClick={() => setEditing('new')}>
          <PlusIcon />
          新增登入方式
        </Button>
      </PageHeader>

      {list.data && !list.data.encryptionConfigured && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>伺服器尚未設定加密金鑰</AlertTitle>
          <AlertDescription>
            請設定環境變數 FACTUAL_ENCRYPTION_KEY（openssl rand -base64
            32）後重新啟動，否則無法使用第三方登入。
          </AlertDescription>
        </Alert>
      )}

      <Alert>
        <InfoIcon />
        <AlertTitle>支援任何 OpenID Connect 服務</AlertTitle>
        <AlertDescription>
          <p>
            例如 Google、Microsoft Entra ID、Keycloak、Authentik、Pocket
            ID。在服務端建立應用程式時，把下方的回呼網址加入允許的 Redirect
            URI。使用者需先用密碼登入，再到「個人資料」連結自己的帳號，之後才能用第三方登入。
          </p>
          {list.data && (
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
          )}
        </AlertDescription>
      </Alert>

      {list.isError && (
        <p className="text-sm text-destructive" role="alert">
          {apiErrorMessage(list.error)}
        </p>
      )}

      <div className="border-y">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名稱</TableHead>
              <TableHead>代碼</TableHead>
              <TableHead>Issuer</TableHead>
              <TableHead>Client ID</TableHead>
              <TableHead>狀態</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="h-24 text-center text-muted-foreground"
                >
                  {list.isPending ? '載入中…' : '尚未設定任何第三方登入'}
                </TableCell>
              </TableRow>
            )}
            {items.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell>
                  <code className="text-sm">{p.code}</code>
                </TableCell>
                <TableCell>
                  <span className="block max-w-xs truncate" title={p.issuer}>
                    {p.issuer}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="block max-w-40 truncate" title={p.clientId}>
                    {p.clientId}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant={p.enabled ? 'secondary' : 'outline'}>
                    {p.enabled ? '啟用' : '停用'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(p)}
                    >
                      編輯
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setDeleting(p)}
                    >
                      刪除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {editing !== null && (
        <ProviderDialog
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await refresh()
          }}
        />
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>刪除登入方式</AlertDialogTitle>
            <AlertDialogDescription>
              確定要刪除「{deleting?.name}
              」嗎？已連結此方式的使用者將無法再用它登入。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={(event) => {
                event.preventDefault()
                if (deleting) {
                  remove.mutate({ params: { path: { id: deleting.id } } })
                }
              }}
            >
              刪除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

type FieldErrors = Partial<Record<keyof ProviderInput, string>>

function validate(input: ProviderInput): FieldErrors {
  const errors: FieldErrors = {}
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(input.code)) {
    errors.code = '小寫英文開頭，2–32 個小寫英數字、底線或連字號'
  }
  if (!input.name.trim()) errors.name = '請輸入名稱'
  if (!/^https?:\/\/\S+$/.test(input.issuer)) {
    errors.issuer = '請輸入 Issuer 網址'
  }
  if (!input.clientId.trim()) errors.clientId = '請輸入 Client ID'
  return errors
}

function ProviderDialog({
  provider,
  onClose,
  onSaved,
}: {
  /** The provider to edit, or `null` to create one. */
  provider: Provider | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  // An empty secret on edit keeps the stored one.
  const [form, setForm] = useState<ProviderInput>(
    provider
      ? {
          code: provider.code,
          name: provider.name,
          issuer: provider.issuer,
          clientId: provider.clientId,
          clientSecret: '',
          scopes: provider.scopes,
          sort: provider.sort,
          enabled: provider.enabled,
          remark: provider.remark,
        }
      : emptyInput,
  )
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState('')

  const options = {
    onSuccess: async () => {
      toast.success(provider ? '登入方式已更新' : '登入方式已新增')
      await onSaved()
    },
    onError: (e: unknown) => setFailure(apiErrorMessage(e)),
  }
  const create = $api.useMutation('post', '/oidc-providers', options)
  const update = $api.useMutation('put', '/oidc-providers/{id}', options)
  const saving = create.isPending || update.isPending

  function set<TKey extends keyof ProviderInput>(
    key: TKey,
    value: ProviderInput[TKey],
  ) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure('')
    const found = validate(form)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    if (provider) {
      update.mutate({ params: { path: { id: provider.id } }, body: form })
    } else {
      create.mutate({ body: form })
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {provider ? '編輯登入方式' : '新增登入方式'}
          </DialogTitle>
          <DialogDescription>
            儲存時會讀取 Issuer 的 /.well-known/openid-configuration 來驗證。
          </DialogDescription>
        </DialogHeader>

        <form id="oidc-form" className="space-y-4" onSubmit={onSubmit}>
          <div className="grid grid-cols-2 gap-4">
            <Field
              id="oidc-name"
              label="名稱"
              help="顯示在登入按鈕上"
              error={errors.name}
            >
              <Input
                id="oidc-name"
                placeholder="公司帳號"
                value={form.name}
                maxLength={64}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
            <Field
              id="oidc-code"
              label="代碼"
              help="用在網址中，例如 google"
              error={errors.code}
            >
              <Input
                id="oidc-code"
                value={form.code}
                maxLength={32}
                onChange={(e) => set('code', e.target.value)}
              />
            </Field>
          </div>
          <Field id="oidc-issuer" label="Issuer" error={errors.issuer}>
            <Input
              id="oidc-issuer"
              placeholder="https://accounts.google.com"
              value={form.issuer}
              maxLength={255}
              onChange={(e) => set('issuer', e.target.value)}
            />
          </Field>
          <Field id="oidc-client-id" label="Client ID" error={errors.clientId}>
            <Input
              id="oidc-client-id"
              value={form.clientId}
              maxLength={255}
              onChange={(e) => set('clientId', e.target.value)}
            />
          </Field>
          <Field
            id="oidc-client-secret"
            label="Client Secret"
            help={
              provider?.hasSecret
                ? '已儲存密鑰；留空表示不變更'
                : '加密後儲存，之後不會再顯示'
            }
          >
            <Input
              id="oidc-client-secret"
              type="password"
              autoComplete="new-password"
              value={form.clientSecret}
              maxLength={2048}
              onChange={(e) => set('clientSecret', e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field id="oidc-scopes" label="Scopes">
              <Input
                id="oidc-scopes"
                value={form.scopes}
                maxLength={255}
                onChange={(e) => set('scopes', e.target.value)}
              />
            </Field>
            <Field id="oidc-sort" label="排序" help="數字小的排在前面">
              <Input
                id="oidc-sort"
                type="number"
                value={form.sort}
                onChange={(e) => set('sort', Number(e.target.value) || 0)}
              />
            </Field>
          </div>
          <Field id="oidc-remark" label="備註">
            <Input
              id="oidc-remark"
              value={form.remark}
              maxLength={255}
              onChange={(e) => set('remark', e.target.value)}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Switch
              id="oidc-enabled"
              checked={form.enabled}
              onCheckedChange={(checked) => set('enabled', checked)}
            />
            <Label htmlFor="oidc-enabled">啟用（顯示在登入頁）</Label>
          </div>
          {failure && (
            <p className="text-sm text-destructive" role="alert">
              {failure}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="oidc-form" disabled={saving}>
            {saving ? '儲存中…' : '儲存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string
  label: string
  help?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : (
        help && <p className="text-xs text-muted-foreground">{help}</p>
      )}
    </div>
  )
}
