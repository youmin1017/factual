import { createFileRoute, redirect } from '@tanstack/react-router'

// The budget page (M6) will live here; until then a budget opens on its accounts.
export const Route = createFileRoute('/_app/b/$budgetId/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/b/$budgetId/accounts', params })
  },
})
