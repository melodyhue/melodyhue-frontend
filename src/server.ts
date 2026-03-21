import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import 'dotenv/config';
import { join } from 'node:path';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();
// Base API: surchargée via la variable d'environnement API_BASE_URL.
// Fallback: même valeur que le front par défaut (développement).
const API_BASE_RAW = process.env['API_BASE_URL'] || 'https://api.melodyhue.com';
// Normaliser (supprimer slash fin) pour éviter les doubles // dans l’URL cible
const API_BASE = API_BASE_RAW.replace(/\/+$/, '');
// Headers communs pour les requêtes upstream
const UPSTREAM_HEADERS = {
  accept: 'application/json',
  'user-agent': 'melodyhue-frontend-ssr/1.0',
} as const;
// Mode de forward: 'fetch' (par défaut) ou 'redirect'.
// Utilisez PROXY_FORWARD=redirect si votre hébergeur bloque les requêtes sortantes.
const PROXY_FORWARD = (process.env['PROXY_FORWARD'] || 'fetch').toLowerCase();

function forwardOrFetchJson(target: string, res: express.Response) {
  if (PROXY_FORWARD === 'redirect') {
    // Rediriger côté client vers l'API publique (retournera du JSON directement au client)
    res.redirect(302, target);
    return Promise.resolve();
  }
  return fetch(target, { headers: UPSTREAM_HEADERS }).then(async (upstream) => {
    const bodyText = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    res.setHeader('content-type', ct);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('access-control-allow-origin', '*');
    res.send(bodyText);
  });
}

/**
 * Generic proxy that forwards method, headers (including Cookie), and body to the upstream API,
 * and passes back Set-Cookie so the browser can store HttpOnly cookies on the SAME ORIGIN.
 * Returns true if the request was successfully proxied, false otherwise.
 */
async function proxyPass(req: ExpressRequest, res: ExpressResponse): Promise<boolean> {
  const target = `${API_BASE}${req.originalUrl}`;
  try {
    const headers: Record<string, string> = {
      ...UPSTREAM_HEADERS,
    };
    // Forward content-type if present (for JSON bodies)
    if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
    // Forward cookies from client to upstream
    if (req.headers['cookie']) headers['cookie'] = String(req.headers['cookie']);
    // Forward Authorization header (Bearer ...)
    if (req.headers['authorization'])
      headers['authorization'] = String(req.headers['authorization']);

    const method = req.method.toUpperCase();
    const hasBody = !['GET', 'HEAD'].includes(method);

    // Build fetch options; when streaming a request body in Node, the 'duplex' option is required
    const fetchOpts: any = {
      method,
      headers,
      // Do not use credentials storage on server; we explicitly forward Cookie header
    };
    if (hasBody) {
      fetchOpts.body = req as any; // stream body directly
      fetchOpts.duplex = 'half'; // required by Node fetch for streaming requests
    }

    const upstream = await fetch(target, fetchOpts);

    // Si l'API retourne 404, on ne proxy pas et on laisse Angular gérer
    if (upstream.status === 404) {
      return false;
    }

    // Status code
    res.status(upstream.status);

    // Forward content-type and cache-control
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    res.setHeader('cache-control', 'no-store');

    // Forward Set-Cookie headers (rewrite Domain to current host; ensure Secure/SameSite=None on HTTPS)
    const anyHeaders = upstream.headers as any;
    let setCookies: string[] | undefined;
    if (typeof anyHeaders.getSetCookie === 'function') {
      setCookies = anyHeaders.getSetCookie();
    } else if (typeof anyHeaders.raw === 'function') {
      const raw = anyHeaders.raw();
      if (raw && raw['set-cookie']) setCookies = raw['set-cookie'];
    } else {
      const single = upstream.headers.get('set-cookie');
      if (single) setCookies = [single];
    }
    if (setCookies && setCookies.length) {
      const host = req.headers['x-forwarded-host']?.toString() || req.headers.host || '';
      const isHttps = (req.headers['x-forwarded-proto']?.toString() || req.protocol) === 'https';
      const rewritten = setCookies.map((ck) => {
        try {
          // Split attributes and remove any Domain=... to bind cookie to current origin
          const parts = ck.split(';').map((p) => p.trim());
          const filtered = parts.filter((p) => !/^domain=/i.test(p));
          // Ensure Path
          if (!filtered.some((p) => /^path=/i.test(p))) filtered.push('Path=/');
          // On HTTPS, enforce Secure and SameSite=None (needed for cross-site scenarios)
          if (isHttps && !filtered.some((p) => /^secure$/i.test(p))) filtered.push('Secure');
          if (isHttps && !filtered.some((p) => /^samesite=/i.test(p)))
            filtered.push('SameSite=None');
          return filtered.join('; ');
        } catch {
          return ck;
        }
      });
      res.setHeader('set-cookie', rewritten);
    }

    // Stream/relay body
    const bodyText = await upstream.text();
    res.send(bodyText);
    return true;
  } catch (err) {
    if (process.env['DEBUG_PROXY']) {
      console.error('[Proxy] ERROR', req.method, req.originalUrl, '->', target, 'Error:', err);
    }
    // En cas d'erreur réseau vers l'API amont, renvoyer 503 Service Unavailable
    // et ne pas déléguer à Angular (pour éviter des 404 HTML côté client XHR)
    res.status(503).json({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Upstream fetch failed',
        detail: (err as Error).message,
      },
    });
    return true;
  }
}

