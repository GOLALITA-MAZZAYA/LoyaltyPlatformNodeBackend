import { userInfo } from 'node:os';
import { execSync } from 'node:child_process';

// Bring the test database schema up to date once per run.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? `postgresql://${userInfo().username}@localhost:5432/loyalty_test`;
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
}
