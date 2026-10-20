import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

export interface FieldError {
  field: string;
  code: string;
  message?: string;
}

/** An error that is safe to show to API clients, rendered as RFC 9457 problem+json. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly options: { messageAr?: string; errors?: FieldError[]; extra?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthorized = (code = 'unauthorized', message = 'Authentication required') =>
  new AppError(401, code, message, { messageAr: 'يرجى تسجيل الدخول' });

export const forbidden = (code = 'forbidden_role', message = 'You are not allowed to do this') =>
  new AppError(403, code, message, { messageAr: 'غير مسموح لك بهذا الإجراء' });

export const notFound = (code = 'not_found', message = 'Not found') =>
  new AppError(404, code, message, { messageAr: 'غير موجود' });

export const upstream = (code: string, message: string) =>
  new AppError(502, code, message, { messageAr: 'الخدمة غير متاحة حالياً، حاول مرة أخرى' });

function problem(status: number, code: string, title: string, extra: Record<string, unknown> = {}) {
  return { type: 'about:blank', title, status, code, ...extra };
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    reply.type('application/problem+json');

    if (error instanceof AppError) {
      return reply.status(error.status).send(
        problem(error.status, error.code, error.message, {
          ...(error.options.messageAr && { messageAr: error.options.messageAr }),
          ...(error.options.errors && { errors: error.options.errors }),
          ...error.options.extra,
        }),
      );
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const errors: FieldError[] = error.validation.map((v) => ({
        field: v.instancePath.replace(/^\//, '').replace(/\//g, '.') || String(v.params?.issue?.path?.join('.') ?? ''),
        code: v.keyword,
        message: v.message,
      }));
      return reply.status(422).send(
        problem(422, 'validation_failed', 'Some fields are invalid', {
          messageAr: 'بعض الحقول غير صحيحة',
          errors,
        }),
      );
    }

    const fe = error as FastifyError;
    if (fe.statusCode === 429) {
      return reply.status(429).send(problem(429, 'rate_limited', 'Too many requests', { messageAr: 'طلبات كثيرة، حاول لاحقاً' }));
    }
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send(problem(fe.statusCode, fe.code?.toLowerCase() ?? 'bad_request', fe.message));
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(problem(500, 'internal_error', 'Something went wrong', { messageAr: 'حدث خطأ ما' }));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .type('application/problem+json')
      .status(404)
      .send(problem(404, 'route_not_found', `No route ${request.method} ${request.url}`));
  });
}
