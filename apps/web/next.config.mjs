/**
 * L'interface appelle l'API via /api (même origine), relayé vers l'API par Next.js.
 * Ainsi la page fonctionne aussi derrière un aperçu ou un nom de domaine, sans réglage CORS.
 * @type {import('next').NextConfig}
 */
export default {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.API_INTERNAL_URL ?? 'http://localhost:4000'}/:path*` }];
  },
};
