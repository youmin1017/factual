import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Amount } from '#/components/amount'
import { DatePicker } from '#/components/date-picker'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { loanQuery } from '#/lib/budget'
import { methodLabels, payment, rateText } from '#/lib/loan'
import { amountInputValue, parseAmount } from '#/lib/money'
import { formatDate, isoDate } from '#/lib/register'
import { LoanDialog, useInvalidateLoan } from './loan-dialog'
import { PeriodTable } from './period-table'
import type { Account, Budget } from '#/lib/budget'
import type { LoanDetails } from '#/lib/loan'

/**
 * Above a loan's register (ADR-098): what it still owes, what has been
 * repaid and paid in interest, the next payment and when it ends; its
 * table on demand, its terms, and aligning with the bank.
 */
export function LoanSummary({
  budget,
  account,
  onChanged,
}: {
  budget: Budget
  account: Account
  /** After its terms are saved or it is aligned, which changes the register. */
  onChanged: () => void
}) {
  const query = useQuery(loanQuery(budget.id, account.id))
  const [setup, setSetup] = useState(false)
  const [table, setTable] = useState(false)
  const [aligning, setAligning] = useState(false)
  const mu = budget.minorUnits
  const now = new Date()

  const dialog = setup && (
    <LoanDialog
      budget={budget}
      account={account}
      onClose={() => setSetup(false)}
      onSaved={onChanged}
    />
  )
  if (!query.isSuccess) return null
  const loan = query.data
  if (!loan) {
    return (
      <p className="text-sm text-muted-foreground">
        還沒有貸款條件：
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={() => setSetup(true)}
        >
          填入撥款金額、期數和利率
        </Button>
        ，就能算出每期的本金和利息，並自動記下還款。
        {dialog}
      </p>
    )
  }
  const next = loan.nextPayment
  const rate = loan.terms.rates.at(-1)?.annualRate ?? 0
  const link = 'h-auto p-0 text-muted-foreground'
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <p>
          <span className="text-muted-foreground">剩餘本金 </span>
          <Amount value={loan.principalLeft} minorUnits={mu} />
          <span className="text-muted-foreground"> · 已還本金 </span>
          <Amount value={loan.principalRepaid} minorUnits={mu} />
          <span className="text-muted-foreground"> · 已付利息 </span>
          <Amount value={loan.interestPaid} minorUnits={mu} />
        </p>
        {next ? (
          <p>
            <span className="text-muted-foreground">
              下期 {formatDate(next.date, now)}（第 {next.n} 期）{' '}
            </span>
            <Amount value={payment(next)} minorUnits={mu} />
            <span className="text-muted-foreground">
              ：本金 <Amount value={next.principal} minorUnits={mu} />
              、利息 <Amount value={next.interest} minorUnits={mu} /> · 還有{' '}
              {loan.periodsLeft} 期
              {loan.payoffDate && `，${formatDate(loan.payoffDate, now)} 還清`}
            </span>
          </p>
        ) : (
          loan.principalLeft <= 0 && <p className="text-positive">已還清</p>
        )}
        <Button
          variant="link"
          size="sm"
          className={link}
          onClick={() => setSetup(true)}
        >
          {methodLabels[loan.terms.method]} · {rateText(rate)}% ·{' '}
          {loan.terms.payFromAccountId ? '自動還款' : '自己記還款'}
        </Button>
        <Button
          variant="link"
          size="sm"
          className={link}
          aria-expanded={table}
          onClick={() => setTable((t) => !t)}
        >
          {table ? '收起攤還表' : `攤還表（${loan.periods.length} 期）`}
        </Button>
        <Button
          variant="link"
          size="sm"
          className={link}
          onClick={() => setAligning((a) => !a)}
        >
          對齊銀行
        </Button>
        {dialog}
      </div>
      {aligning && (
        <AlignForm
          budget={budget}
          account={account}
          loan={loan}
          onClose={() => setAligning(false)}
          onAligned={onChanged}
        />
      )}
      {table && (
        <PeriodTable
          periods={loan.periods}
          minorUnits={mu}
          now={now}
          next={next?.n}
          className="max-h-72"
        />
      )}
    </div>
  )
}

/** The principal the bank shows on a day, posted as the difference (ADR-098). */
function AlignForm({
  budget,
  account,
  loan,
  onClose,
  onAligned,
}: {
  budget: Budget
  account: Account
  loan: LoanDetails
  onClose: () => void
  onAligned: () => void
}) {
  const invalidate = useInvalidateLoan(budget.id)
  const [date, setDate] = useState(() => isoDate(new Date()))
  const [text, setText] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const mu = budget.minorUnits

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const principalLeft = parseAmount(text, mu)
    if (!text.trim() || principalLeft === null || principalLeft < 0)
      return setError('請輸入銀行顯示的剩餘本金')
    const { data, error: failed } = await api.POST(
      '/budgets/{budgetId}/accounts/{accountId}/loan/align',
      {
        params: { path: { budgetId: budget.id, accountId: account.id } },
        body: { date, principalLeft },
      },
    )
    if (failed) return setError(apiErrorMessage(failed))
    setError('')
    if (data.adjustment === 0) return setMessage('和銀行一致，不用調整')
    await invalidate()
    onAligned()
    onClose()
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2 text-sm"
      onSubmit={(e) => void onSubmit(e)}
    >
      <span className="text-muted-foreground">銀行顯示</span>
      <DatePicker
        aria-label="日期"
        className="h-7 w-36"
        value={date}
        onChange={setDate}
      />
      <span className="text-muted-foreground">的剩餘本金是</span>
      <Input
        autoFocus
        aria-label="銀行顯示的剩餘本金"
        inputMode="decimal"
        className="h-7 w-32 font-mono"
        placeholder={amountInputValue(loan.principalLeft, mu)}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setMessage('')
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      />
      <Button type="submit" size="sm" className="h-7">
        對齊
      </Button>
      <span className="text-xs text-muted-foreground">
        差額記成一筆「貸款調整」，不影響資金池和預算；之後的期數照新的餘額計算。
      </span>
      {message && <span className="text-xs text-positive">{message}</span>}
      {error && (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </form>
  )
}
