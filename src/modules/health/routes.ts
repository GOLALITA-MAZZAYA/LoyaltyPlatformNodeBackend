import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  // Liveness: the process is up.
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: dependencies are reachable.
  app.get('/health/ready', async (_req, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'down' });
    }
  });
};
