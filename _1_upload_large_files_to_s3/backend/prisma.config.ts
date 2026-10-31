import 'dotenv/config';
import path from 'node:path';

import { defineConfig, env } from 'prisma/config';

// Prisma 7 reads the connection string from here rather than from
// `datasource.url` in schema.prisma, and it no longer auto-loads `.env` --
// hence the `dotenv/config` import above.
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
