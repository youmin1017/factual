import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Amount } from '#/components/amount'
import { StatementSummary } from '#/components/cards/statement-summary'
import { LoanSummary } from '#/components/loans/loan-summary'
import { RegisterGrid } from '#/components/register/register-grid'
import { api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import {
  accountKindLabel,
  accountsQuery,
  categoriesQuery,
  payeesQuery,
  schedulesQuery,
  statementsQuery,
  summaryQuery,
  upcomingQuery,
} from '#/lib/budget'
import { useKeymap } from '#/lib/preferences'
import { categoryRefs } from '#/lib/register'
import type {
  RegisterData,
  RegisterView,
} from '#/components/register/register-grid'
import type { Account } from '#/lib/budget'
import type { AccountRef, Context } from '#/lib/register'

// One account's register, or a group's (ADR-071): /accounts/all,
// /accounts/on-budget and /accounts/off-budget.
export const Route = createFileRoute('/_app/b/$budgetId/accounts/$accountId')({
  staticData: { crumb: '帳戶明細', wide: true },
  component: RegisterPage,
})

const groups = {
  all: { title: '所有帳戶', scope: 'all', has: () => true },
  'on-budget': {
    title: '預算內帳戶',
    scope: 'onBudget',
    has: (a: Account) => a.onBudget,
  },
  'off-budget': {
    title: '追蹤帳戶',
    scope: 'offBudget',
    has: (a: Account) => !a.onBudget,
  },
} as const

type Group = keyof typeof groups

function isGroup(id: string): id is Group {
  return Object.hasOwn(groups, id)
}

function registerQuery(budgetId: string, viewKey: string) {
  return {
    queryKey: ['register', budgetId, viewKey],
    queryFn: async () => {
      if (isGroup(viewKey)) {
        const { data, error } = await api.GET('/budgets/{budgetId}/register', {
          params: {
            path: { budgetId },
            query: { scope: groups[viewKey].scope },
          },
        })
        if (error) throw error
        return data
      }
      const { data, error } = await api.GET(
        '/budgets/{budgetId}/accounts/{accountId}/register',
        { params: { path: { budgetId, accountId: viewKey } } },
      )
      if (error) throw error
      return data
    },
    // The editor owns the rows once loaded; it reloads them after :w.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  }
}

function RegisterPage() {
  const { budget } = Route.useRouteContext()
  const { accountId: viewKey } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const accounts = useQuery(accountsQuery(budget.id))
  const categories = useQuery(categoriesQuery(budget.id))
  const payees = useQuery(payeesQuery(budget.id))
  const register = useQuery(registerQuery(budget.id, viewKey))
  const upcoming = useQuery(upcomingQuery(budget.id))
  const isCard =
    accounts.data?.find((a) => a.id === viewKey)?.kind === 'credit_card'
  const cardStatements = useQuery({
    ...statementsQuery(budget.id, viewKey),
    enabled: isCard,
  })
  const keymap = useKeymap()
  /** Bumped when the loan's terms or alignment changed its register. */
  const [stamp, setStamp] = useState(0)

  const failed = [accounts, categories, payees, register, upcoming].find(
    (q) => q.isError,
  )
  if (failed) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {apiErrorMessage(failed.error)}
      </p>
    )
  }
  if (
    !accounts.data ||
    !categories.data ||
    !payees.data ||
    !register.data ||
    !upcoming.data
  ) {
    return <p className="text-sm text-muted-foreground">載入中…</p>
  }

  const group = isGroup(viewKey) ? groups[viewKey] : null
  const account = accounts.data.find((a) => a.id === viewKey)
  if (!group && !account) {
    return <p className="text-sm text-muted-foreground">找不到這個帳戶。</p>
  }
  const members = group
    ? accounts.data.filter((a) => group.has(a))
    : accounts.data.filter((a) => a.id === viewKey)

  // Every account of the budget, for transfers.
  const refs = new Map<string, AccountRef>(
    accounts.data.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.name,
        onBudget: a.onBudget,
        // Friend accounts move only through shared expenses (ADR-106):
        // shown by name, never offered for an entry.
        closed: a.closed || a.kind === 'friend',
      },
    ]),
  )
  const ctx: Context = {
    accounts: refs,
    categories: categoryRefs(categories.data),
    minorUnits: budget.minorUnits,
  }
  const view: RegisterView = {
    key: viewKey,
    accounts: members.map((a) => a.id),
    multi: group !== null,
  }

  async function reload(): Promise<RegisterData> {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: payeesQuery(budget.id).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: accountsQuery(budget.id).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: summaryQuery(budget.id).queryKey,
      }),
      // A transaction is in other accounts' and groups' registers too.
      queryClient.invalidateQueries({ queryKey: ['register', budget.id] }),
      // Posting an occurrence moves its schedule on (ADR-085).
      queryClient.invalidateQueries({ queryKey: ['upcoming', budget.id] }),
      queryClient.invalidateQueries({
        queryKey: schedulesQuery(budget.id).queryKey,
      }),
      queryClient.invalidateQueries({ queryKey: ['budget-month', budget.id] }),
      // What a card's statements ask and were paid (ADR-088).
      queryClient.invalidateQueries({
        queryKey: [
          'get',
          '/budgets/{budgetId}/accounts/{accountId}/statements',
        ],
      }),
      // What a loan owes and has paid (ADR-098).
      queryClient.invalidateQueries({ queryKey: ['loan', budget.id] }),
    ])
    const [transactions, next] = await Promise.all([
      queryClient.fetchQuery(registerQuery(budget.id, viewKey)),
      queryClient.fetchQuery(upcomingQuery(budget.id)),
    ])
    return { transactions, upcoming: next }
  }

  const sum = (pick: (a: Account) => number) =>
    members.reduce((total, a) => total + pick(a), 0)

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2 border-b pb-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">
            {group ? group.title : account?.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {group
              ? `${members.length} 個帳戶`
              : account &&
                `${accountKindLabel(account.kind)}・${account.onBudget ? '預算內' : '追蹤'}`}
          </p>
        </div>
        <dl className="flex gap-8 text-right">
          <div>
            <dt className="text-sm text-muted-foreground">已核對</dt>
            <dd className="text-lg">
              <Amount
                value={sum((a) => a.clearedBalance)}
                minorUnits={budget.minorUnits}
              />
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">餘額</dt>
            <dd className="text-lg">
              <Amount
                value={sum((a) => a.balance)}
                minorUnits={budget.minorUnits}
              />
            </dd>
          </div>
        </dl>
      </div>

      {account?.kind === 'credit_card' && (
        <StatementSummary budget={budget} account={account} />
      )}
      {account?.kind === 'loan' && (
        <LoanSummary
          budget={budget}
          account={account}
          onChanged={() => setStamp((n) => n + 1)}
        />
      )}

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          還沒有帳戶。先到{' '}
          <Link
            to="/b/$budgetId/accounts"
            params={{ budgetId: budget.id }}
            className="text-foreground underline underline-offset-4"
          >
            管理帳戶
          </Link>{' '}
          新增一個，就能開始記帳。
        </p>
      ) : (
        <RegisterGrid
          key={viewKey}
          budgetId={budget.id}
          view={view}
          ctx={ctx}
          transactions={register.data}
          upcoming={upcoming.data}
          payees={payees.data.map((p) => ({
            name: p.name,
            lastCategoryId: p.lastCategoryId,
          }))}
          keymap={keymap}
          reload={reload}
          stamp={stamp}
          card={
            isCard && cardStatements.data
              ? { id: viewKey, statements: cardStatements.data }
              : undefined
          }
          onQuit={() =>
            void navigate({
              to: '/b/$budgetId/accounts',
              params: { budgetId: budget.id },
            })
          }
        />
      )}
    </div>
  )
}
