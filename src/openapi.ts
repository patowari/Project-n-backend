import { INestApplication } from '@nestjs/common'
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger'
import { toSnake } from './common/case'
import { Env } from './config/env'
import { RESPONSES, SCHEMAS } from './openapi-schemas'

type Json = Record<string, unknown>

/** The wire format is snake_case while DTOs are camelCase: rewrite the document to match. */
function snakeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(snakeSchema)
  if (!node || typeof node !== 'object') return node
  const o = node as Json
  const out: Json = {}
  for (const [k, v] of Object.entries(o)) {
    if (k === 'properties' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [toSnake(pk), snakeSchema(pv)]))
    } else if (k === 'required' && Array.isArray(v)) {
      out[k] = v.map((r) => (typeof r === 'string' ? toSnake(r) : r))
    } else out[k] = snakeSchema(v)
  }
  return out
}

/** Query parameters that are mandatory; everything else is optional. */
const REQUIRED_QUERY: Record<string, string[]> = {
  'GET /api/v1/calendar': ['from', 'to'],
  'GET /api/v1/comments': ['project_id'],
  'GET /api/v1/time-logs': ['project_id'],
  'GET /api/v1/people': ['role'],
}
const IDEMPOTENT_OPS = new Set(['POST /api/v1/projects', 'POST /api/v1/phases/{id}/submissions'])
const QUERY_TYPES: Record<string, Json> = {
  limit: { type: 'integer', minimum: 1, maximum: 100 },
  scope: { type: 'string', enum: ['mine', 'all'] },
  health: { type: 'array', items: { type: 'string', enum: ['on_track', 'at_risk', 'overdue', 'awaiting_review', 'completed'] } },
  status: { type: 'array', items: { type: 'string' } },
  mine: { type: 'boolean' },
  unread: { type: 'boolean' },
  overrides_only: { type: 'boolean' },
  from: { type: 'string', format: 'date' },
  to: { type: 'string', format: 'date' },
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Project N API')
    .setDescription(
      'Project & assignment tracking. JSON is snake_case on the wire. Send `Authorization: Bearer <access token>` and `X-Workspace-Id` on workspace routes. Errors are RFC 9457 problem details.'
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Workspace-Id' }, 'workspace')
    .build()
  const doc = SwaggerModule.createDocument(app, config)
  // Query/header parameter names are snake_case on the wire; path params keep their names.
  for (const item of Object.values(doc.paths)) {
    for (const op of Object.values(item as Json)) {
      const params = (op as { parameters?: { name: string; in: string }[] }).parameters
      params?.forEach((p) => {
        if (p.in === 'query') p.name = toSnake(p.name)
      })
    }
  }
  doc.components ??= {}
  doc.components.schemas = { ...(doc.components.schemas ?? {}), ...(SCHEMAS as Record<string, never>) }
  const WORKSPACE_FREE = ['/api/v1/auth', '/api/v1/me', '/api/v1/admin', '/api/v1/integrations', '/api/v1/invites', '/healthz', '/readyz']
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item as Json)) {
      const operation = op as { parameters?: unknown[]; responses?: Record<string, unknown> }
      const key = `${method.toUpperCase()} ${path}`
      const typed = RESPONSES[key]
      operation.responses ??= {}
      if (typed) {
        const status = String(typed.status ?? (method === 'post' ? 201 : 200))
        operation.responses[status] = { description: 'OK', content: { 'application/json': { schema: typed.schema } } }
      }
      for (const code of ['400', '401', '403', '404', '409', '422', '429']) {
        operation.responses[code] ??= { description: 'Problem details (RFC 9457)', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } }
      }
      if (!WORKSPACE_FREE.some((p) => path.startsWith(p))) {
        // Optional in the types: the generated client injects it from its workspace callback.
        operation.parameters = [...(operation.parameters ?? []), { name: 'X-Workspace-Id', in: 'header', required: false, schema: { type: 'string', format: 'uuid' }, description: 'The active workspace (selects the tenant)' }]
      }
      // Header parameters taken with @Headers() are optional inputs, not requirements.
      operation.parameters = ((operation.parameters ?? []) as { name: string; in: string; required?: boolean }[])
        .filter((p) => !(p.in === 'header' && p.name === 'idempotency-key'))
        .map((p) => (p.in === 'header' ? { ...p, required: false } : p))
      if (IDEMPOTENT_OPS.has(key)) {
        operation.parameters = [...(operation.parameters ?? []), { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Same key + same body = same result; safe to retry' }]
      }
      for (const p of (operation.parameters ?? []) as { name: string; in: string; schema?: Json }[]) {
        if (p.in === 'query' && QUERY_TYPES[p.name]) p.schema = QUERY_TYPES[p.name]
        if (p.in === 'query') (p as { required?: boolean }).required = (REQUIRED_QUERY[key] ?? []).includes(p.name)
      }
    }
  }
  return snakeSchema(doc) as OpenAPIObject
}

export function setupOpenApi(app: INestApplication, env: Env) {
  if (env.isProd && process.env.EXPOSE_DOCS !== 'true') return
  // Swagger UI is served from the API itself (bundled assets, no CDN) at /api/v1/docs;
  // the machine-readable document is at /api/v1/openapi.json.
  SwaggerModule.setup('api/v1/docs', app, buildOpenApi(app), { jsonDocumentUrl: 'api/v1/openapi.json', customSiteTitle: 'Project N API' })
}
