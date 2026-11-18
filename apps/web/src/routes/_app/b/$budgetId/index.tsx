import { createFileRoute, redirect } from '@tanstack/react-router'

// The budget page (M6) will live here; until then a budget opens on the register of all its accounts, where
// transactions are written.
export const Route = createFileRoute('/_app/b/$budgetId/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/b/$budgetId/accounts/$accountId',
      params: { budgetId: params.budgetId, accountId: 'all' },
    })
  },
})
