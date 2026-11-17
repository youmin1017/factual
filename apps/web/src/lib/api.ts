import createFetchClient from 'openapi-fetch'
import createQueryClient from 'openapi-react-query'
import type { components, paths } from './api.gen'

export type Schemas = components['schemas']

/** Upper bound for any API call; a stuck request must not freeze the app. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Typed client generated from apps/api/api/openapi.yaml (`pnpm gen:api`).
 * The spec declares `servers: /api`, so paths here are relative to it.
 * Callers may pass a shorter `signal` (e.g. AbortSignal.timeout(3000)).
 *
 * The session is an httpOnly cookie set by the API; the web app never sees
 * the token.
 */
export const api = createFetchClient<paths>({
  baseUrl: '/api',
  fetch: (request) =>
    fetch(request, {
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    }),
})

// A 401 from any call other than the login itself and the "who am I" check
// means the session ended (expired, logged out elsewhere, password changed):
// send the user to log in and come back.
api.use({
  onResponse({ response, schemaPath }) {
    if (
      response.status !== 401 ||
      schemaPath === '/auth/login' ||
      schemaPath === '/me' ||
      typeof window === 'undefined' ||
      window.location.pathname === '/login'
    ) {
      return
    }
    const here = window.location.pathname + window.location.search
    window.location.assign(`/login?redirect=${encodeURIComponent(here)}`)
  },
})

/** TanStack Query bindings: `$api.useQuery('get', '/healthz')`. */
export const $api = createQueryClient(api)
