import RedisMock from 'ioredis-mock'
import { MemoryKv, RedisKv, Kv } from '../src/infra/kv'
import { createTestApp, TestApp } from './helpers/app'

describe('health, metrics, error format', () => {
  let t: TestApp
  beforeAll(async () => {
    process.env.METRICS_TOKEN = 'scrape-token-123'
    t = await createTestApp()
  })
  afterAll(async () => {
    delete process.env.METRICS_TOKEN
    await t.close()
  })

  it('/healthz is liveness only; /readyz checks the database and cache', async () => {
    expect((await t.http().get('/healthz')).body).toEqual({ status: 'ok' })
    const r = await t.http().get('/readyz').expect(200)
    expect(r.body).toEqual({ status: 'ready', cache: 'memory' })
  })

  it('/metrics takes the scraper\'s own bearer token (not a JWT) and exposes request and queue metrics', async () => {
    expect((await t.http().get('/metrics')).status).toBe(401)
    expect((await t.http().get('/metrics').set('Authorization', 'Bearer wrong')).status).toBe(401)
    const ok = await t.http().get('/metrics').set('Authorization', 'Bearer scrape-token-123').expect(200)
    expect(ok.text).toContain('http_request_duration_seconds_bucket')
    expect(ok.text).toContain('jobs_queue_depth')
    expect(ok.text).toContain('process_resident_memory_bytes')
  })

  it('serves the OpenAPI document (snake_case on the wire) and the Swagger UI in development', async () => {
    const doc = (await t.http().get('/api/v1/openapi.json').expect(200)).body
    expect(Object.keys(doc.paths).length).toBeGreaterThan(80)
    expect(doc.components.schemas.ProjectDetail).toBeDefined()
    expect(doc.components.schemas.Problem.properties).toHaveProperty('request_id') // snake_case rewrite applied
    const ui = await t.http().get('/api/v1/docs').redirects(1).expect(200)
    expect(ui.text).toMatch(/swagger/i)
  })

  it('unknown routes answer with problem+json and a request id; a sane inbound id is echoed', async () => {
    const r = await t.http().get('/api/v1/does-not-exist').set('X-Request-Id', 'trace-1234567890')
    expect(r.status).toBe(404)
    expect(r.headers['content-type']).toMatch(/problem\+json/)
    expect(r.body).toMatchObject({ status: 404, code: 'not_found' })
    expect(r.headers['x-request-id']).toBe('trace-1234567890')
    expect(r.body.request_id).toBe('trace-1234567890')
    const bad = await t.http().get('/healthz').set('X-Request-Id', 'x; DROP')
    expect(bad.headers['x-request-id']).not.toBe('x; DROP')
  })
})

describe.each([
  ['MemoryKv', () => new MemoryKv() as Kv],
  ['RedisKv (ioredis-mock; the real server is exercised in staging, see STATUS.md)', () => new RedisKv(new RedisMock() as never) as Kv],
])('%s', (_name, make) => {
  let kv: Kv
  beforeEach(async () => {
    kv = make()
  })

  it('counts within a window and starts the window on the first hit only', async () => {
    const k = `c:${Math.random()}`
    expect(await kv.incr(k, 60)).toBe(1)
    expect(await kv.incr(k, 60)).toBe(2)
    expect(await kv.incr(k, 60)).toBe(3)
  })

  it('get / set / del and ping', async () => {
    const k = `s:${Math.random()}`
    expect(await kv.get(k)).toBeNull()
    await kv.set(k, 'v', 30)
    expect(await kv.get(k)).toBe('v')
    await kv.del(k)
    expect(await kv.get(k)).toBeNull()
    expect(await kv.ping()).toBe(true)
  })

  it('values expire', async () => {
    const k = `e:${Math.random()}`
    await kv.set(k, 'v', 1)
    await new Promise((r) => setTimeout(r, 1200))
    expect(await kv.get(k)).toBeNull()
    expect(await kv.incr(k, 1)).toBe(1)
  })
})
