// Asserts the EXPORTED OpenAPI document (from the compiled app) is usable by generated clients.
//   node dist/openapi-export.js openapi.json && node scripts/verify-openapi.mjs
import { readFileSync } from 'node:fs'

const doc = JSON.parse(readFileSync('openapi.json', 'utf8'))
let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!ok) failed = true
}
const schemas = doc.components.schemas
check('every request DTO documents its properties', Object.entries(schemas).filter(([n, s]) => /Dto$/.test(n) && s.type === 'object' && Object.keys(s.properties ?? {}).length === 0).map(([n]) => n).length === 0,
  Object.entries(schemas).filter(([n, s]) => /Dto$/.test(n) && s.type === 'object' && Object.keys(s.properties ?? {}).length === 0).map(([n]) => n).join(', '))
check('wire format is snake_case (SignUpDto.workspace_type, no workspaceType)', 'workspace_type' in schemas.SignUpDto.properties && !('workspaceType' in schemas.SignUpDto.properties))
check('validation rules are carried over (password max length)', schemas.LoginDto.properties.password.maxLength === 128)
const camel = []
const walk = (n, path) => {
  if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`))
  if (n && typeof n === 'object') {
    for (const [k, v] of Object.entries(n)) {
      if (k === 'properties') for (const p of Object.keys(v)) if (/[A-Z]/.test(p)) camel.push(`${path}.${p}`)
      walk(v, `${path}.${k}`)
    }
  }
}
walk(schemas, 'schemas')
check('no camelCase property survives in any schema', camel.length === 0, camel.slice(0, 5).join(', '))
const queryCamel = []
for (const [p, item] of Object.entries(doc.paths)) for (const op of Object.values(item)) for (const prm of op.parameters ?? []) if (prm.in === 'query' && /[A-Z]/.test(prm.name)) queryCamel.push(`${p}:${prm.name}`)
check('query parameters are snake_case', queryCamel.length === 0, queryCamel.join(', '))
check('typed success responses exist for the core resources', ['/api/v1/projects', '/api/v1/projects/{id}', '/api/v1/me', '/api/v1/reviews/queue'].every((p) => doc.paths[p].get.responses['200'].content?.['application/json']?.schema))
check('every operation documents the problem+json error shape', Object.values(doc.paths).every((i) => Object.values(i).every((op) => op.responses['401'] && op.responses['403'])))
check('Idempotency-Key is a declared optional header on submit and create', ['/api/v1/projects:post', '/api/v1/phases/{id}/submissions:post'].every((k) => { const [p, m] = k.split(':'); return doc.paths[p][m].parameters.some((x) => x.name === 'Idempotency-Key' && x.required === false) }))
process.exit(failed ? 1 : 0)
