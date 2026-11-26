import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { EllipsisIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog, NameDialog } from '#/components/dialogs'
import { PageHeader } from '#/components/section'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { friendsQuery, homeBudget } from '#/lib/budget'
import { formatAmount } from '#/lib/money'
import { balanceText } from '#/lib/split'
import { cn } from '#/lib/utils'
import type { Friend } from '#/lib/split'

export const Route = createFileRoute('/_app/friends/')({
  staticData: { crumb: '分帳' },
  component: FriendsPage,
})

// Friends to split with (M12, ADR-104): added by name before they have an
// account, each with a friend account in the default budget whose balance
// is what they owe.

function FriendsPage() {
  const { budgets } = Route.useRouteContext()
  const friends = useQuery(friendsQuery)
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<Friend | null>(null)
  const [deleting, setDeleting] = useState<Friend | null>(null)
  const [busy, setBusy] = useState(false)
  const budget = homeBudget(budgets)
  const minorUnits = budget?.minorUnits ?? 0

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: friendsQuery.queryKey })
    // Friend accounts are listed with the budget's accounts.
    if (budget)
      await queryClient.invalidateQueries({
        queryKey: ['get', '/budgets/{budgetId}/accounts'],
      })
  }

  async function remove(friend: Friend) {
    setBusy(true)
    const { error } = await api.DELETE('/friends/{friendId}', {
      params: { path: { friendId: friend.id } },
    })
    setBusy(false)
    setDeleting(null)
    if (error) {
      toast.error(apiErrorMessage(error))
      return
    }
    toast.success(`已移除「${friend.displayName}」`)
    await refresh()
  }

  if (friends.isError) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {apiErrorMessage(friends.error)}
      </p>
    )
  }
  const list = friends.data ?? []
  const owed = list.reduce((sum, f) => sum + Math.max(0, f.balance), 0)
  const owing = list.reduce((sum, f) => sum + Math.min(0, f.balance), 0)

  return (
    <div>
      <PageHeader title="分帳">
        <Button onClick={() => setAdding(true)} disabled={!budget}>
          <PlusIcon />
          新增朋友
        </Button>
      </PageHeader>

      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        朋友還沒有帳號也能先記：輸入名字就好，只有你看得到。每位朋友在「
        {budget?.name ?? '預設帳本'}
        」有一個往來帳戶，餘額就是他欠你（負的是你欠他）多少；你的份照常算進預算。
      </p>

      {!budget ? (
        <p className="mt-6 text-sm text-muted-foreground">
          先
          <Link to="/setup" className="underline underline-offset-4">
            建立帳本
          </Link>
          ，分帳要記到帳本裡。
        </p>
      ) : friends.isPending ? (
        <p className="mt-6 text-sm text-muted-foreground">載入中…</p>
      ) : list.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          還沒有朋友。按「新增朋友」輸入名字，就能開始記一起吃飯、出遊的花費。
        </p>
      ) : (
        <>
          <p className="mt-6 text-sm">
            別人欠我{' '}
            <span className="amount text-positive">
              {formatAmount(owed, minorUnits)}
            </span>
            {' · '}我欠別人{' '}
            <span className="amount amount-negative">
              {formatAmount(-owing, minorUnits)}
            </span>
          </p>
          <ul className="mt-3 divide-y divide-rule/60 border-y border-rule">
            {list.map((f) => (
              <li
                key={f.id}
                className="flex h-11 items-center gap-3 px-2 text-sm"
              >
                <Link
                  to="/friends/$friendId"
                  params={{ friendId: f.id }}
                  className="min-w-0 flex-1 truncate rounded-sm outline-none hover:underline focus-visible:bg-kraft/20"
                >
                  {f.displayName}
                  {f.placeholder && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      還沒有帳號
                    </span>
                  )}
                </Link>
                <span className="hidden w-20 text-right font-mono text-xs text-muted-foreground tabular-nums sm:block">
                  {f.expenseCount} 筆
                </span>
                <span
                  className={cn(
                    'amount w-44 text-right',
                    f.balance > 0
                      ? 'text-positive'
                      : f.balance < 0
                        ? 'amount-negative'
                        : 'text-muted-foreground',
                  )}
                >
                  {balanceText(f.balance, f.displayName, minorUnits)}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      aria-label={`「${f.displayName}」的動作`}
                    >
                      <EllipsisIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={!f.placeholder}
                      onSelect={() => setRenaming(f)}
                    >
                      改名
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={f.expenseCount > 0}
                      onSelect={() => setDeleting(f)}
                    >
                      移除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        </>
      )}

      {adding && (
        <NameDialog
          title="新增朋友"
          description="輸入你怎麼稱呼他。他之後加入時，這些分帳會跟著他。"
          label="名字"
          maxLength={64}
          submitLabel="新增"
          onClose={() => setAdding(false)}
          onSave={async (displayName) => {
            const { error } = await api.POST('/friends', {
              body: { displayName },
            })
            if (error) return apiErrorMessage(error)
            setAdding(false)
            await refresh()
          }}
        />
      )}

      {renaming && (
        <NameDialog
          title="改名"
          description="往來帳戶也會一起改名。"
          label="名字"
          initial={renaming.displayName}
          maxLength={64}
          onClose={() => setRenaming(null)}
          onSave={async (displayName) => {
            const { error } = await api.PATCH('/friends/{friendId}', {
              params: { path: { friendId: renaming.id } },
              body: { displayName },
            })
            if (error) return apiErrorMessage(error)
            setRenaming(null)
            await refresh()
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`移除「${deleting?.displayName ?? ''}」？`}
        description="沒有和他的分帳，移除後往來帳戶也會一起刪掉。"
        confirmLabel="移除"
        pending={busy}
        onConfirm={() => deleting && void remove(deleting)}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}
