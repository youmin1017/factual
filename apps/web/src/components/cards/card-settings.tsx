import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
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
import { api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { accountsQuery } from '#/lib/budget'
import { amountInputValue, parseAmount } from '#/lib/money'
import type { Account, Budget, CardSettings } from '#/lib/budget'

/** A card's statement settings as typed (ADR-088). */
export interface CardFieldValues {
  statementDay: string
  dueDay: string
  limit: string
}

export function cardFieldValues(
  card: CardSettings | null | undefined,
  minorUnits: number,
): CardFieldValues {
  return {
    statementDay: card ? String(card.statementDay) : '',
    dueDay: card ? String(card.dueDay) : '',
    limit:
      card?.creditLimit != null
        ? amountInputValue(card.creditLimit, minorUnits)
        : '',
  }
}

/**
 * The settings typed, or why they are not settings; null when nothing is
 * typed (a card without statements). `autopay` is kept as it was.
 */
export function parseCardFields(
  v: CardFieldValues,
  minorUnits: number,
  autopay: string | null = null,
): CardSettings | null | string {
  if (!v.statementDay.trim() && !v.dueDay.trim() && !v.limit.trim()) return null
  const day = (text: string) => {
    const n = Number(text.trim())
    return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null
  }
  const statementDay = day(v.statementDay)
  const dueDay = day(v.dueDay)
  if (statementDay === null || dueDay === null)
    return '結帳日和繳款截止日請輸入 1 到 31'
  let creditLimit: number | null = null
  if (v.limit.trim()) {
    creditLimit = parseAmount(v.limit, minorUnits)
    if (creditLimit === null || creditLimit < 0) return '信用額度的金額不對'
  }
  return { statementDay, dueDay, creditLimit, autopayAccountId: autopay }
}

/** The statement and due days and the limit, for a card's forms. */
export function CardFields({
  values,
  onChange,
}: {
  values: CardFieldValues
  onChange: (values: CardFieldValues) => void
}) {
  const field = (
    key: keyof CardFieldValues,
    label: string,
    placeholder: string,
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`card-${key}`}>{label}</Label>
      <Input
        id={`card-${key}`}
        inputMode="numeric"
        className="font-mono"
        placeholder={placeholder}
        value={values[key]}
        onChange={(e) => onChange({ ...values, [key]: e.target.value })}
      />
    </div>
  )
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-3">
        {field('statementDay', '結帳日', '5')}
        {field('dueDay', '繳款截止日', '25')}
        {field('limit', '信用額度', '選填')}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        每個月的幾號。結帳日的隔天自動結帳，截止日遇假日順延；繳款日不晚於結帳日時算下個月。
      </p>
    </div>
  )
}

/** A card's statement settings, from its menu (ADR-088). */
export function CardDialog({
  budget,
  account,
  onClose,
}: {
  budget: Budget
  account: Account
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [values, setValues] = useState(() =>
    cardFieldValues(account.card, budget.minorUnits),
  )
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const card = parseCardFields(
      values,
      budget.minorUnits,
      account.card?.autopayAccountId ?? null,
    )
    if (typeof card === 'string') return setError(card)
    if (card === null) return setError('請輸入結帳日和繳款截止日')
    setSaving(true)
    const { error: failed } = await api.PUT(
      '/budgets/{budgetId}/accounts/{accountId}',
      {
        params: { path: { budgetId: budget.id, accountId: account.id } },
        body: { name: account.name, closed: account.closed, card },
      },
    )
    setSaving(false)
    if (failed) return setError(apiErrorMessage(failed))
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: accountsQuery(budget.id).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: [
          'get',
          '/budgets/{budgetId}/accounts/{accountId}/statements',
        ],
      }),
    ])
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{account.name} 的帳單設定</DialogTitle>
          <DialogDescription>
            設定後每期自動結帳，登記簿上方會顯示這期要繳多少、繳了多少。
          </DialogDescription>
        </DialogHeader>
        <form id="card-form" className="space-y-4" onSubmit={onSubmit}>
          <CardFields values={values} onChange={setValues} />
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
          <Button type="submit" form="card-form" disabled={saving}>
            {saving ? '儲存中…' : '儲存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
