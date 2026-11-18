import { queryOptions } from '@tanstack/react-query'
import { $api, api } from './api'
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
