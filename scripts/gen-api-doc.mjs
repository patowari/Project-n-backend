// openapi.json -> docs/API.md  (an always-accurate endpoint catalogue)
//   npm run openapi:export && node scripts/gen-api-doc.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const doc = JSON.parse(readFileSync('openapi.json', 'utf8'))
const rows = []
for (const [path, item] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue
    const tag = op.tags?.[0] ?? 'misc'
    const body = op.requestBody?.content?.['application/json']?.schema?.$ref?.split('/').pop() ?? (op.requestBody ? 'multipart/object' : '')
    const ok = Object.entries(op.responses ?? {}).find(([code, r]) => /^2/.test(code) && r.content?.['application/json'])
    const res = ok ? (ok[1].content['application/json'].schema.$ref?.split('/').pop() ?? (ok[1].content['application/json'].schema.allOf ? 'ProjectDetail' : 'object')) : ''
    const status = Object.keys(op.responses ?? {}).find((c) => /^2/.test(c)) ?? '200'
    const pub = !(op.security?.length) && !path.includes('/healthz')
    const query = (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => `${p.name}${p.required ? '*' : ''}`).join(', ')
    rows.push({ tag, method: method.toUpperCase(), path, status, body, res, query, pub })
  }
}
const order = ['auth', 'me', 'organization', 'projects', 'phases', 'workflow', 'governance', 'insights', 'integrations', 'admin']
const tags = [...new Set(rows.map((r) => r.tag))].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))

let md = `# API reference

_Generated from the OpenAPI document by \`scripts/gen-api-doc.mjs\`. Do not edit by hand._
Live document: \`GET /api/v1/openapi.json\` (when enabled). ${rows.length} operations.

## Conventions

| Topic | Rule |
|---|---|
| Base path | \`/api/v1\` (versioned in the path; breaking changes go to \`/api/v2\`) |
| Wire format | JSON, **snake_case** keys. Dates are ISO 8601; due dates are \`YYYY-MM-DD\`. |
| Authentication | \`Authorization: Bearer <access token>\` (15 min). Web: refresh via httpOnly cookie. Native clients: send \`X-Client: native\` and keep the refresh token in the OS keychain. |
| Tenant | \`X-Workspace-Id: <uuid>\` on every workspace route. A user who is not an active member gets \`403 not_a_member\`. |
| Lists | Cursor pagination: \`?limit=&cursor=\` (max 100) returns \`{ items, next_cursor }\`. |
| Errors | RFC 9457 problem details (\`application/problem+json\`): \`{ type, title, status, code, detail?, errors?[], request_id }\`. Branch on \`code\`, never on \`detail\`. |
| Idempotency | \`Idempotency-Key\` on \`POST /projects\` and \`POST /phases/{id}/submissions\`: same key + same body returns the stored result (\`Idempotent-Replay: true\`); same key + different body is \`422 idempotency_key_reuse\`. |
| Concurrency | Project edits honour \`If-Match: "v<version>"\` (the \`ETag\` of \`GET /projects/{id}\`), \`412 version_mismatch\` on conflict. State changes (submit, review, approve, extend) take row locks and answer \`409\` with a specific \`code\` to the loser of a race. |
| Rate limits | \`429 rate_limited\` with \`Retry-After\`. Auth endpoints are limited per IP and per account. |
| Request id | \`X-Request-Id\` is returned on every response and appears in logs and problem bodies. |

\`*\` after a query parameter means required. "public" means no bearer token.

`
for (const tag of tags) {
  md += `\n## ${tag}\n\n| Method | Path | Success | Request body | Response | Query |\n|---|---|---|---|---|---|\n`
  for (const r of rows.filter((x) => x.tag === tag)) {
    md += `| ${r.method} | \`${r.path.replace('/api/v1', '')}\`${r.pub ? ' _(public)_' : ''} | ${r.status} | ${r.body ? '`' + r.body + '`' : ''} | ${r.res ? '`' + r.res + '`' : ''} | ${r.query} |\n`
  }
}
writeFileSync('docs/API.md', md)
console.log(`docs/API.md: ${rows.length} operations in ${tags.length} groups`)
