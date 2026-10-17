export interface GoogleProfile {
  /** Stable Google account id (`sub`). Never changes, unlike the e-mail address. */
  sub: string
  email: string
  emailVerified: boolean
  name: string
  picture: string | null
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message)
  }
}

/**
 * "Sign in with Google" (OpenID Connect, authorization-code flow with PKCE). Identity only: scopes
 * are `openid email profile`, so this is a different consent from the Drive connection.
 *
 * Implementations: `GoogleIdentityGateway` (production) and `FakeIdentityGateway` (development, tests).
 */
export abstract class IdentityPort {
  abstract authorizeUrl(p: { state: string; nonce: string; codeChallenge: string }): string
  /** Exchanges the code and returns the VERIFIED profile. Throws `IdentityError` on any problem. */
  abstract exchange(code: string, codeVerifier: string, nonce: string): Promise<GoogleProfile>
}