/**
 * Developer API: return raw JSON for infos/color
 * These endpoints bypass Angular rendering to output JSON directly.
 * CORS: allow any origin so third-party sites can fetch these endpoints.
 */
app.options('/developer/api/:userId/:endpoint', (_req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-max-age', '86400');
  res.status(204).end();
});

app.get('/developer/api/:userId/infos', async (req, res) => {
  const userId = req.params['userId'];
  if (!userId) {
    res.status(400).json({ status: 'error', message: 'Missing userId' });
    return;
  }
  const target = `${API_BASE}/infos/${encodeURIComponent(userId)}`;
  try {
    await forwardOrFetchJson(target, res);
  } catch (err) {
    if (process.env['DEBUG_PROXY']) {
      console.error('[Proxy] GET /developer/api/:userId/infos ->', target, 'Error:', err);
    }
    res.status(503).json({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Upstream fetch failed',
        detail: (err as Error).message,
      },
    });
  }
});

app.get('/developer/api/:userId/color', async (req, res) => {
  const userId = req.params['userId'];
  if (!userId) {
    res.status(400).json({ status: 'error', message: 'Missing userId' });
    return;
  }
  const target = `${API_BASE}/color/${encodeURIComponent(userId)}`;
  try {
    await forwardOrFetchJson(target, res);
  } catch (err) {
    if (process.env['DEBUG_PROXY']) {
      console.error('[Proxy] GET /developer/api/:userId/color ->', target, 'Error:', err);
    }
    res.status(503).json({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Upstream fetch failed',
        detail: (err as Error).message,
      },
    });
  }
});

/**
 * Direct proxy routes for public API when running with SSR dev server
 * This allows calling relative paths from the browser without CORS issues.
 */
app.get('/infos/:userId', async (req, res) => {
  const userId = req.params['userId'];
  if (!userId) {
    res.status(400).json({ status: 'error', message: 'Missing userId' });
    return;
  }
  const target = `${API_BASE}/infos/${encodeURIComponent(userId)}`;
  try {
    await forwardOrFetchJson(target, res);
  } catch (err) {
    if (process.env['DEBUG_PROXY']) {
      console.error('[Proxy] GET /infos/:userId ->', target, 'Error:', err);
    }
    res.status(503).json({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Upstream fetch failed',
        detail: (err as Error).message,
      },
    });
  }
});

