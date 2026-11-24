import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Amount } from '#/components/amount'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { accountsQuery, loanQuery, summaryQuery } from '#/lib/budget'
import {
  checkGap,
  loanFieldValues,
  parseLoanFields,
  problemField,
} from '#/lib/loan'
import { formatDate, isoDate } from '#/lib/register'
import { LoanFields } from './loan-fields'
import type { Account, Budget } from '#/lib/budget'
import type { LoanDetails, LoanFieldValues } from '#/lib/loan'
import type { LoanFormProblem } from './loan-fields'

/** Reloads everything a loan's terms or an alignment change. */
export function useInvalidateLoan(budgetId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all(
      [
        ['loan', budgetId],
        accountsQuery(budgetId).queryKey,
        summaryQuery(budgetId).queryKey,
        ['register', budgetId],
        ['upcoming', budgetId],
        ['budget-month', budgetId],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    )
}

/**
 * An existing loan account's terms (ADR-096), from its menu or its page:
 * typed from the bank's contract, previewed as they are typed, and saved
 * with the schedule that pays them (ADR-097). When the account's balance is
 * not what the terms leave owed, saving offers to align it (ADR-098). A new
 * loan account takes its terms in the new-account dialog (ADR-100).
 */
export function LoanDialog({
  budget,
  account,
  onClose,
  onSaved,
}: {
  budget: Budget
  account: Account
  onClose: () => void
  /** After the terms (and any alignment) are saved. */
  onSaved?: () => void
}) {
  const loan = useQuery(loanQuery(budget.id, account.id))
  if (!loan.isSuccess) return null
  return (
    <LoanForm
      budget={budget}
      account={account}
      initial={loanFieldValues(
        loan.data?.terms ?? null,
        budget.minorUnits,
        isoDate(new Date()),
      )}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}

function LoanForm({
  budget,
  account,
  initial,
  onClose,
  onSaved,
}: {
  budget: Budget
  account: Account
  initial: LoanFieldValues
  onClose: () => void
  onSaved?: () => void
}) {
  const mu = budget.minorUnits
  const invalidate = useInvalidateLoan(budget.id)
  const [values, setValues] = useState(initial)
  const [problem, setProblem] = useState<LoanFormProblem | null>(null)
  const [saving, setSaving] = useState(false)
  /** After saving, when the account and the terms disagree. */
  const [saved, setSaved] = useState<LoanDetails | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const terms = parseLoanFields(values, mu)
    if ('field' in terms) return setProblem(terms)
    setSaving(true)
    const { data, error } = await api.PUT(
      '/budgets/{budgetId}/accounts/{accountId}/loan',
      {
        params: { path: { budgetId: budget.id, accountId: account.id } },
        body: terms,
      },
    )
    setSaving(false)
    if (error) {
      return setProblem({
        field: problemField(error.details?.field),
        message: apiErrorMessage(error),
      })
    }
    await invalidate()
    onSaved?.()
    if (checkGap(data.check) !== 0) return setSaved(data)
    onClose()
  }

  if (saved?.check) {
    return (
      <AlignStep
        budget={budget}
        account={account}
        loan={saved}
        onDone={async () => {
          await invalidate()
          onSaved?.()
          onClose()
        }}
      />
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{account.name} 的貸款設定</DialogTitle>
          <DialogDescription>
            照銀行的貸款契約填。設定後每期還款自動入帳，並拆成本金和利息；以前繳過的期數不用補記。
          </DialogDescription>
        </DialogHeader>
        <form id="loan-form" onSubmit={onSubmit}>
          <LoanFields
            budgetId={budget.id}
            minorUnits={mu}
            values={values}
            onChange={(next) => {
              setValues(next)
              setProblem(null)
            }}
            problem={problem}
          />
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="loan-form" disabled={saving}>
            {saving ? '儲存中…' : '儲存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * After saving, when the account says something other than the terms
 * before the first payment the schedule pays: align it, or leave it.
 */
function AlignStep({
  budget,
  account,
  loan,
  onDone,
}: {
  budget: Budget
  account: Account
  loan: LoanDetails
  onDone: () => void
}) {
  const check = loan.check
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  if (!check) return null
  const mu = budget.minorUnits
  const now = new Date()

  async function align() {
    if (!check) return
    setPending(true)
    const { error: failed } = await api.POST(
      '/budgets/{budgetId}/accounts/{accountId}/loan/align',
      {
        params: { path: { budgetId: budget.id, accountId: account.id } },
        body: { date: check.date, principalLeft: check.computed },
      },
    )
    setPending(false)
    if (failed) return setError(apiErrorMessage(failed))
    onDone()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>帳戶餘額和貸款條件不一樣</DialogTitle>
          <DialogDescription>
            照貸款條件，{formatDate(check.date, now)} 還欠{' '}
            <Amount value={check.computed} minorUnits={mu} />
            ；帳戶記的是 <Amount value={check.recorded} minorUnits={mu} />
            。以前手動記的還款可能把利息也算成本金了。
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          對齊會在貸款帳戶記一筆「貸款調整」，差額{' '}
          <Amount value={checkGap(check)} minorUnits={mu} />
          ，不影響資金池和預算。如果帳戶的數字才是對的（例如以前提前還過款），就先不要對齊，之後可以用銀行的剩餘本金對齊。
        </p>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onDone}>
            先不要
          </Button>
          <Button onClick={() => void align()} disabled={pending}>
            對齊為 <Amount value={check.computed} minorUnits={mu} />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
