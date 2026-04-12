import type { MiddlewareHandler } from 'hono';

function hasAuthorizationHeader(req: { header?(name: string): string | undefined }): boolean {
  return Boolean(req.header?.('Authorization'));
}

function buildCacheKey(url: string, origin: string | undefined): Request {
  const cacheUrl = new URL(url);
  if (origin) {
    cacheUrl.searchParams.set('__uptimer_origin_cache_key', origin);
  }
  return new Request(cacheUrl.toString(), { method: 'GET' });
}

// Cache public (unauthenticated) GET responses at the edge.
// This reduces D1 read pressure and greatly improves TTFB on slow networks.
//
// IMPORTANT: Authorization-bearing requests bypass the shared cache entirely because
// public endpoints can return admin-only payloads when a valid bearer token is present.
// If a handler already set Cache-Control, we respect it (do not override).
// This allows endpoints like `/public/status` to precisely control freshness (<= 60s).
export function cachePublic(opts: {
  cacheName: string;
  maxAgeSeconds: number;
  skipPathnames?: readonly string[];
}): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'GET' || hasAuthorizationHeader(c.req)) {
      await next();
      return;
    }

    const skipPathnames = opts.skipPathnames ?? [];
    if (skipPathnames.length > 0) {
      const pathname = new URL(c.req.url).pathname;
      if (skipPathnames.includes(pathname)) {
        await next();
        return;
      }
    }

    const cache = await caches.open(opts.cacheName);
    const cacheKey = buildCacheKey(c.req.url, c.req.header('Origin'));

    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    await next();

    if (c.res.status !== 200) return;

    // Respect explicit no-store/no-cache/private responses.
    const cacheControl = c.res.headers.get('Cache-Control');
    if (
      cacheControl &&
      /(?:^|,\s*)(?:private|no-(?:store|cache))(?:\s*(?:=|,|$))/i.test(cacheControl)
    ) {
      return;
    }

    // If the handler already set Cache-Control, keep it.
    if (!cacheControl) {
      c.res.headers.set('Cache-Control', `public, max-age=${opts.maxAgeSeconds}`);
    }

    // Put into Cloudflare's cache without blocking the response.
    c.executionCtx.waitUntil(cache.put(cacheKey, c.res.clone()));
  };
}
