// Compile-time proof that responses are typed from the API contract.
import { createApiClient, idempotencyKey } from './index'

export async function example() {
  let access: string | null = null
  const api = createApiClient({
    baseUrl: 'http://localhost:8000',
    kind: 'web',
    session: { getAccessToken: () => access, setAccessToken: (t) => (access = t) },
    workspaceId: () => 'ws-id',
  })
  const { data: project } = await api.GET('/api/v1/projects/{id}', { params: { path: { id: 'x' } } })
  const canSubmit: boolean | undefined = project?.viewer.can_submit
  const firstPhase: string | undefined = project?.phases[0]?.status
  const list = await api.GET('/api/v1/projects', { params: { query: { scope: 'mine', limit: 20 } } })
  const next: string | null | undefined = list.data?.next_cursor
  await api.POST('/api/v1/phases/{id}/submissions', {
    params: { path: { id: 'phase' }, header: { 'Idempotency-Key': idempotencyKey() } },
    body: { note: 'ready' },
  })
  return { canSubmit, firstPhase, next }
}
