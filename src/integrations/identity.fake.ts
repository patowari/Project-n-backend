import { Injectable } from '@nestjs/common'
import { GoogleProfile, IdentityError, IdentityPort } from './identity.port'

/**
 * Development / test stand-in for Google sign-in. The "consent screen" is our own callback, and the
 * code carries the identity so any account can be simulated:
 *   fake-google:<sub>:<email>:<name>[:unverified]
 * Never selected in production (DRIVE_DRIVER must be `google` there).
 */
@Injectable()
export class FakeIdentityGateway extends IdentityPort {
  authorizeUrl(p: { state: string }): string {
    return `/api/v1/auth/google/callback?state=${encodeURIComponent(p.state)}&code=${encodeURIComponent('fake-google:dev-sub-1:google.user@example.test:Google User')}`
  }

  async exchange(code: string): Promise<GoogleProfile> {
    const [tag, sub, email, name, flag] = code.split(':')
    if (tag !== 'fake-google' || !sub || !email) throw new IdentityError('bad code')
    return { sub, email: email.toLowerCase(), emailVerified: flag !== 'unverified', name: name || email, picture: null }
  }
}
