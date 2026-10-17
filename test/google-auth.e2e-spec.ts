import { createTestApp, login, PASSWORD, Session, sessionFor, signUpAndLogin, TestApp, uniq } from './helpers/app'

/**
 * Google sign-in / sign-up / link against the fake identity provider. The fake's "code" carries the
 * identity, so each test can play a different Google account: fake-google:<sub>:<email>:<name>[:unverified]
 */
describe('google sign-in', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(() => t.close())

  const sub = () => uniq('gsub')
  const mail = () => `${uniq('g')}@example.test`

  async function start(body: object, s?: Session) {
    const r = s ? await s.post('/auth/google/link', undefined, null).expect(200) : await t.http().post('/api/v1/auth/google/start').send(body).expect(200)
    const url = new URL(r.body.authorize_url)
    return url.searchParams.get('state')!
  }

  /** Plays Google's redirect back to us. */
  async function callback(state: string, id: { sub: string; email: string; name?: string; unverified?: boolean }) {
    const code = `fake-google:${id.sub}:${id.email}:${id.name ?? 'Google Person'}${id.unverified ? ':unverified' : ''}`
    const res = await t.http().get('/api/v1/auth/google/callback').query({ state, code })
    const loc = new URL(res.headers.location)
    const cookie = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('pn_refresh='))
    return { status: res.status, loc, q: Object.fromEntries(loc.searchParams), cookie: cookie?.split(';')[0] }
  }

  async function sessionFromCookie(cookie: string): Promise<Session> {
    const r = await t.http().post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-Requested-With', 'x').expect(200)
    const me = await t.http().get('/api/v1/me').set('Authorization', `Bearer ${r.body.access_token}`).expect(200)
    return sessionFor(t, r.body.access_token, me.body.id, me.body.email, cookie, me.body.memberships?.[0]?.workspace?.id)
  }

  it('start returns a Google URL; the redirect target is the app, not an open redirect', async () => {
    const r = await t.http().post('/api/v1/auth/google/start').send({ mode: 'sign_in', next: 'https://evil.example/steal' }).expect(200)
    expect(r.body.authorize_url).toContain('/auth/google/callback')
    const state = new URL(r.body.authorize_url).searchParams.get('state')!
    const out = await callback(state, { sub: sub(), email: mail() })
    expect(out.status).toBe(302)
    expect(out.loc.pathname).toBe('/google-callback')
  })

  it('sign-in without an account does not create one', async () => {
    const email = mail()
    const out = await callback(await start({ mode: 'sign_in' }), { sub: sub(), email })
    expect(out.q).toMatchObject({ error: 'no_account', email })
    expect(out.cookie).toBeUndefined()
    expect(await t.sys.user.count({ where: { email } })).toBe(0)
  })

  it('sign-up needs a workspace', async () => {
    const r = await t.http().post('/api/v1/auth/google/start').send({ mode: 'sign_up' }).expect(422)
    expect(r.body.code).toBe('workspace_required')
  })

  it('sign-up creates a verified, password-less account with its workspace, then signs in', async () => {
    const email = mail()
    const id = { sub: sub(), email, name: 'Dr Google' }
    const out = await callback(await start({ mode: 'sign_up', workspace_type: 'supervision', workspace_name: 'Google Lab', next: '/projects' }), id)
    expect(out.q).toMatchObject({ status: 'created', next: '/projects' })
    expect(out.cookie).toBeTruthy()

    const u = await t.sys.user.findUniqueOrThrow({ where: { email } })
    expect(u.googleSub).toBe(id.sub)
    expect(u.passwordHash).toBeNull()
    expect(u.emailVerifiedAt).not.toBeNull()

    const s = await sessionFromCookie(out.cookie!)
    const me = await s.get('/me', null).expect(200)
    expect(me.body.email_verified).toBe(true)
    expect(me.body.memberships[0].roles.map((r: any) => r.role).sort()).toEqual(['supervision_owner', 'supervisor'])
    expect((await s.get('/me/security', null).expect(200)).body.google_linked).toBe(true)

    // password sign-in is not possible for a Google-only account
    await t.http().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(401)

    // second time: plain sign-in, same account
    const again = await callback(await start({ mode: 'sign_in' }), id)
    expect(again.q.status).toBe('ok')
    expect(again.cookie).toBeTruthy()
    expect(await t.sys.user.count({ where: { email } })).toBe(1)
  })

  it('institution sign-ups through Google wait for approval, like e-mail sign-ups', async () => {
    const email = mail()
    await callback(await start({ mode: 'sign_up', workspace_type: 'institution', workspace_name: 'Pending Google U' }), { sub: sub(), email })
    const ws = await t.sys.workspace.findFirstOrThrow({ where: { memberships: { some: { user: { email } } } } })
    expect(ws.status).toBe('pending_approval')
  })

  it('links to an existing verified account by e-mail and keeps the password working', async () => {
    const owner = await signUpAndLogin(t)
    const out = await callback(await start({ mode: 'sign_in' }), { sub: sub(), email: owner.email })
    expect(out.q.status).toBe('ok')
    const u = await t.sys.user.findUniqueOrThrow({ where: { email: owner.email } })
    expect(u.googleSub).not.toBeNull()
    expect(u.passwordHash).not.toBeNull()
    await login(t, owner.email) // password still works
    // same person, same account: no second user
    expect(await t.sys.user.count({ where: { email: owner.email } })).toBe(1)
  })

  it('takeover guard: an unverified pre-registered account loses its password when the real owner signs in with Google', async () => {
    const attacker = await signUpAndLogin(t, { verify: false }) // someone registered this address first
    const out = await callback(await start({ mode: 'sign_in' }), { sub: sub(), email: attacker.email })
    expect(out.q.status).toBe('ok')

    await t.http().post('/api/v1/auth/login').send({ email: attacker.email, password: PASSWORD }).expect(401)
    // the attacker's old session is dead too
    await attacker.get('/me', null).expect(401)
    const u = await t.sys.user.findUniqueOrThrow({ where: { email: attacker.email } })
    expect(u.passwordHash).toBeNull()
    expect(u.emailVerifiedAt).not.toBeNull()
  })

  it('refuses a different Google account for an e-mail already linked to another', async () => {
    const email = mail()
    const first = { sub: sub(), email }
    await callback(await start({ mode: 'sign_up', workspace_type: 'supervision', workspace_name: 'First' }), first)
    const out = await callback(await start({ mode: 'sign_in' }), { sub: sub(), email })
    expect(out.q.error).toBe('different_account')
    expect(out.cookie).toBeUndefined()
  })

  it('refuses Google accounts whose e-mail Google has not verified', async () => {
    const out = await callback(await start({ mode: 'sign_up', workspace_type: 'supervision', workspace_name: 'Xy Lab' }), { sub: sub(), email: mail(), unverified: true })
    expect(out.q.error).toBe('email_not_verified')
  })

  it('state is single-use and unknown states are rejected', async () => {
    const state = await start({ mode: 'sign_in' })
    const id = { sub: sub(), email: mail() }
    expect((await callback(state, id)).q.error).toBe('no_account')
    expect((await callback(state, id)).q.error).toBe('expired')
    expect((await callback('made-up-state', id)).q.error).toBe('expired')
  })

  it('a denied consent screen is reported, nothing is created', async () => {
    const state = await start({ mode: 'sign_in' })
    const res = await t.http().get('/api/v1/auth/google/callback').query({ state, error: 'access_denied' })
    expect(new URL(res.headers.location).searchParams.get('error')).toBe('denied')
  })

  it('deactivated accounts cannot sign in with Google', async () => {
    const owner = await signUpAndLogin(t)
    await t.sys.user.update({ where: { email: owner.email }, data: { status: 'deactivated' } })
    const out = await callback(await start({ mode: 'sign_in' }), { sub: sub(), email: owner.email })
    expect(out.q.error).toBe('account_disabled')
    expect(out.cookie).toBeUndefined()
  })

  describe('linking from settings', () => {
    it('links, refuses a Google account owned by someone else, and unlinks', async () => {
      const a = await signUpAndLogin(t)
      const b = await signUpAndLogin(t)
      const id = { sub: sub(), email: mail() } // the Google address need not match the account e-mail

      const linked = await callback(await start({}, a), id)
      expect(linked.loc.pathname).toBe('/settings/security')
      expect(linked.q.google).toBe('linked')
      expect((await a.get('/me/security', null).expect(200)).body.google_linked).toBe(true)

      const clash = await callback(await start({}, b), id)
      expect(clash.q.google).toBe('in_use')
      expect((await b.get('/me/security', null).expect(200)).body.google_linked).toBe(false)

      // signing in with that Google account now lands in A
      const viaGoogle = await callback(await start({ mode: 'sign_in' }), id)
      const s = await sessionFromCookie(viaGoogle.cookie!)
      expect(s.userId).toBe(a.userId)

      await a.del('/auth/google', null).expect(204)
      expect((await a.get('/me/security', null).expect(200)).body.google_linked).toBe(false)
      expect((await callback(await start({ mode: 'sign_in' }), id)).q.error).toBe('no_account')
    })

    it('a Google-only account cannot unlink until it has a password', async () => {
      const out = await callback(await start({ mode: 'sign_up', workspace_type: 'supervision', workspace_name: 'Only Google' }), { sub: sub(), email: mail() })
      const s = await sessionFromCookie(out.cookie!)
      const r = await s.del('/auth/google', null).expect(409)
      expect(r.body.code).toBe('password_required')
      expect((await s.get('/me/security', null).expect(200)).body.google_linked).toBe(true)
    })

    it('linking requires being signed in', async () => {
      await t.http().post('/api/v1/auth/google/link').expect(401)
      await t.http().delete('/api/v1/auth/google').expect(401)
    })
  })
})
