import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates route input against a `@crewaid/shared` Zod schema.
 *
 * shared is the single contract source (M0-04): REST bodies arrive here,
 * WS frames go through the same schemas. No class-validator DTOs — a second
 * schema language is a second place to drift.
 *
 * Failures are 400 with the Zod issues verbatim. `detail` stays structured
 * rather than flattened, so the client can render field-level errors without
 * parsing a message string (the rule applied to our own errors).
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        message: 'Request payload failed schema validation',
        detail: result.error.issues,
      });
    }
    return result.data;
  }
}
