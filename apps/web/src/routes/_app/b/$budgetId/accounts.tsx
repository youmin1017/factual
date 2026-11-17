import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { EllipsisIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Amount } from '#/components/amount'
import { ConfirmDialog, NameDialog } from '#/components/dialogs'
import { PageHeader } from '#/components/section'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { Switch } from '#/components/ui/switch'
import { $api, api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import {
  accountKindLabel,
  accountKinds,
  accountsQuery,
  onBudgetChoice,
  summaryQuery,
} from '#/lib/budget'
import { parseAmount } from '#/lib/money'
import type { Account, AccountKind, Budget } from '#/lib/budget'

export const Route = createFileRoute('/_app/b/$budgetId/accounts')({
  staticData: { crumb: '帳戶' },
  component: AccountsPage,
})

function AccountsPage() {
  const { budget } = Route.useRouteContext()
  const accounts = useQuery(accountsQuery(budget.id))
  const summary = useQuery(summaryQuery(budget.id))
  const [creating, setCreating] = useState(false)
  const canManage = budget.role === 'owner'

  const all = accounts.data ?? []
  const open = all.filter((a) => !a.closed)
  const groups = [
    {
      title: '預算內',
      description: '這些帳戶的錢會分配到各類別的預算。',
      items: open.filter((a) => a.onBudget),
    },
    {
      title: '追蹤',
      description: '只記錄餘額，不計入預算，例如貸款和投資。',
      items: open.filter((a) => !a.onBudget),
    },
    {
      title: '已關閉',
      description: undefined,
      items: all.filter((a) => a.closed),
    },
  ].filter((g) => g.items.length > 0)

  return (
    <div>
      <PageHeader title="帳戶">
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            新增帳戶
          </Button>
        )}
      </PageHeader>

      {summary.data && all.length > 0 && (
        <dl className="grid grid-cols-1 border-b sm:grid-cols-3 sm:divide-x">
          <Total
            label="資金池"
            help="還沒分配到預算的錢"
            value={summary.data.pool}
            budget={budget}
          />
          <Total
            label="預算內帳戶"
            value={summary.data.onBudgetBalance}
            budget={budget}
          />
          <Total
            label="追蹤帳戶"
            value={summary.data.offBudgetBalance}
            budget={budget}
          />
        </dl>
      )}

      {accounts.isPending && (
        <p className="py-8 text-sm text-muted-foreground">載入中…</p>
      )}
      {accounts.isError && (
        <p className="py-8 text-sm text-destructive" role="alert">
          {apiErrorMessage(accounts.error)}
        </p>
      )}
      {accounts.isSuccess && all.length === 0 && (
        <div className="max-w-md space-y-4 py-10">
          <p className="leading-relaxed text-muted-foreground">
            還沒有帳戶。先加入你的銀行帳戶、信用卡和現金，填入今天的餘額，預算就從這些錢開始。
          </p>
          {canManage && (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon />
              新增第一個帳戶
            </Button>
          )}
        </div>
      )}

      {groups.map((group) => (
        <section key={group.title} className="border-b py-6 last:border-b-0">
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 className="font-medium">{group.title}</h2>
            {group.description && (
              <p className="hidden text-sm text-muted-foreground sm:block">
                {group.description}
              </p>
            )}
          </div>
          <ul className="divide-y divide-rule border-y border-rule">
            {group.items.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                siblings={group.items}
                all={all}
                budget={budget}
                canManage={canManage}
              />
            ))}
          </ul>
        </section>
      ))}

      {creating && (
        <CreateAccountDialog
          budget={budget}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  )
}

function Total({
  label,
  help,
  value,
  budget,
}: {
  label: string
  help?: string
  value: number
  budget: Budget
}) {
  return (
    <div className="py-4 sm:px-4 sm:first:pl-0">
      <dt className="text-sm text-muted-foreground" title={help}>
        {label}
      </dt>
      <dd className="mt-1 text-xl">
        <Amount value={value} minorUnits={budget.minorUnits} />
      </dd>
    </div>
  )
}

function useInvalidateAccounts(budgetId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: accountsQuery(budgetId).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: summaryQuery(budgetId).queryKey,
      }),
    ])
}

