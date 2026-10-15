import * as argon2 from 'argon2'
import { Inject, Injectable } from '@nestjs/common'
import { ENV, Env } from '../../config/env'
import { unprocessable } from '../../common/http'

/**
 * Local list (no external call) of passwords that are never acceptable.
 * Deliberately short: real breach lists are far larger; the minimum length
 * and this list stop the worst choices without a network dependency.
 */
const COMMON = new Set(
  `password,password1,password12,password123,password1234,passw0rd123,1234567890,12345678910,123456789012,qwertyuiop,qwertyuiop1,qwerty12345,
iloveyou123,letmein1234,welcome1234,welcome123,admin12345,administrator,changeme123,changeme1234,abc1234567,abcdefghij,0123456789,1q2w3e4r5t,
1qaz2wsx3edc,zaq12wsxcde,football123,baseball123,superman123,trustno1234,monkey12345,dragon12345,master12345,sunshine123,princess123,
university1,university123,student1234,teacher1234,supervisor1,projectn123,projectn1234,bangladesh1,dhaka123456,qazwsxedcrfv,passwordpassword,
111111111111,000000000000,aaaaaaaaaaaa,1234512345,9876543210`
    .split(/[\s,]+/)
    .filter(Boolean)
)

export const PASSWORD_MIN = 10

export function assertAcceptablePassword(password: string, ctx: { email?: string; name?: string } = {}) {
  const errors: { field: string; message: string }[] = []
  if (password.length < PASSWORD_MIN) errors.push({ field: 'password', message: `Use at least ${PASSWORD_MIN} characters` })
  if (password.length > 128) errors.push({ field: 'password', message: 'Use at most 128 characters' })
  const lower = password.toLowerCase()
  if (COMMON.has(lower)) errors.push({ field: 'password', message: 'This password is too common' })
  const local = ctx.email?.split('@')[0]?.toLowerCase()
  if (local && local.length >= 4 && lower.includes(local)) {
    errors.push({ field: 'password', message: 'The password must not contain your e-mail name' })
  }
  if (new Set(password).size < 4) errors.push({ field: 'password', message: 'Use a more varied password' })
  if (errors.length) throw unprocessable('weak_password', 'Choose a stronger password', errors)
}

@Injectable()
export class PasswordService {
  private dummy?: Promise<string>
  constructor(@Inject(ENV) private env: Env) {}

  private opts() {
    return { type: argon2.argon2id, memoryCost: this.env.argon.memoryCost, timeCost: this.env.argon.timeCost, parallelism: 1 }
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, this.opts())
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password)
    } catch {
      return false
    }
  }

  /** Burn the same CPU for unknown accounts so timing does not reveal them. */
  async verifyDummy(password: string): Promise<false> {
    this.dummy ??= this.hash('not-a-real-password-' + Math.random())
    await this.verify(await this.dummy, password)
    return false
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, this.opts())
  }
}
