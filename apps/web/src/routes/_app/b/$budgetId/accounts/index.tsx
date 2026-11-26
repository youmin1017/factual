import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { AccountGrid } from '#/components/accounts/account-grid'
import { Amount } from '#/components/amount'
import { LoanDialog } from '#/components/loans/loan-dialog'
import { apiErrorMessage } from '#/lib/apiError'
import { accountsQuery, summaryQuery } from '#/lib/budget'
import { useKeymap } from '#/lib/preferences'
import type { Account, Budget } from '#/lib/budget'

export const Route = createFileRoute('/_app/b/$budgetId/accounts/')({
  staticData: { crumb: '帳戶', wide: true },
  component: AccountsPage,
})

// The accounts (ADR-108): a grid edited from the keyboard like the budget,
// schedules and goals pages, saved with :w. Friend accounts come and go
// with their friends (ADR-106) and are left out.
function AccountsPage() {
  const { budget } = Route.useRouteContext()
  const accounts = useQuery(accountsQuery(budget.id))
  const summary = useQuery(summaryQuery(budget.id))
  const queryClient = useQueryClient()
  const keymap = useKeymap()
  const [loan, setLoan] = useState<Account | null>(null)

  if (accounts.isError) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {apiErrorMessage(accounts.error)}
      </p>
    )
  }
  if (!accounts.data) {
    return <p className="text-sm text-muted-foreground">載入中…</p>
  }
  const mine = accounts.data.filter((a) => a.kind !== 'friend')
  const friends = accounts.data.length - mine.length

  async function reload() {
    await queryClient.invalidateQueries({
      queryKey: summaryQuery(budget.id).queryKey,
    })
    await queryClient.invalidateQueries({
      queryKey: ['budget-month', budget.id],
    })
    const fresh = await queryClient.fetchQuery({
      ...accountsQuery(budget.id),
      staleTime: 0,
    })
    return fresh.filter((a) => a.kind !== 'friend')
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2 border-b pb-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">帳戶</h1>
          <p className="text-sm text-muted-foreground">
            o 新增、i 改名或設定、ddp 調整順序、x 關閉，:w 儲存。
            {budget.role !== 'owner' && '只有帳本的擁有者能修改帳戶。'}
            {friends > 0 && (
              <>
                {' '}
                另有 {friends} 個和朋友的往來帳戶，在
                <Link to="/friends" className="underline underline-offset-4">
                  分帳
                </Link>
                頁記錄。
              </>
            )}
          </p>
        </div>
        {summary.data && (
          <dl className="flex gap-6 text-sm">
            <Total label="資金池" value={summary.data.pool} budget={budget} />
            <Total
              label="預算內"
              value={summary.data.onBudgetBalance}
              budget={budget}
            />
            <Total
              label="追蹤"
              value={summary.data.offBudgetBalance}
              budget={budget}
            />
          </dl>
        )}
      </div>
      <AccountGrid
        budgetId={budget.id}
        minorUnits={budget.minorUnits}
        accounts={mine}
        keymap={keymap}
        reload={reload}
        onLoan={setLoan}
      />
      {loan && (
        <LoanDialog
          budget={budget}
          account={loan}
          onClose={() => setLoan(null)}
        />
      )}
    </div>
  )
}

function Total({
  label,
  value,
  budget,
}: {
  label: string
  value: number
  budget: Budget
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>
        <Amount value={value} minorUnits={budget.minorUnits} />
      </dd>
    </div>
  )
}
