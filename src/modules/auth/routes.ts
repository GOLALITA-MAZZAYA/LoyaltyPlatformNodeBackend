import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AuthService } from './service.js';

const merchantSchema = z.object({
  id: z.string(),
  odooMerchantId: z.number(),
  name: z.string(),
  role: z.enum(['owner', 'cashier']),
  loyaltyEnabled: z.boolean(),
  merchantCode: z.string(),
});

const tokenPairSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresIn: z.number(),
  refreshToken: z.string(),
  merchant: merchantSchema,
});

export const authRoutes: FastifyPluginAsyncZod<{ auth: AuthService }> = async (app, { auth }) => {
  // Each attempt costs an Odoo round-trip, so keep this tight per IP.
  const strict = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  app.post(
    '/auth/exchange',
    {
      config: strict,
      schema: {
        body: z.object({ odooToken: z.string().min(1).max(4096) }),
        response: { 200: tokenPairSchema },
      },
    },
    async (req) => auth.exchange(req.body.odooToken),
  );

  app.post(
    '/auth/refresh',
    {
      config: strict,
      schema: {
        body: z.object({ refreshToken: z.string().min(1).max(200) }),
        response: { 200: tokenPairSchema },
      },
    },
    async (req) => auth.refresh(req.body.refreshToken),
  );

  app.post(
    '/auth/logout',
    { preHandler: app.authenticate },
    async (req, reply) => {
      await auth.logout(req.auth.fid);
      return reply.status(204).send();
    },
  );
};

export { merchantSchema };
