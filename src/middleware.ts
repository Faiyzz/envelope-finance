/**
 * Middleware (Edge) - TD-02 §1, §7
 *
 * Cookie-presence redirect, registration 404 gate, CSP nonce + security
 * headers. It never touches the DB or Node-only modules; real session
 * validation happens in requireUser() (Node runtime).
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password', '/offline'];
const SESSION_COOKIES = ['authjs.session-token', '__Secure-authjs.session-token'];

function buildCsp(nonce: string, dev: boolean) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'", // Tailwind/Framer inline styles (documented trade-off)
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));

  if (pathname === '/register' && process.env.ALLOW_REGISTRATION !== 'true') {
    return new NextResponse('Not Found', { status: 404 });
  }

  const hasSession = SESSION_COOKIES.some((c) => request.cookies.has(c));
  if (!isPublic && !hasSession) {
    const url = new URL('/login', request.url);
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  if (isPublic && hasSession && pathname === '/login') {
    return NextResponse.redirect(new URL('/', request.url));
  }

  const dev = process.env.NODE_ENV !== 'production';
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, dev);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  // Backstop for logout hygiene: browsers drop caches/storage (TD-12 §7, TD-02 §3.4)
  if (pathname === '/login' && request.nextUrl.searchParams.get('loggedout') === '1') {
    response.headers.set('Clear-Site-Data', '"cache", "storage"');
  }
  if (!dev) response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  return response;
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|apple-touch-icon.png|icons|sw.js).*)'],
};
