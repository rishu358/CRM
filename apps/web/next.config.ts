import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';

/**
 * Load the monorepo's root `.env`, the one the API, worker and seed read.
 *
 * Next only looks inside this app's own directory, so without this the web
 * app quietly fell back to its defaults while every other package used the
 * file. That is the worst shape for a configuration bug: nothing fails, the
 * app just talks to whatever `API_URL` defaults to.
 *
 * `override: false` so a variable already in the environment — set by CI, by
 * a deployment, or on the command line — still wins.
 */
loadEnv({
  path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'),
  override: false,
  quiet: true,
});

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source, so Next must compile them.
  transpilePackages: ['@crm/ui', '@crm/contracts', '@crm/core', '@crm/env'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Browsers honour this only over HTTPS and ignore it over http, so it is safe to send
          // from a production build wherever it is served; `preload` is deliberately absent, as
          // it cannot be taken back. The API sends the same through helmet.
          ...(process.env.NODE_ENV === 'production'
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
            : []),
        ],
      },
    ];
  },
};

export default config;
