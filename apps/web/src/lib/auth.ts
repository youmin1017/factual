import { queryOptions } from '@tanstack/react-query'
import { api } from './api'
import type { Schemas } from './api'

export type CurrentUser = Schemas['CurrentUser']

/**
 * The logged-in user, or `null` when nobody is logged in. Kept until a login
 * or logout changes it; a session that ends in between is caught by the 401
 * handler in `api.ts`.
 */
export const meQueryOptions = queryOptions({
  queryKey: ['me'],
  queryFn: async ({ signal }): Promise<CurrentUser | null> => {
    const { data, response } = await api.GET('/me', { signal })
    if (data) return data
    if (response.status === 401) return null
    throw new Error(`GET /me failed with ${response.status}`)
  },
  staleTime: Infinity,
  retry: false,
})

/** Returns `value` if it is a path inside this app, otherwise `/` (no open redirects). */
export function safeRedirect(value: unknown): string {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.startsWith('/\\')
    ? value
    : '/'
}

/** Where the browser goes to log in with an identity provider. */
export function oidcLoginUrl(code: string, redirect: string): string {
  return `/api/auth/oidc/${encodeURIComponent(code)}/login?redirect=${encodeURIComponent(redirect)}`
}

/** Where the browser goes to link an identity to the logged-in user. */
export function oidcLinkUrl(code: string): string {
  return `/api/auth/oidc/${encodeURIComponent(code)}/link`
}
