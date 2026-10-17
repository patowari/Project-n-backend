import { Inject, Injectable } from '@nestjs/common'
import { ENV, Env } from '../config/env'
import { GoogleProfile, IdentityError, IdentityPort } from './identity.port'

const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/**
 * Google OpenID Connect over plain HTTPS.
 *
 * The ID token is received directly from Google's token endpoint over TLS, which (OIDC Core 3.1.3.7)
 * is sufficient proof of origin, so the signature is not re-checked. Every claim that matters is:
 * issuer, audience (our client id), expiry, nonce, and `email_verified`.
 *
 * NOTE: written to Google's documented API; NOT exercised against live Google in this repository
 * (no credentials). See docs/INTEGRATIONS.md, "Verifying Google sign-in".
 */
@Injectable()
export class GoogleIdentityGateway extends IdentityPort {
  constructor(@Inject(ENV) private env: Env) {
    super()
  }

  private redirectUri() {
    return `${this.env.googleRedirectBase}/auth/google/callback`
  }

  authorizeUrl(p: { state: string; nonce: string; codeChallenge: string }): string {
    const q = new URLSearchParams({
      client_id: this.env.googleClientId ?? '',
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
  }

  async exchange(code: string, codeVerifier: string, nonce: string): Promise<GoogleProfile> {
    let r: Response
    try {
      r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.env.googleClientId ?? '',
          client_secret: this.env.googleClientSecret ?? '',
          redirect_uri: this.redirectUri(),
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new IdentityError('Google is unreachable')
    }
    const j = (await r.json().catch(() => ({}))) as { id_token?: string; error?: string }
    if (!r.ok || !j.id_token) throw new IdentityError(j.error ?? 'token exchange failed')

    const parts = j.id_token.split('.')
    if (parts.length !== 3) throw new IdentityError('malformed id_token')
    let c: { iss?: string; aud?: string; exp?: number; nonce?: string; sub?: string; email?: string; email_verified?: boolean | string; name?: string; picture?: string }
    try {
      c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    } catch {
      throw new IdentityError('malformed id_token')
    }
    if (!c.iss || !ISSUERS.includes(c.iss)) throw new IdentityError('wrong issuer')
    if (c.aud !== this.env.googleClientId) throw new IdentityError('wrong audience')
    if (!c.exp || c.exp * 1000 < Date.now()) throw new IdentityError('expired id_token')
    if (c.nonce !== nonce) throw new IdentityError('nonce mismatch')
    if (!c.sub || !c.email) throw new IdentityError('missing claims')
    return {
      sub: c.sub,
      email: c.email.trim().toLowerCase(),
      emailVerified: c.email_verified === true || c.email_verified === 'true',
      name: (c.name ?? c.email.split('@')[0]).slice(0, 120),
      picture: c.picture ?? null,
    }
  }
}
