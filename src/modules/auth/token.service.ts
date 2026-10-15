import { HttpStatus, Inject, Injectable } from '@nestjs/common'
import * as jwt from 'jsonwebtoken'
import { ENV, Env } from '../../config/env'
import { ApiError } from '../../common/http'
import { KvService } from '../../infra/kv'

export interface AccessClaims {
  sub: string
  sid: string
}

/**
 * Short-lived access tokens (15 min, HS256). The session id (`sid`) lets us
 * cut a session off immediately: revoking it writes a marker to the shared
 * KV that lives exactly as long as the longest outstanding token.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(ENV) private env: Env,
    private kvs: KvService
  ) {}

  sign(userId: string, sessionId: string): string {
    return jwt.sign({ sid: sessionId }, this.env.jwtSecret, {
      algorithm: 'HS256',
      subject: userId,
      expiresIn: this.env.accessTokenTtlSec,
      issuer: 'project-n',
    })
  }

  async verify(token: string): Promise<AccessClaims> {
    let claims: jwt.JwtPayload
    try {
      claims = jwt.verify(token, this.env.jwtSecret, { algorithms: ['HS256'], issuer: 'project-n' }) as jwt.JwtPayload
    } catch (e) {
      const expired = e instanceof jwt.TokenExpiredError
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        expired ? 'token_expired' : 'invalid_token',
        expired ? 'The access token has expired' : 'The access token is not valid'
      )
    }
    if (!claims.sub || typeof claims.sid !== 'string') {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'invalid_token', 'The access token is not valid')
    }
    if (await this.kvs.kv.get(`revoked:sid:${claims.sid}`)) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'session_revoked', 'This session has been signed out')
    }
    return { sub: claims.sub, sid: claims.sid }
  }

  /** Called when a session is revoked. */
  async markRevoked(sessionIds: string[]): Promise<void> {
    await Promise.all(
      sessionIds.map((id) => this.kvs.kv.set(`revoked:sid:${id}`, '1', this.env.accessTokenTtlSec + 60))
    )
  }
}
