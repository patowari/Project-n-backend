import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** 32 random bytes, URL safe. Only its SHA-256 is ever stored. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** AES-256-GCM. Layout: iv(12) | tag(16) | ciphertext. */
export function seal(plain: Buffer | string, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), enc])
}

export function open(sealed: Buffer | Uint8Array, key: Buffer): Buffer {
  const b = Buffer.from(sealed)
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAuthTag(b.subarray(12, 28))
  return Buffer.concat([d.update(b.subarray(28)), d.final()])
}

export const sealJson = (v: unknown, key: Buffer) => seal(JSON.stringify(v), key).toString('base64')
export const openJson = <T>(s: string, key: Buffer) =>
  JSON.parse(open(Buffer.from(s, 'base64'), key).toString('utf8')) as T
