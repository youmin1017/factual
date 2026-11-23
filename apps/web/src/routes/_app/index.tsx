import { createFileRoute, redirect } from '@tanstack/react-router'
import { homeBudget } from '#/lib/budget'

// The app opens on the default budget, or asks for one to be created.
export const Route = createFileRoute('/_app/')({
  beforeLoad: ({ context }) => {
    const budget = homeBudget(context.budgets)
    if (!budget) throw redirect({ to: '/setup' })
    throw redirect({ to: '/b/$budgetId', params: { budgetId: budget.id } })
  },
})