app.get('/color/:userId', async (req, res) => {
  const userId = req.params['userId'];
  if (!userId) {
    res.status(400).json({ status: 'error', message: 'Missing userId' });
    return;
  }
  const target = `${API_BASE}/color/${encodeURIComponent(userId)}`;
  try {
    await forwardOrFetchJson(target, res);
  } catch (err) {
    if (process.env['DEBUG_PROXY']) {
      console.error('[Proxy] GET /color/:userId ->', target, 'Error:', err);
    }
    res.status(503).json({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Upstream fetch failed',
        detail: (err as Error).message,
      },
    });
  }
});

app.get('/health', async (_req, res) => {
  const target = `${API_BASE}/health`;
  try {
    await forwardOrFetchJson(target, res);
  } catch (err) {
    if (process.env['DEBUG_PROXY']) {
      console.error('[Proxy] GET /health ->', target, 'Error:', err);
    }
    res
      .status(502)
      .json({ status: 'error', message: 'Upstream fetch failed', detail: (err as Error).message });
  }
});

/**
 * Same-origin proxy for authenticated routes so that HttpOnly cookies can be set and sent
 * without CORS issues. We forward /auth/*, /users/*, /settings/*.
 */
app.use(
  ['/auth', '/users', '/settings', '/spotify', '/admin', '/modo', '/overlays', '/overlay'],
  async (req, res, next) => {
    const method = req.method.toUpperCase();
    const accept = (req.headers['accept'] || '').toString();
    const isHtmlNav = accept.includes('text/html');
    const isGetLike = method === 'GET' || method === 'HEAD';
    // Attention: dans un middleware monté sur des préfixes (ex: '/spotify'),
    // req.path ne contient QUE la partie après le préfixe. Pour distinguer
    // correctement les routes de première section (ex: '/auth/...'), il faut
    // utiliser originalUrl qui contient le chemin complet tel que reçu.
    const path = req.path || '';
    const fullPath = (req.originalUrl || req.url || '').split('?')[0] || path;

    // Laisser Angular gérer TOUTES les navigations GET/HEAD vers /auth/* (pages login/reset, etc.)
    // Utiliser le chemin complet pour éviter de confondre '/spotify/auth/...'
    // avec une page '/auth/...'.
    if (isGetLike && fullPath.startsWith('/auth')) {
      return next();
    }

    // Pour les autres routes, ne pas proxifier les navigations HTML, uniquement les XHR/fetch
    if (isGetLike && isHtmlNav) {
      return next();
    }

    // Proxy uniquement les appels API (XHR/fetch)
    // Si le proxy retourne false (route non trouvée ou erreur), on laisse Angular gérer
    const proxied = await proxyPass(req, res);
    if (!proxied) {
      return next();
    }
  },
);

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 * Use a path-to-regexp v6 compatible catch-all pattern.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => {
      if (response) {
        writeResponseToNodeResponse(response, res);
      } else {
        // Si Angular ne peut pas gérer la requête, on renvoie quand même une 404
        res.status(404);
        next();
      }
    })
    .catch(next);
});

/**
 * Final error handler for 404
 */
app.use((req, res) => {
  if (!res.headersSent) {
    res.status(404).send(`
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>Page non trouvée - MelodyHue</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 50px; }
    h1 { font-size: 50px; margin: 0; }
    p { font-size: 18px; color: #666; }
    a { color: #007bff; text-decoration: none; }
  </style>
</head>
<body>
  <h1>404</h1>
  <p>La page que vous recherchez n'existe pas.</p>
  <a href="/">Retour à l'accueil</a>
</body>
</html>
    `);
  }
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 3000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    const env = process.env['NODE_ENV'] || 'development';
    console.log(`[SSR] listening on http://localhost:${port} (env=${env})`);
    if (!process.env['API_BASE_URL']) {
      console.warn(
        `[SSR] API_BASE_URL non défini, fallback sur ${API_BASE}. Définissez API_BASE_URL pour surcharger.`,
      );
    }
    console.log(`[SSR] API_BASE = ${API_BASE}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
