import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { PageHeader } from '#/components/section'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { $api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { budgetsQueryOptions, currencies } from '#/lib/budget'

export const Route = createFileRoute('/_app/setup')({
  staticData: { crumb: '建立帳本' },
  component: SetupPage,
})

function SetupPage() {
  const { user, budgets } = Route.useRouteContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const first = budgets.length === 0

  const [name, setName] = useState(
    first ? `${user.displayName || user.username}的帳本` : '',
  )
  const [currency, setCurrency] = useState('TWD')
  const [starter, setStarter] = useState(true)
  const [error, setError] = useState('')

  const create = $api.useMutation('post', '/budgets', {
    onSuccess: async (budget) => {
      await queryClient.invalidateQueries({
        queryKey: budgetsQueryOptions.queryKey,
      })
      await navigate({
        to: '/b/$budgetId/accounts',
        params: { budgetId: budget.id },
      })
    },
    onError: (e) => setError(apiErrorMessage(e)),
  })

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (!name.trim()) {
      setError('請輸入帳本名稱')
      return
    }
    create.mutate({
      body: { name: name.trim(), currency, starterCategories: starter },
    })
  }

  return (
    <div className="max-w-xl">
      <PageHeader title={first ? '建立你的帳本' : '新增帳本'} />
      <p className="mt-6 leading-relaxed text-muted-foreground">
        帳本記錄你的帳戶、類別和預算。
        {first && '建立之後，先加入你的銀行帳戶、信用卡和現金，再開始記帳。'}
      </p>

      <form className="mt-8 space-y-6" onSubmit={onSubmit}>
        <div className="space-y-2">
          <Label htmlFor="budget-name">名稱</Label>
          <Input
            id="budget-name"
            value={name}
            maxLength={64}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="budget-currency">幣別</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger id="budget-currency" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {currencies.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  <span className="font-mono">{c.code}</span> {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            建立後不能更改。新台幣以「元」記帳，不記角。
          </p>
        </div>

        <div className="flex items-start gap-3">
          <Checkbox
            id="budget-starter"
            checked={starter}
            onCheckedChange={(checked) => setStarter(checked === true)}
            className="mt-0.5"
          />
          <div className="space-y-1">
            <Label htmlFor="budget-starter">附上常用類別</Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              收入、飲食、居住、交通、生活、娛樂和它們的子類別，之後可以改名或刪除。
            </p>
          </div>
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? '建立中…' : '建立帳本'}
        </Button>
      </form>
    </div>
  )
}
