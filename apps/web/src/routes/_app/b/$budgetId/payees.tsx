import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { EllipsisIcon, MergeIcon, SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog, NameDialog } from '#/components/dialogs'
import { PageHeader } from '#/components/section'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
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
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { categoriesQuery, payeesQuery } from '#/lib/budget'
import { categoryRefs, matchScore } from '#/lib/register'
import { cn } from '#/lib/utils'
import type { Budget, Payee } from '#/lib/budget'

export const Route = createFileRoute('/_app/b/$budgetId/payees')({
  staticData: { crumb: '收付款對象' },
  component: PayeesPage,
})

// Payees are created by typing a new name in the register (ADR-065); here
// they are tidied up: renamed, merged when one shop has several spellings,
// deleted when nothing uses them (ADR-069).

function PayeesPage() {
  const { budget } = Route.useRouteContext()
  const payees = useQuery(payeesQuery(budget.id))
  const categories = useQuery(categoriesQuery(budget.id))
  const invalidate = useInvalidatePayees(budget.id)
  const canEdit = budget.role !== 'viewer'

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<Payee | null>(null)
  const [deleting, setDeleting] = useState<Payee | null>(null)
  const [merging, setMerging] = useState(false)
  const [busy, setBusy] = useState(false)

  if (payees.isError) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {apiErrorMessage(payees.error)}
      </p>
    )
  }

  const paths = categoryRefs(categories.data ?? [])
  const all = payees.data ?? []
  const shown = query.trim()
    ? all
        .map((p) => ({ p, score: matchScore(query, p.name) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.p)
    : all
  const chosen = all.filter((p) => selected.has(p.id))

  function toggle(id: string, on: boolean) {
    const next = new Set(selected)
    if (on) next.add(id)
    else next.delete(id)
    setSelected(next)
  }

  async function remove(payee: Payee) {
    setBusy(true)
    const { error } = await api.DELETE('/budgets/{budgetId}/payees/{payeeId}', {
      params: { path: { budgetId: budget.id, payeeId: payee.id } },
    })
    setBusy(false)
    setDeleting(null)
    if (error) {
      toast.error(apiErrorMessage(error))
      return
    }
    toast.success(`已刪除「${payee.name}」`)
    toggle(payee.id, false)
    await invalidate()
  }

  return (
    <div>
      <PageHeader title="收付款對象">
        <label className="relative w-56">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋"
            aria-label="搜尋收付款對象"
            className="pl-8"
          />
        </label>
      </PageHeader>

      <p className="mt-4 text-sm text-muted-foreground">
        在明細輸入新的名稱就會建立。同一家店有幾種寫法時，勾選起來合併成一個；交易會一起移過去。
      </p>

      {/* Always there, so selecting does not move the list. */}
      {canEdit && all.length > 1 && (
        <div
          className={cn(
            'mt-4 flex h-11 items-center justify-between gap-4 rounded-md border px-3 text-sm',
            chosen.length > 0
              ? 'border-kraft/50 bg-card'
              : 'border-dashed text-muted-foreground',
          )}
        >
          <span>
            {chosen.length > 0
              ? `已選 ${chosen.length} 個${chosen.length < 2 ? '，再選一個以上就能合併' : ''}`
              : '勾選同一家店的不同寫法，合併成一個'}
          </span>
          <span className={cn('flex gap-2', chosen.length === 0 && 'hidden')}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
            >
              取消選取
            </Button>
            <Button
              size="sm"
              disabled={chosen.length < 2}
              onClick={() => setMerging(true)}
            >
              <MergeIcon />
              合併
            </Button>
          </span>
        </div>
      )}

      {payees.isPending ? (
        <p className="mt-6 text-sm text-muted-foreground">載入中…</p>
      ) : all.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          還沒有收付款對象。在帳戶明細記一筆交易時輸入名稱，就會出現在這裡。
        </p>
      ) : shown.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          沒有符合「{query}」的收付款對象。
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-rule/60 border-y border-rule">
          {shown.map((p) => {
            const last = p.lastCategoryId
              ? paths.get(p.lastCategoryId)?.path
              : undefined
            return (
              <li
                key={p.id}
                className={cn(
                  'flex h-11 items-center gap-3 px-2 text-sm',
                  selected.has(p.id) && 'bg-accent/50',
                )}
              >
                {canEdit && (
                  <Checkbox
                    checked={selected.has(p.id)}
                    onCheckedChange={(on) => toggle(p.id, on === true)}
                    aria-label={`選取「${p.name}」`}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="hidden w-48 truncate text-muted-foreground sm:block">
                  {last ?? ''}
                </span>
                <span className="w-20 text-right font-mono text-xs text-muted-foreground tabular-nums">
                  {p.transactionCount} 筆
                </span>
                {canEdit && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={`「${p.name}」的動作`}
                      >
                        <EllipsisIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setRenaming(p)}>
                        改名
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={p.transactionCount > 0}
                        onSelect={() => setDeleting(p)}
                      >
                        刪除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {renaming && (
        <NameDialog
          title="改名"
          description="這個收付款對象的所有交易都會顯示新名稱。"
          initial={renaming.name}
          maxLength={64}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            const { error } = await api.PUT(
              '/budgets/{budgetId}/payees/{payeeId}',
              {
                params: {
                  path: { budgetId: budget.id, payeeId: renaming.id },
                },
                body: { name },
              },
            )
            if (error) return apiErrorMessage(error)
            setRenaming(null)
            await invalidate()
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`刪除「${deleting?.name ?? ''}」？`}
        description="沒有交易用到這個收付款對象，刪除後不會影響任何紀錄。"
        confirmLabel="刪除"
        pending={busy}
        onConfirm={() => deleting && void remove(deleting)}
        onClose={() => setDeleting(null)}
      />

      {merging && (
        <MergeDialog
          budget={budget}
          payees={chosen}
          onClose={() => setMerging(false)}
          onMerged={async (target) => {
            setMerging(false)
            setSelected(new Set())
            toast.success(`已合併到「${target.name}」`)
            await invalidate()
          }}
        />
      )}
    </div>
  )
}

/** Picks the payee to keep; the others are merged into it. */
function MergeDialog({
  budget,
  payees,
  onClose,
  onMerged,
}: {
  budget: Budget
  payees: Array<Payee>
  onClose: () => void
  onMerged: (target: Payee) => Promise<void>
}) {
  // The most used name is the likely keeper.
  const [targetId, setTargetId] = useState(
    () =>
      payees.toSorted((a, b) => b.transactionCount - a.transactionCount)[0].id,
  )
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const total = payees.reduce((n, p) => n + p.transactionCount, 0)

  async function merge() {
    setSaving(true)
    setError('')
    const { data, error: failure } = await api.POST(
      '/budgets/{budgetId}/payees/{payeeId}/merge',
      {
        params: { path: { budgetId: budget.id, payeeId: targetId } },
        body: {
          sourceIds: payees.filter((p) => p.id !== targetId).map((p) => p.id),
        },
      },
    )
    setSaving(false)
    if (failure) {
      setError(apiErrorMessage(failure))
      return
    }
    await onMerged(data)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>合併 {payees.length} 個收付款對象</DialogTitle>
          <DialogDescription>
            選一個要保留的名稱。其他 {payees.length - 1}{' '}
            個會刪除，它們的交易（共 {total} 筆）改用保留的名稱。
          </DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-1">
          <legend className="sr-only">保留的名稱</legend>
          {payees.map((p) => (
            <label
              key={p.id}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm',
                p.id === targetId
                  ? 'border-kraft bg-accent/50'
                  : 'border-transparent',
              )}
            >
              <input
                type="radio"
                name="merge-target"
                value={p.id}
                checked={p.id === targetId}
                onChange={() => setTargetId(p.id)}
                className="accent-[var(--kraft)]"
              />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {p.transactionCount} 筆
              </span>
            </label>
          ))}
        </fieldset>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void merge()} disabled={saving}>
            {saving ? '合併中…' : '合併'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function useInvalidatePayees(budgetId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: payeesQuery(budgetId).queryKey,
      }),
      // Registers show payee names.
      queryClient.invalidateQueries({ queryKey: ['register', budgetId] }),
    ])
}
