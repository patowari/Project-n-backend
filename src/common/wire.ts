import { CallHandler, ExecutionContext, Injectable, NestInterceptor, PipeTransform, ArgumentMetadata } from '@nestjs/common'
import { map, Observable } from 'rxjs'
import { camelizeKeys, snakeizeKeys } from './case'

/** Incoming `snake_case` bodies and queries become camelCase before validation. */
@Injectable()
export class CamelizePipe implements PipeTransform {
  transform(value: unknown, meta: ArgumentMetadata) {
    if ((meta.type === 'body' || meta.type === 'query') && value && typeof value === 'object') {
      return camelizeKeys(value)
    }
    return value
  }
}

/** Prisma values JSON cannot carry. */
function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v)
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v
    const ctor = (v as { constructor?: { name?: string } }).constructor?.name
    if (ctor === 'Decimal') return Number(v)
    if (Array.isArray(v)) return v.map(plain)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  }
  return v
}

/** Outgoing bodies: camelCase in code, snake_case on the wire. */
@Injectable()
export class SnakeCaseInterceptor implements NestInterceptor {
  intercept(_: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((body) => {
        if (body === undefined || body === null) return body
        if (typeof body !== 'object') return body
        if (body instanceof Buffer || (body as { getStream?: unknown }).getStream) return body // StreamableFile
        return snakeizeKeys(plain(body))
      })
    )
  }
}
