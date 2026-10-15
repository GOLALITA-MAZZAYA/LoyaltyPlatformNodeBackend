import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { notFound } from '../../lib/errors.js';
import { merchantSchema } from '../auth/routes.js';
import { merchantView } from '../auth/service.js';

export const merchantRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/merchant/me',
    {
      preHandler: app.authenticate,
      schema: { response: { 200: merchantSchema } },
    },
    async (req) => {
      const staff = await app.prisma.staff.findUnique({
        where: { id: req.auth.sub },
        include: { merchant: true },
      });
      if (!staff || staff.merchantId !== req.auth.mid) throw notFound('merchant_not_found', 'Merchant not found');
      return merchantView(staff.merchant, staff);
    },
  );
};
