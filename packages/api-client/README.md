# @projectn/api-client

Typed client for the Project N REST API, shared by the React web app, a React Native app and the Tauri desktop app.

* `src/schema.d.ts` is **generated** from the API's OpenAPI document (`npm run client:generate` in `backend/`). CI fails if it is out of date. Request bodies, query parameters and responses are typed; keys are **snake_case**, exactly as on the wire.
* `src/index.ts` wraps [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) with bearer token + `X-Workspace-Id` injection, single-flight refresh on `token_expired`, and idempotency keys.
* `src/typecheck.ts` is a compile-time proof that responses are typed.

```ts
import { createApiClient, signIn, idempotencyKey } from '@projectn/api-client'

let access: string | null = null
const session = { getAccessToken: () => access, setAccessToken: (t: string | null) => (access = t) }

const api = createApiClient({
  baseUrl: 'https://api.example.com',
  kind: 'web',                         // 'native' for React Native / Tauri
  session,
  workspaceId: () => activeWorkspaceId,
  onSignedOut: () => navigate('/sign-in'),
})

await signIn({ baseUrl, kind: 'web', session }, email, password)
const { data } = await api.GET('/api/v1/projects/{id}', { params: { path: { id } } })
data?.viewer.can_submit               // boolean, typed

await api.POST('/api/v1/phases/{id}/submissions', {
  params: { path: { id: phaseId }, header: { 'Idempotency-Key': idempotencyKey() } },
  body: { note: 'ready' },
})
```

## Where each client keeps its credentials

| Client | Access token (15 min) | Refresh token (30 days, rotating) |
|---|---|---|
| Web | memory | httpOnly cookie set by the API (the app never sees it) |
| React Native | memory | `expo-secure-store` (iOS Keychain / Android Keystore): implement `getRefreshToken` / `setRefreshToken` |
| Tauri | memory | OS keyring or `tauri-plugin-stronghold` |

Never put either token in `localStorage`, `AsyncStorage` or a URL.

## Not the existing web app's client

`dashboard-ui` has its own Axios layer that converts keys to camelCase. It keeps working unchanged. This package is for new clients, or a future migration of the web app.
