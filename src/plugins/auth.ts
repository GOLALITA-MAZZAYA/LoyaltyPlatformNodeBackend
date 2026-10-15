import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';
import { forbidden, unauthorized, AppError } from '../lib/errors.js';
import type { AccessClaims, TokenService } from '../lib/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AccessClaims;
  }
  interface FastifyInstance {
    /** preHandler: requires a valid merchant access token */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** preHandler factory: requires one of the given roles (use after authenticate) */
    requireRole: (...roles: Role[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** preHandler: requires the merchant to have loyalty enabled (use after authenticate) */
    requireLoyalty: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp<{ tokens: TokenService }>(async (app, { tokens }) => {
  app.decorateRequest('auth', null as unknown as AccessClaims);

  app.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    req.auth = await tokens.verifyAccess(header.slice(7));
  });

  app.decorate('requireRole', (...roles: Role[]) => async (req: FastifyRequest) => {
    if (!roles.includes(req.auth.role)) throw forbidden();
  });

  app.decorate('requireLoyalty', async (req: FastifyRequest) => {
    const merchant = await app.prisma.merchant.findUnique({
      where: { id: req.auth.mid },
      select: { loyaltyEnabled: true },
    });
    if (!merchant?.loyaltyEnabled) {
      throw new AppError(403, 'loyalty_not_enabled', 'Loyalty is not enabled for this merchant', {
        messageAr: 'برنامج الولاء غير مفعل لهذا التاجر',
      });
    }
  });
});
