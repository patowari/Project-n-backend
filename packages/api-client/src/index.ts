import createClient, { type Middleware } from 'openapi-fetch'
import type { components, paths } from './schema'

export type { components, paths }
export type Schemas = components['schemas']

/**
 * One client for every app. What differs is where the refresh token lives:
 *
 *   web      httpOnly cookie set by the API (the app never sees it)
 *   native   React Native / Tauri: the API returns it in the body and the
 *            app keeps it in the OS keychain (expo-secure-store, Tauri
 *            stronghold / OS keyring). Never AsyncStorage, never localStorage.
 *
 * The access token (15 min) is held in memory only.
 */
export interface SessionStore {
  getAccessToken(): string | null
  setAccessToken(token: string | null): void
  /** native only */
  getRefreshToken?(): Promise<string | null> | string | null
  /** native only: called after every rotation */
  setRefreshToken?(token: string | null): Promise<void> | void
}

export interface ClientOptions {
  baseUrl: string
  kind: 'web' | 'native'
  session: SessionStore
  /** Active workspace; sent as X-Workspace-Id on workspace routes. */
  workspaceId: () => string | null
  /** The refresh failed for good: show the sign-in screen. */
  onSignedOut?: () => void
  fetch?: typeof fetch
}

/** Fresh key per user action; send the SAME key when retrying that action. */
export const idempotencyKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)

export function createApiClient(opts: ClientOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const base = opts.baseUrl.replace(/\/$/, '')
  let refreshing: Promise<boolean> | null = null
  const originals = new Map<string, Request>()

  /** Single-flight: concurrent 401s share one refresh (the API also tolerates a double refresh for ~10 s). */
  function refresh(): Promise<boolean> {
    refreshing ??= (async () => {
      try {
        const native = opts.kind === 'native'
        const refreshToken = native ? await opts.session.getRefreshToken?.() : null
        if (native && !refreshToken) return false
        const res = await doFetch(`${base}/api/v1/auth/refresh`, {
          method: 'POST',
          credentials: native ? 'omit' : 'include',
          headers: { 'Content-Type': 'application/json', ...(native ? { 'X-Client': 'native' } : { 'X-Requested-With': 'fetch' }) },
          body: JSON.stringify(native ? { refresh_token: refreshToken } : {}),
        })
        if (!res.ok) return false
        const body = (await res.json()) as { access_token: string; refresh_token?: string }
        opts.session.setAccessToken(body.access_token)
        if (native && body.refresh_token) await opts.session.setRefreshToken?.(body.refresh_token)
        return true
      } catch {
        return false
      } finally {
        setTimeout(() => (refreshing = null), 0)
      }
    })()
    return refreshing
  }

  const middleware: Middleware = {
    async onRequest({ request, id }) {
      const token = opts.session.getAccessToken()
      if (token) request.headers.set('Authorization', `Bearer ${token}`)
      const ws = opts.workspaceId()
      if (ws && !request.headers.has('X-Workspace-Id')) request.headers.set('X-Workspace-Id', ws)
      if (opts.kind === 'native') request.headers.set('X-Client', 'native')
      originals.set(id, request.clone())
      return request
    },
    async onResponse({ response, id }) {
      const original = originals.get(id)
      originals.delete(id)
      if (response.status !== 401 || !original) return undefined
      const code = (await response.clone().json().catch(() => ({}))) as { code?: string }
      if (code.code !== 'token_expired' && code.code !== 'unauthenticated') {
        if (code.code === 'session_revoked' || code.code === 'invalid_token') opts.onSignedOut?.()
        return undefined
      }
      if (!(await refresh())) {
        opts.session.setAccessToken(null)
        opts.onSignedOut?.()
        return undefined
      }
      const retry = original.clone()
      retry.headers.set('Authorization', `Bearer ${opts.session.getAccessToken()}`)
      return doFetch(retry)
    },
  }

  const client = createClient<paths>({ baseUrl: base, fetch: doFetch, credentials: opts.kind === 'web' ? 'include' : 'omit' })
  client.use(middleware)
  return client
}

/** Sign in. Web gets the refresh cookie; native gets `refresh_token` to put in the keychain. */
export async function signIn(opts: Pick<ClientOptions, 'baseUrl' | 'kind' | 'session'>, email: string, password: string) {
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/api/v1/auth/login`, {
    method: 'POST',
    credentials: opts.kind === 'web' ? 'include' : 'omit',
    headers: { 'Content-Type': 'application/json', ...(opts.kind === 'native' ? { 'X-Client': 'native' } : {}) },
    body: JSON.stringify({ email, password }),
  })
  const body = (await res.json()) as Schemas['LoginResult'] & Schemas['Problem']
  if (!res.ok) throw Object.assign(new Error(body.detail ?? body.title), { problem: body })
  opts.session.setAccessToken(body.access_token)
  if (opts.kind === 'native' && body.refresh_token) await opts.session.setRefreshToken?.(body.refresh_token)
  return body.user
}
