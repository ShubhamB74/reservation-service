import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { operatorFromAuthHeader } from './auth';
import { ApiError, errorBody } from './errors';
import { createReservation } from './reservations';
import { parseReservation } from './validation';

declare module 'fastify' {
  interface FastifyRequest {
    operatorId: string | null;
  }
}

export function buildApp(pool: Pool, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  app.decorateRequest('operatorId', null);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send(errorBody(err.code, err.message));
    }
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // malformed JSON, wrong content type, oversized body...
      return reply.code(400).send(errorBody('INVALID_REQUEST', 'Malformed request.'));
    }
    req.log.error(err); // details go to logs only, never to the client
    return reply.code(500).send(errorBody('INTERNAL_ERROR', 'An unexpected error occurred.'));
  });

  app.post(
    '/reservations',
    {
      // Runs before body parsing, so auth failures are always 401.
      onRequest: async (req, reply) => {
        const operatorId = operatorFromAuthHeader(req.headers.authorization);
        if (!operatorId) {
          reply.code(401).send(errorBody('UNAUTHORIZED', 'Missing or invalid token.'));
          return reply;
        }
        req.operatorId = operatorId;
      },
    },
    async (req, reply) => {
      const input = parseReservation(req.body);
      if (input.operatorId !== req.operatorId) {
        throw new ApiError(403, 'FORBIDDEN', 'Token is not authorized for this operator.');
      }
      const result = await createReservation(pool, req.operatorId!, input);
      return reply.code(result.created ? 201 : 200).send({
        reservationId: result.reservationId,
        externalBookingId: input.externalBookingId,
        operatorId: req.operatorId,
      });
    },
  );

  return app;
}
