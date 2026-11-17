import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

// A budget the user can see. Unknown ids (or budgets they left) go home; the
// API answers 404 for them anyway.
export const Route = createFileRoute('/_app/b/$budgetId')({
  beforeLoad: ({ context, params }) => {
    const budget = context.budgets.find((b) => b.id === params.budgetId)
    if (!budget) throw redirect({ to: '/' })
    return { budget }
  },
  component: Outlet,
})
