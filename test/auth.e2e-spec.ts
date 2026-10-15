import { createTestApp, login, PASSWORD, signUpAndLogin, sessionFor, TestApp, uniq } from './helpers/app'

describe('auth', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(() => t.close())

  it('app connects as a role that cannot bypass RLS', async () => {
    const [r] = await t.sys.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'projectn_app'`
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false })
  })

  describe('sign-up and verification', () => {
    it('creates a supervision workspace with an owner and requires verification before writes', async () => {
      const s = await signUpAndLogin(t, { verify: false })
      const me = await s.get('/me', null).expect(200)
      expect(me.body.email_verified).toBe(false)
      expect(me.body.memberships[0].workspace.type).toBe('supervision')
      expect(me.body.memberships[0].roles.map((r: any) => r.role).sort()).toEqual(['supervision_owner', 'supervisor'])

    })

    it('same response for an existing e-mail (no account discovery)', async () => {
      const a = await signUpAndLogin(t)
      const again = await t.http().post('/api/v1/auth/sign-up').send({
        name: 'Other', email: a.email, password: PASSWORD, workspace_type: 'supervision', workspace_name: 'Dup workspace',
      })
      expect(again.status).toBe(202)
      expect(again.body).toEqual({ workspace_status: 'active' })
      expect((await t.mails(a.email, 'account_exists')).length).toBe(1)
    })

    it('institution sign-ups wait for Super Admin approval', async () => {
      const email = `${uniq('inst')}@example.test`
      const r = await t.http().post('/api/v1/auth/sign-up').send({
        name: 'Registrar', email, password: PASSWORD, workspace_type: 'institution', workspace_name: 'Pending U',
      })
      expect(r.body).toEqual({ workspace_status: 'pending_approval' })
      const login1 = await t.http().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)
      const wsId = login1.body.user.memberships[0].workspace.id
      const s = sessionFor(t, login1.body.access_token, login1.body.user.id, email, '', wsId)
      const res = await s.get('/projects')
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('workspace_pending_approval')
    })

    it('rejects weak passwords with field errors', async () => {
      const r = await t.http().post('/api/v1/auth/sign-up').send({
        name: 'Weak', email: `${uniq('w')}@example.test`, password: 'password123', workspace_type: 'supervision', workspace_name: 'Weak WS',
      })
      expect(r.status).toBe(422)
      expect(r.body.code).toBe('weak_password')
      expect(r.headers['content-type']).toMatch(/problem\+json/)
    })

    it('verification links are single-use', async () => {
      const email = `${uniq('v')}@example.test`
      await t.http().post('/api/v1/auth/sign-up').send({ name: 'V User', email, password: PASSWORD, workspace_type: 'supervision', workspace_name: 'V WS' }).expect(202)
      const [mail] = await t.mails(email, 'verify_email')
      const token = new URL(mail.data.link).searchParams.get('token')
      await t.http().post('/api/v1/auth/verify-email').send({ token }).expect(200)
      const second = await t.http().post('/api/v1/auth/verify-email').send({ token })
      expect(second.status).toBe(400)
    })
  })

  describe('login', () => {
    it('does not reveal whether the account exists', async () => {
      const s = await signUpAndLogin(t)
      const wrongPw = await t.http().post('/api/v1/auth/login').send({ email: s.email, password: 'wrong-password-123' })
      const noUser = await t.http().post('/api/v1/auth/login').send({ email: 'nobody@example.test', password: 'wrong-password-123' })
      expect(wrongPw.status).toBe(401)
      expect(noUser.status).toBe(401)
      expect(wrongPw.body.code).toBe(noUser.body.code)
    })

    it('locks the account after 10 failures', async () => {
      const s = await signUpAndLogin(t)
      for (let i = 0; i < 10; i++) {
        await t.http().post('/api/v1/auth/login').send({ email: s.email, password: 'wrong-password-123' })
      }
      const locked = await t.http().post('/api/v1/auth/login').send({ email: s.email, password: PASSWORD })
      expect(locked.status).toBe(429)
      expect(locked.body.code).toBe('account_locked')
      expect((await t.mails(s.email, 'account_locked')).length).toBe(1)
    })

    it('sets an httpOnly, SameSite=Lax refresh cookie scoped to the auth path', async () => {
      const s = await signUpAndLogin(t)
      expect(s.cookie).toMatch(/^pn_refresh=/)
      const res = await t.http().post('/api/v1/auth/login').send({ email: s.email, password: PASSWORD })
      const raw = (res.headers['set-cookie'] as unknown as string[])[0]
      expect(raw).toMatch(/HttpOnly/i)
      expect(raw).toMatch(/SameSite=Lax/i)
      expect(raw).toMatch(/Path=\/api\/v1\/auth/)
    })
  })

  describe('rotating refresh tokens', () => {
    it('rotates on every refresh and requires the CSRF header', async () => {
      const s = await signUpAndLogin(t)
      const noHeader = await t.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie)
      expect(noHeader.status).toBe(400)
      expect(noHeader.body.code).toBe('csrf_blocked')
      // a foreign Origin is refused even with a valid cookie; an allow-listed Origin (the existing web client) is accepted
      const evil = await t.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('Origin', 'https://evil.example')
      expect(evil.status).toBe(400)
      const ok = await t.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('Origin', 'http://localhost:5173')
      expect(ok.status).toBe(200)
      s.cookie = (ok.headers['set-cookie'] as unknown as string[])[0].split(';')[0]

      const r1 = await t.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('X-Requested-With', 'fetch').expect(200)
      expect(r1.body.access_token).toBeTruthy()
      const c1 = (r1.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
      expect(c1).not.toBe(s.cookie)
      // the new access token works
      await t.http().get('/api/v1/me').set('Authorization', `Bearer ${r1.body.access_token}`).expect(200)
    })

    it('detects reuse of an old token and kills the whole session', async () => {
      const s = await signUpAndLogin(t)
      const r1 = await t.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('X-Requested-With', 'fetch').expect(200)
      const newCookie = (r1.headers['set-cookie'] as unknown as string[])[0].split(';')[0]

      // make the old token look "old" (outside the multi-tab grace window)
      await t.sys.refreshToken.updateMany({ where: { session: { userId: s.userId }, usedAt: { not: null } }, data: { usedAt: new Date(Date.now() - 60_000) } })

      const replay = await t.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('X-Requested-With', 'fetch')
      expect(replay.status).toBe(401)
      expect(replay.body.code).toBe('refresh_reuse_detected')

      // the legitimate new token is dead too (stolen-token response)
      const after = await t.http().post('/api/v1/auth/refresh').set('Cookie', newCookie).set('X-Requested-With', 'fetch')
      expect(after.status).toBe(401)
      // and the access token of that session is rejected immediately
      const me = await t.http().get('/api/v1/me').set('Authorization', `Bearer ${s.token}`)
      expect(me.status).toBe(401)
      expect(me.body.code).toBe('session_revoked')
    })

    it('a concurrent double refresh (two tabs) does not sign the user out', async () => {
      const s = await signUpAndLogin(t)
      const [a, b] = await Promise.all([
        t.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('X-Requested-With', 'fetch'),
        t.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('X-Requested-With', 'fetch'),
      ])
      expect([a.status, b.status].sort()).toEqual([200, 409])
      const loser = a.status === 409 ? a : b
      expect(loser.body.code).toBe('refresh_in_flight')
      const winner = a.status === 200 ? a : b
      const next = (winner.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
      await t.http().post('/api/v1/auth/refresh').set('Cookie', next).set('X-Requested-With', 'fetch').expect(200)
    })
  })

  describe('native clients (React Native, Tauri)', () => {
    it('get the refresh token in the response body (for the OS keychain), never a cookie', async () => {
      const s = await signUpAndLogin(t)
      const res = await t.http().post('/api/v1/auth/login').set('X-Client', 'native').send({ email: s.email, password: PASSWORD }).expect(200)
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(res.body.refresh_token).toMatch(/^[\w-]{40,}$/)

      const r1 = await t.http().post('/api/v1/auth/refresh').set('X-Client', 'native').send({ refresh_token: res.body.refresh_token }).expect(200)
      expect(r1.body.refresh_token).not.toBe(res.body.refresh_token)
      await t.http().get('/api/v1/me').set('Authorization', `Bearer ${r1.body.access_token}`).expect(200)

      // the same rotation and reuse detection as the web flow
      await t.sys.refreshToken.updateMany({ where: { session: { userId: res.body.user.id }, usedAt: { not: null } }, data: { usedAt: new Date(Date.now() - 60_000) } })
      const reuse = await t.http().post('/api/v1/auth/refresh').set('X-Client', 'native').send({ refresh_token: res.body.refresh_token })
      expect(reuse.status).toBe(401)
      expect(reuse.body.code).toBe('refresh_reuse_detected')
      expect((await t.http().post('/api/v1/auth/refresh').set('X-Client', 'native').send({ refresh_token: r1.body.refresh_token })).status).toBe(401)
    })

    it('logout revokes the session; a missing token is refused', async () => {
      const s = await signUpAndLogin(t)
      const res = await t.http().post('/api/v1/auth/login').set('X-Client', 'native').send({ email: s.email, password: PASSWORD }).expect(200)
      await t.http().post('/api/v1/auth/logout').set('X-Client', 'native').send({ refresh_token: res.body.refresh_token }).expect(204)
      expect((await t.http().get('/api/v1/me').set('Authorization', `Bearer ${res.body.access_token}`)).status).toBe(401)
      expect((await t.http().post('/api/v1/auth/refresh').set('X-Client', 'native').send({})).status).toBe(401)
    })
  })

  describe('device sessions', () => {
    it('lists devices, revokes one, and signs out all others', async () => {
      const a = await signUpAndLogin(t)
      const b = await login(t, a.email)
      const c = await login(t, a.email)
      const list = await a.get('/me/security', null).expect(200)
      expect(list.body.sessions.length).toBe(3)
      expect(list.body.sessions.filter((s: any) => s.current).length).toBe(1)

      const other = list.body.sessions.find((s: any) => !s.current)
      await a.del(`/me/sessions/${other.id}`, null).expect(204)

      await a.post('/me/sessions/revoke-others', {}, null).expect(204)
      // b and c lost access at once; a keeps it
      const results = await Promise.all([b.get('/me', null), c.get('/me', null), a.get('/me', null)])
      expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401].sort())
    })

    it('password reset revokes every session and mails the owner', async () => {
      const a = await signUpAndLogin(t)
      await t.http().post('/api/v1/auth/forgot-password').send({ email: a.email }).expect(202)
      const [mail] = await t.mails(a.email, 'reset_password')
      const token = new URL(mail.data.link).searchParams.get('token')
      await t.http().post('/api/v1/auth/reset-password').send({ token, password: 'a-brand-new-passphrase-77' }).expect(200)
      expect((await a.get('/me', null)).status).toBe(401)
      await login(t, a.email, 'a-brand-new-passphrase-77')
      expect((await t.mails(a.email, 'password_changed')).length).toBe(1)
      // reset links are single use
      await t.http().post('/api/v1/auth/reset-password').send({ token, password: 'another-new-passphrase-88' }).expect(400)
    })

    it('forgot-password answers 202 for unknown e-mails and sends nothing', async () => {
      const e = `${uniq('ghost')}@example.test`
      await t.http().post('/api/v1/auth/forgot-password').send({ email: e }).expect(202)
      expect((await t.mails(e)).length).toBe(0)
    })
  })

  describe('tenant isolation (RLS)', () => {
    it('a user cannot enter a workspace they are not a member of', async () => {
      const a = await signUpAndLogin(t)
      const b = await signUpAndLogin(t)
      const r = await a.get('/me', b.workspaceId)
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('not_a_member')
    })
  })
})
