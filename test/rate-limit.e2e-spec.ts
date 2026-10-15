import { createTestApp, signUpAndLogin, TestApp, uniq } from './helpers/app'

/** Runs at the REAL limits (the other suites scale them up). */
describe('rate limiting', () => {
  let t: TestApp
  beforeAll(async () => {
    process.env.RATE_LIMIT_SCALE = '1'
    t = await createTestApp()
  })
  afterAll(async () => {
    await t.close()
    process.env.RATE_LIMIT_SCALE = '100'
  })

  it('forgot-password: 3 per hour per e-mail, 202 until then, then 429 with Retry-After', async () => {
    const email = `${uniq('rl')}@example.test`
    for (let i = 0; i < 3; i++) await t.http().post('/api/v1/auth/forgot-password').send({ email }).expect(202)
    const r = await t.http().post('/api/v1/auth/forgot-password').send({ email })
    expect(r.status).toBe(429)
    expect(r.body.code).toBe('rate_limited')
    expect(r.headers['retry-after']).toBe('3600')
    // a different address is unaffected
    await t.http().post('/api/v1/auth/forgot-password').send({ email: `${uniq('rl2')}@example.test` }).expect(202)
  })

  it('login: throttled per account before the lock-out even starts', async () => {
    const s = await signUpAndLogin(t)
    const codes: number[] = []
    for (let i = 0; i < 24; i++) codes.push((await t.http().post('/api/v1/auth/login').send({ email: s.email, password: 'wrong-password-123' })).status)
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true)
    expect(codes.slice(10).some((c) => c === 429)).toBe(true)
  })

  it('sign-up is limited per IP', async () => {
    let limited = 0
    for (let i = 0; i < 25; i++) {
      const r = await t.http().post('/api/v1/auth/sign-up').send({ name: 'Bulk', email: `${uniq('bulk')}@example.test`, password: 'correct-horse-battery-9', workspace_type: 'supervision', workspace_name: 'Bulk WS' })
      if (r.status === 429) limited++
    }
    expect(limited).toBeGreaterThan(0)
  })
})
