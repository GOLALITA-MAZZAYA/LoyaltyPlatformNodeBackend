import { programRoutes } from './modules/program/routes.js';
import { counterRoutes } from './modules/counter/routes.js';
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
import { branchRoutes } from './modules/branches/routes.js';
import { DevSmsSender, UnconfiguredSmsSender, type SmsSender } from './integrations/sms.js';
import { OtpService } from './modules/public/otp.js';
import { MemberTokens } from './modules/public/members.js';
import { publicRoutes } from './modules/public/routes.js';
import { memberRoutes } from './modules/members/routes.js';

export interface AppDeps {
  env?: Env;
  prisma?: PrismaClient;
  odoo?: OdooClient;
  sms?: SmsSender;
}

export async function buildApp(deps: AppDeps = {}) {
  const env = deps.env ?? loadEnv();

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.body.odooToken', 'req.body.refreshToken', 'req.body.code', 'req.body.phone'],
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

  const sms = deps.sms ?? (env.OTP_DELIVERY === 'dev' ? new DevSmsSender() : new UnconfiguredSmsSender());
  const otp = new OtpService(app.prisma, sms, env.JWT_SECRET);
  const memberTokens = new MemberTokens(app.prisma, env.JWT_SECRET);
  if (sms.returnsCode) app.log.warn('OTP_DELIVERY=dev: sign-up codes are returned in API responses (local testing only)');

  await app.register(healthRoutes);
  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { auth });
      await v1.register(merchantRoutes);
      await v1.register(branchRoutes, { odoo, joinBaseUrl: env.PUBLIC_JOIN_BASE_URL });
      await v1.register(publicRoutes, { otp, memberTokens });
      await v1.register(memberRoutes);
      await v1.register(programRoutes);
      await v1.register(counterRoutes);
    },
    { prefix: '/v1' },
  );

  return app;
}
