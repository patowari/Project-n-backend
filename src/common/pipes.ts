import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common'
import { ApiError, isUuid } from './http'

/** Path ids must be UUIDs; anything else is a clean 404, never a database error. */
@Injectable()
export class ParseUuidPipe implements PipeTransform<string, string> {
  transform(value: string, _meta: ArgumentMetadata): string {
    if (!isUuid(value)) throw new ApiError(404, 'not_found', 'Resource not found')
    return value
  }
}

export const ParseUuid = new ParseUuidPipe()
