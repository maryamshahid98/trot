import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * One place that shapes every error. Expected errors keep their message. Anything unexpected becomes a
 * plain 500 with a request id: no stack trace, SQL or file path ever reaches the caller. The detail is logged.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const res = http.getResponse();
    const req = http.getRequest();
    const requestId: string = req?.id ?? randomUUID();

    let status = 500;
    let body: Record<string, unknown> = { message: 'Something went wrong on our side.' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      body = typeof r === 'string' ? { message: r } : { ...(r as Record<string, unknown>) };
      delete body.statusCode;
    } else if (isClientError(exception)) {
      // Errors raised by the body parser (bad JSON, body too large).
      status = exception.status;
      body = { message: status === 413 ? 'The request body is too large.' : 'The request body is not valid.' };
    } else {
      this.log.error(`[${requestId}] unexpected error`, exception instanceof Error ? exception.stack : String(exception));
    }
    res.status(status).json({ statusCode: status, ...body, requestId });
  }
}

function isClientError(e: unknown): e is { status: number } {
  return typeof e === 'object' && e !== null && typeof (e as any).status === 'number' && (e as any).status >= 400 && (e as any).status < 500;
}
