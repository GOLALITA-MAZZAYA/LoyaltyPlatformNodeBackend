import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@prisma/client';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { loadEnv, type Env } from './config/env.js';
import { registerErrorHandler } from './lib/errors.js';
import { TokenService } from './lib/tokens.js';
import { HttpOdooClient, type OdooClient } from './integrations/odoo.js';
import prismaPlugin from './plugins/prisma.js';
import authPlugin from './plugins/auth.js';
import { AuthService } from './modules/auth/service.js';
import { authRoutes } from './modules/auth/routes.js';
import { merchantRoutes } from './modules/merchant/routes.js';
import { healthRoutes } from './modules/health/routes.js';

export interface AppDeps {
  env?: Env;
  prisma?: PrismaClient;
  odoo?: OdooClient;
}

export async function buildApp(deps: AppDeps = {}) {
  const env = deps.env ?? loadEnv();

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.body.odooToken', 'req.body.refreshToken'],
      ...(env.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
    },
    trustProxy: true,
    bodyLimit: 1_048_576,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(helmet);
  await app.register(cors, { origin: env.CORS_ORIGINS });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(prismaPlugin, { client: deps.prisma });

  const tokens = new TokenService(env.JWT_SECRET, env.ACCESS_TOKEN_TTL_SECONDS);
  await app.register(authPlugin, { tokens });

  const odoo = deps.odoo ?? new HttpOdooClient(env.ODOO_BASE_URL, env.ODOO_TIMEOUT_MS);
  const auth = new AuthService({ prisma: app.prisma, odoo, tokens, refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS, log: app.log });

  await app.register(healthRoutes);
  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { auth });
      await v1.register(merchantRoutes);
    },
    { prefix: '/v1' },
  );

  return app;
}
