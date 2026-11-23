import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Amount } from '#/components/amount'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { statementsQuery } from '#/lib/budget'
import { amountInputValue, parseAmount } from '#/lib/money'
import { formatDate } from '#/lib/register'
import { cn } from '#/lib/utils'
import { CardDialog } from './card-settings'
import type { Account, Budget, Statement } from '#/lib/budget'

const states: Record<Statement['state'], { label: string; tone: string }> = {
  due: { label: '待繳', tone: 'text-kraft' },
  partial: { label: '部分繳款', tone: 'text-kraft' },
  paid: { label: '已繳清', tone: 'text-positive' },
  overdue: { label: '逾期', tone: 'text-destructive' },
  settled: { label: '已併入下期', tone: 'text-muted-foreground' },
}

/**
 * Above a card's register (ADR-088, ADR-089): the latest statement (what
 * it asks, what was paid since, what is left, by when) and what the open
 * one has gathered so far. Its amount can be aligned with the bank's bill.
 */
export function StatementSummary({
  budget,
  account,
}: {
  budget: Budget
  account: Account
}) {
  const query = useQuery(statementsQuery(budget.id, account.id))
  const [setup, setSetup] = useState(false)
  const [history, setHistory] = useState(false)
  const mu = budget.minorUnits
  const now = new Date()

  const dialog = setup && (
    <CardDialog
      budget={budget}
      account={account}
      onClose={() => setSetup(false)}
    />
  )
  if (!query.data) return null
  const { card, open, statements } = query.data
  if (!card) {
    return (
      <p className="text-sm text-muted-foreground">
        還沒有帳單設定：
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={() => setSetup(true)}
        >
          設定結帳日和繳款截止日
        </Button>
        ，就能看到每期要繳多少。
        {dialog}
      </p>
    )
  }
  const latest = statements.at(0)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1 text-sm">
        {latest && <Latest statement={latest} budget={budget} now={now} />}
        {open && (
          <p className="text-muted-foreground">
            本期 {formatDate(open.periodStart, now)}–
            {formatDate(open.periodEnd, now)}：新增消費{' '}
            <Amount value={open.charges} minorUnits={mu} />
            {open.payments > 0 && (
              <>
                ，已繳 <Amount value={open.payments} minorUnits={mu} />
              </>
            )}
          </p>
        )}
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-muted-foreground"
          onClick={() => setSetup(true)}
        >
          每月 {card.statementDay} 日結帳、{card.dueDay} 日截止
        </Button>
        {statements.length > 0 && (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-muted-foreground"
            aria-expanded={history}
            onClick={() => setHistory((h) => !h)}
          >
            {history ? '收起歷史帳單' : `歷史帳單（${statements.length} 期）`}
          </Button>
        )}
        {dialog}
      </div>
      {history && <History statements={statements} minorUnits={mu} now={now} />}
    </div>
  )
}

/** Every closed statement, newest first, as the bank's bill lays it out. */
function History({
  statements,
  minorUnits,
  now,
}: {
  statements: Array<Statement>
  minorUnits: number
  now: Date
}) {
  const head = 'px-2 py-1 text-right font-normal'
  return (
    <div className="max-h-64 overflow-auto rounded-md border border-rule">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
          <tr className="border-b border-rule">
            <th className="px-2 py-1 text-left font-normal">結帳日</th>
            <th className="px-2 py-1 text-left font-normal">截止日</th>
            <th className={head}>上期應繳</th>
            <th className={head}>本期繳款</th>
            <th className={head}>本期消費</th>
            <th className={head}>本期應繳</th>
            <th className="px-2 py-1 text-left font-normal">狀態</th>
          </tr>
        </thead>
        <tbody>
          {statements.map((st) => {
            const state = states[st.state]
            const cell = 'px-2 py-1 text-right'
            return (
              <tr key={st.id} className="border-b border-rule/50 last:border-0">
                <td className="px-2 py-1 font-mono">
                  {formatDate(st.periodEnd, now)}
                </td>
                <td className="px-2 py-1 font-mono">
                  {formatDate(st.dueDate, now)}
                </td>
                <td className={cell}>
                  <Amount value={st.previousDue} minorUnits={minorUnits} />
                </td>
                <td className={cell}>
                  <Amount value={st.payments} minorUnits={minorUnits} />
                </td>
                <td className={cell}>
                  <Amount value={st.charges} minorUnits={minorUnits} />
                </td>
                <td className={cell}>
                  <Amount value={st.amountDue} minorUnits={minorUnits} />
                  {st.adjusted && (
                    <span className="text-xs text-muted-foreground">＊</span>
                  )}
                </td>
                <td className={cn('px-2 py-1', state.tone)}>{state.label}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {statements.some((s) => s.adjusted) && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          ＊ 已對齊銀行帳單
        </p>
      )}
    </div>
  )
}

function Latest({
  statement: st,
  budget,
  now,
}: {
  statement: Statement
  budget: Budget
  now: Date
}) {
  const queryClient = useQueryClient()
  const [aligning, setAligning] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const mu = budget.minorUnits
  const state = states[st.state]

  async function align(amount: number | null) {
    const { error: failed } = await api.PUT(
      '/budgets/{budgetId}/statements/{statementId}/due',
      {
        params: { path: { budgetId: budget.id, statementId: st.id } },
        body: { amount },
      },
    )
    if (failed) return setError(apiErrorMessage(failed))
    await queryClient.invalidateQueries({
      queryKey: ['get', '/budgets/{budgetId}/accounts/{accountId}/statements'],
    })
    setAligning(false)
    setError('')
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-muted-foreground">
        {formatDate(st.periodEnd, now)} 結帳的帳單
      </span>
      <span className={cn('font-medium', state.tone)}>{state.label}</span>
      {aligning ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!text.trim()) return void align(null)
            const amount = parseAmount(text, mu)
            if (amount === null || amount < 0) return setError('金額不對')
            void align(amount)
          }}
        >
          <Input
            autoFocus
            aria-label="銀行帳單的應繳金額"
            inputMode="decimal"
            className="h-7 w-28 font-mono"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAligning(false)}
          />
          <span className="text-xs text-muted-foreground">
            Enter 儲存；清空回到計算的 {amountInputValue(st.computedDue, mu)}
          </span>
          {error && (
            <span className="text-xs text-destructive" role="alert">
              {error}
            </span>
          )}
        </form>
      ) : (
        <span>
          應繳{' '}
          <button
            type="button"
            className="underline decoration-dotted underline-offset-4"
            title={
              st.adjusted
                ? `已對齊銀行帳單（計算出來是 ${amountInputValue(st.computedDue, mu)}）；點一下修改`
                : '和銀行帳單不同時，點一下對齊'
            }
            onClick={() => {
              setText(amountInputValue(st.amountDue, mu))
              setAligning(true)
            }}
          >
            <Amount value={st.amountDue} minorUnits={mu} />
          </button>
          {st.adjusted && (
            <span className="text-xs text-muted-foreground">（已對齊）</span>
          )}
          {st.state !== 'settled' && (
            <>
              {' '}
              · 已繳 <Amount value={st.paid} minorUnits={mu} />
              {st.remaining > 0 && (
                <>
                  {' '}
                  · 還差 <Amount value={st.remaining} minorUnits={mu} /> ·{' '}
                  {formatDate(st.dueDate, now)} 截止
                </>
              )}
            </>
          )}
        </span>
      )}
    </div>
  )
}
