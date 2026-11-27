import { createFileRoute, redirect } from '@tanstack/react-router'

// The profile is the caller's own line on the users page now (ADR-136); old
// links, and the sign-in link flow of older servers, still land here.
export const Route = createFileRoute('/_app/profile')({
  beforeLoad: ({ search }) => {
    const s = search as Record<string, unknown>
    throw redirect({
      to: '/settings/users',
      search: {
        linked: typeof s.linked === 'string' ? s.linked : undefined,
        error: typeof s.error === 'string' ? s.error : undefined,
      },
    })
  },
})
