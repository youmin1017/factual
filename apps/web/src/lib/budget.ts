import { queryOptions } from '@tanstack/react-query'
import { $api, api } from './api'
import { isoDate } from './register'
import type { Schemas } from './api'

export type Budget = Schemas['Budget']
export type Account = Schemas['Account']
export type AccountKind = Schemas['AccountKind']
export type Category = Schemas['Category']
export type Payee = Schemas['Payee']

/** The caller's budgets; empty until they create one. */
export const budgetsQueryOptions = queryOptions({
  queryKey: ['budgets'],
  queryFn: async ({ signal }) => {
    const { data, error } = await api.GET('/budgets', { signal })
    if (error) throw error
    return data
  },
})

/** The budget to open when none is named: the default one, else the first. */
export function homeBudget(budgets: Array<Budget>): Budget | undefined {
  return budgets.find((b) => b.isDefault) ?? budgets[0]
}

export function accountsQuery(budgetId: string) {
  return $api.queryOptions('get', '/budgets/{budgetId}/accounts', {
    params: { path: { budgetId } },
  })
}

export function summaryQuery(budgetId: string) {
  return $api.queryOptions('get', '/budgets/{budgetId}/summary', {
    params: { path: { budgetId } },
  })
}

/** One month of the budget page (M6); every month shares the key prefix. */
export function budgetMonthQuery(budgetId: string, month: string) {
  return queryOptions({
    queryKey: ['budget-month', budgetId, month],
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET(
        '/budgets/{budgetId}/months/{month}',
        { params: { path: { budgetId, month } }, signal },
      )
      if (error) throw error
      return data
    },
  })
}

export function categoriesQuery(budgetId: string) {
  return $api.queryOptions('get', '/budgets/{budgetId}/categories', {
    params: { path: { budgetId } },
  })
}

export function payeesQuery(budgetId: string) {
  return $api.queryOptions('get', '/budgets/{budgetId}/payees', {
    params: { path: { budgetId } },
  })
}

/** A credit card's statements (ADR-088). */
export function statementsQuery(budgetId: string, accountId: string) {
  return $api.queryOptions(
    'get',
    '/budgets/{budgetId}/accounts/{accountId}/statements',
    { params: { path: { budgetId, accountId } } },
  )
}

/**
 * A loan account's terms, standing and table (ADR-096..098); null while it
 * has no terms. Reloaded with its register, whose saves change it.
 */
export function loanQuery(budgetId: string, accountId: string) {
  return queryOptions({
    queryKey: ['loan', budgetId, accountId],
    queryFn: async ({ signal }) => {
      const { data, error, response } = await api.GET(
        '/budgets/{budgetId}/accounts/{accountId}/loan',
        { params: { path: { budgetId, accountId } }, signal },
      )
      if (response.status === 404) return null
      if (error) throw error
      return data
    },
  })
}

export type CardSettings = Schemas['CardSettings']
export type Statement = Schemas['Statement']

export const accountKinds: Array<{
  value: AccountKind
  label: string
  /** Whether its balance is usually money owed (entered as a positive debt). */
  debt: boolean
}> = [
  { value: 'bank', label: '銀行', debt: false },
  { value: 'cash', label: '現金', debt: false },
  { value: 'credit_card', label: '信用卡', debt: true },
  { value: 'loan', label: '貸款', debt: true },
  { value: 'investment', label: '投資', debt: false },
]

export function accountKindLabel(kind: AccountKind): string {
  return accountKinds.find((k) => k.value === kind)?.label ?? kind
}

/** Cash and bank accounts may be tracked outside the budget; the rest are fixed (ADR-024). */
export function onBudgetChoice(kind: AccountKind): boolean | 'choose' {
  if (kind === 'credit_card') return true
  if (kind === 'loan' || kind === 'investment') return false
  return 'choose'
}

export const currencies = [
  { code: 'TWD', label: '新台幣' },
  { code: 'USD', label: '美元' },
  { code: 'JPY', label: '日圓' },
  { code: 'EUR', label: '歐元' },
  { code: 'HKD', label: '港幣' },
  { code: 'CNY', label: '人民幣' },
  { code: 'GBP', label: '英鎊' },
  { code: 'KRW', label: '韓元' },
  { code: 'SGD', label: '新加坡幣' },
  { code: 'AUD', label: '澳幣' },
]

/** The budget's schedules (M9); the editor owns them once loaded. */
export function schedulesQuery(budgetId: string) {
  return $api.queryOptions('get', '/budgets/{budgetId}/schedules', {
    params: { path: { budgetId } },
  })
}

/**
 * The budget's goals with what the goals page needs to project them (M10);
 * the editor owns the lines once loaded, the figures follow each reload.
 */
export function goalsQuery(budgetId: string) {
  return $api.queryOptions('get', '/budgets/{budgetId}/goals', {
    params: { path: { budgetId } },
  })
}

/**
 * Occurrences not yet posted in the next 30 days: the registers' 預定 rows
 * (ADR-085). Like a register, read once and reloaded after changes.
 */
export function upcomingQuery(budgetId: string) {
  return {
    queryKey: ['upcoming', budgetId],
    queryFn: async () => {
      const until = new Date()
      until.setDate(until.getDate() + 30)
      const { data, error } = await api.GET(
        '/budgets/{budgetId}/schedules/upcoming',
        { params: { path: { budgetId }, query: { until: isoDate(until) } } },
      )
      if (error) throw error
      return data
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  }
}

/** Days off of this year and the next two (ADR-087). */
export function holidaysQuery(year: number) {
  return $api.queryOptions('get', '/holidays', {
    params: { query: { from: year, to: year + 2 } },
  })
}
