import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  LinkPage,
  expiresText,
  useEnterApp,
  useLink,
} from '#/components/link-page'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { $api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'

export const Route = createFileRoute('/reset/$token')({
  component: ResetPage,
})

// Setting a new password through a reset link the admin made (ADR-132);
// every other session of the user ends.
function ResetPage() {
  const { token } = Route.useParams()
  const link = useLink(token)
  const enter = useEnterApp()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')

  const reset = $api.useMutation('post', '/auth/reset', {
    onSuccess: enter,
    onError: (e) => setError(apiErrorMessage(e)),
  })

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (password.length < 8) return setError('密碼至少 8 個字元')
    if (password !== again) return setError('兩次輸入的密碼不一樣')
    reset.mutate({ body: { token, password } })
  }

  return (
    <LinkPage
      title="設定新密碼"
      link={link}
      error={error}
      intro={
        link.data && (
          <>
            帳號{' '}
            <span className="font-mono text-foreground">
              {link.data.username}
            </span>
            。設好之後其他裝置都會登出。這個連結只能用一次，
            {expiresText(link.data.expiresAt)} 前有效。
          </>
        )
      }
    >
      {(l) => (
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          {/* For password managers: which account this password is for. */}
          <input
            type="text"
            autoComplete="username"
            value={l.username}
            readOnly
            hidden
          />
          <div className="space-y-2">
            <Label htmlFor="password">新密碼</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              autoFocus
              required
              minLength={8}
              maxLength={256}
              className="font-mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="again">再輸入一次</Label>
            <Input
              id="again"
              type="password"
              autoComplete="new-password"
              required
              maxLength={256}
              className="font-mono"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={reset.isPending}>
            {reset.isPending ? '設定中…' : '設定密碼並登入'}
          </Button>
        </form>
      )}
    </LinkPage>
  )
}