function AccountRow({
  account,
  siblings,
  all,
  budget,
  canManage,
}: {
  account: Account
  siblings: Array<Account>
  all: Array<Account>
  budget: Budget
  canManage: boolean
}) {
  const invalidate = useInvalidateAccounts(budget.id)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const path = {
    params: { path: { budgetId: budget.id, accountId: account.id } },
  }

  const update = $api.useMutation(
    'put',
    '/budgets/{budgetId}/accounts/{accountId}',
    {
      onSuccess: invalidate,
      onError: (e) => toast.error(apiErrorMessage(e)),
    },
  )
  const remove = $api.useMutation(
    'delete',
    '/budgets/{budgetId}/accounts/{accountId}',
    {
      onSuccess: async () => {
        toast.success(`已刪除「${account.name}」`)
        setDeleting(false)
        await invalidate()
      },
      onError: (e) => {
        toast.error(apiErrorMessage(e))
        setDeleting(false)
      },
    },
  )
  const reorder = $api.useMutation(
    'put',
    '/budgets/{budgetId}/accounts/order',
    {
      onSuccess: invalidate,
      onError: (e) => toast.error(apiErrorMessage(e)),
    },
  )

  // Swap with the neighbour in this group and send the whole order.
  function move(offset: -1 | 1) {
    const i = siblings.findIndex((a) => a.id === account.id) + offset
    // `at` would wrap around at -1.
    const other = i >= 0 ? siblings.at(i) : undefined
    if (!other) return
    const ids = all.map((a) => a.id)
    const a = ids.indexOf(account.id)
    const b = ids.indexOf(other.id)
    ;[ids[a], ids[b]] = [ids[b], ids[a]]
    reorder.mutate({ params: { path: { budgetId: budget.id } }, body: { ids } })
  }

  const index = siblings.findIndex((a) => a.id === account.id)

  return (
    <li
      className="flex items-center gap-4 py-2.5"
      data-testid={`account-${account.name}`}
    >
      <div className="min-w-0 flex-1">
        <p className={account.closed ? 'text-muted-foreground' : ''}>
          {account.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {accountKindLabel(account.kind)}
        </p>
      </div>
      <Amount
        value={account.balance}
        minorUnits={budget.minorUnits}
        className="text-right"
      />
      {canManage && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${account.name} 的動作`}
            >
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              重新命名
            </DropdownMenuItem>
            <DropdownMenuItem disabled={index <= 0} onSelect={() => move(-1)}>
              上移
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index === siblings.length - 1}
              onSelect={() => move(1)}
            >
              下移
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                update.mutate({
                  ...path,
                  body: { name: account.name, closed: !account.closed },
                })
              }
            >
              {account.closed ? '重新開啟' : '關閉帳戶'}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={account.hasActivity}
              onSelect={() => setDeleting(true)}
            >
              刪除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {renaming && (
        <NameDialog
          title="重新命名帳戶"
          initial={account.name}
          onClose={() => setRenaming(false)}
          onSave={async (name) => {
            const { error } = await api.PUT(
              '/budgets/{budgetId}/accounts/{accountId}',
              {
                ...path,
                body: { name, closed: account.closed },
              },
            )
            if (error) return apiErrorMessage(error)
            setRenaming(false)
            await invalidate()
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        title="刪除帳戶"
        description={`確定要刪除「${account.name}」嗎？它的期初餘額也會一起刪除。`}
        confirmLabel="刪除"
        pending={remove.isPending}
        onConfirm={() => remove.mutate(path)}
        onClose={() => setDeleting(false)}
      />
    </li>
  )
}

function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function CreateAccountDialog({
  budget,
  onClose,
}: {
  budget: Budget
  onClose: () => void
}) {
  const invalidate = useInvalidateAccounts(budget.id)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AccountKind>('bank')
  const [onBudget, setOnBudget] = useState(true)
  const [balance, setBalance] = useState('')
  const [date, setDate] = useState(today)
  const [error, setError] = useState('')

  const kindInfo = accountKinds.find((k) => k.value === kind)
  const debt = kindInfo?.debt ?? false
  const choice = onBudgetChoice(kind)

  const create = $api.useMutation('post', '/budgets/{budgetId}/accounts', {
    onSuccess: async (account) => {
      toast.success(`已新增「${account.name}」`)
      await invalidate()
      onClose()
    },
    onError: (e) => setError(apiErrorMessage(e)),
  })

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (!name.trim()) {
      setError('請輸入帳戶名稱')
      return
    }
    const amount = parseAmount(balance, budget.minorUnits)
    if (amount === null) {
      setError(
        budget.minorUnits === 0
          ? '餘額請輸入整數，例如 12000'
          : `餘額最多 ${budget.minorUnits} 位小數`,
      )
      return
    }
    create.mutate({
      params: { path: { budgetId: budget.id } },
      body: {
        name: name.trim(),
        kind,
        onBudget: choice === 'choose' ? onBudget : choice,
        // Debts are typed as the amount owed and stored as a negative balance.
        openingBalance: debt ? -amount : amount,
        openingDate: date,
      },
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新增帳戶</DialogTitle>
          <DialogDescription>
            填入某一天的實際餘額，之後的交易從那天開始記。
          </DialogDescription>
        </DialogHeader>

        <form id="account-form" className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="account-name">名稱</Label>
            <Input
              id="account-name"
              placeholder="台新活存"
              value={name}
              maxLength={64}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-kind">類型</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as AccountKind)}
            >
              <SelectTrigger id="account-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accountKinds.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="account-balance">
                {debt ? '目前欠款' : '目前餘額'}
              </Label>
              <Input
                id="account-balance"
                inputMode="decimal"
                className="font-mono"
                placeholder="0"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="account-date">日期</Label>
              <Input
                id="account-date"
                type="date"
                className="font-mono"
                value={date}
                required
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          </div>
          {choice === 'choose' ? (
            <div className="flex items-start gap-3">
              <Switch
                id="account-on-budget"
                checked={onBudget}
                onCheckedChange={setOnBudget}
                className="mt-0.5"
              />
              <div className="space-y-1">
                <Label htmlFor="account-on-budget">計入預算</Label>
                <p className="text-xs text-muted-foreground">
                  關閉時只追蹤餘額，例如不打算動用的定存。
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {choice
                ? '信用卡一定計入預算：刷卡時就從類別預算扣款，繳卡費時不再影響預算。'
                : `${kindInfo?.label}只追蹤餘額，不計入預算；還款時的本金從類別預算支出。`}
            </p>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="account-form" disabled={create.isPending}>
            {create.isPending ? '新增中…' : '新增帳戶'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
