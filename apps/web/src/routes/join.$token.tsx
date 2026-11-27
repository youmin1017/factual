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

export const Route = createFileRoute('/join/$token')({
  component: JoinPage,
})

// Registering through a join link (ADR-132): a username, the name others
// see, and a password; the new user is logged in and goes on to make their
// first budget.
function JoinPage() {
  const { token } = Route.useParams()
  const link = useLink(token)
  const enter = useEnterApp()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')

  const join = $api.useMutation('post', '/auth/join', {
    onSuccess: enter,
    onError: (e) => setError(apiErrorMessage(e)),
  })

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (password.length < 8) return setError('密碼至少 8 個字元')
    if (password !== again) return setError('兩次輸入的密碼不一樣')
    join.mutate({
      body: {
        token,
        username: username.trim(),
        displayName: displayName.trim() || username.trim(),
        password,
      },
    })
  }

  return (
    <LinkPage
      title="加入 Factual"
      link={link}
      error={error}
      intro={
        link.data && (
          <>
            你受邀加入。這個連結只能用一次，{expiresText(link.data.expiresAt)}{' '}
            前有效。
          </>
        )
      }
    >
      {() => (
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="username">帳號</Label>
            <Input
              id="username"
              autoComplete="username"
              autoFocus
              required
              maxLength={64}
              className="font-mono"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              登入時輸入的名稱，不能有空白；朋友也用它找到你。
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="display-name">顯示名稱</Label>
            <Input
              id="display-name"
              autoComplete="nickname"
              maxLength={64}
              placeholder={username.trim() || undefined}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              其他人在分帳裡看到的名字；不填就用帳號。
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">密碼</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={256}
              className="font-mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="again">再輸入一次密碼</Label>
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
          <Button type="submit" className="w-full" disabled={join.isPending}>
            {join.isPending ? '建立中…' : '建立帳號'}
          </Button>
        </form>
      )}
    </LinkPage>
  )
}
