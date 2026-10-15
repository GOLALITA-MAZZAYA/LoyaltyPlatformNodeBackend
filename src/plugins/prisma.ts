import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export default fp<{ client?: PrismaClient }>(async (app, { client }) => {
  const prisma = client ?? new PrismaClient();
  app.decorate('prisma', prisma);
  // Only disconnect clients this plugin created; injected ones belong to the caller.
  if (!client) app.addHook('onClose', () => prisma.$disconnect());
});
