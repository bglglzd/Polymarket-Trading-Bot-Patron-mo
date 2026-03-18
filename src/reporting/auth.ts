/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Telegram Login Widget Authentication
   Verifies Telegram callback via HMAC-SHA256, manages cookie sessions.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { createHmac, createHash, randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { logger } from './logs';

/* ━━━━━━━━━━━━━━ Config ━━━━━━━━━━━━━━ */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID ?? process.env.TELEGRAM_CHAT_ID ?? '';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_SESSIONS = 5;
const COOKIE_NAME = 'ppb_session';

/* ━━━━━━━━━━━━━━ Telegram HMAC verification ━━━━━━━━━━━━━━ */

export interface TelegramAuthData {
  id: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
}

/**
 * Verify data from Telegram Login Widget using HMAC-SHA256.
 * https://core.telegram.org/widgets/login#checking-authorization
 */
export function verifyTelegramAuth(data: TelegramAuthData): boolean {
  if (!BOT_TOKEN) return false;

  const { hash, ...rest } = data;
  if (!hash) return false;

  // auth_date must be within 5 minutes to prevent replay attacks
  const authAge = Date.now() / 1000 - Number(rest.auth_date);
  if (authAge > 300 || authAge < 0) return false;

  // Build check string: sorted key=value pairs joined by \n
  const checkString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k as keyof typeof rest]}`)
    .filter((s) => !s.endsWith('=undefined'))
    .join('\n');

  // Secret key = SHA256(bot_token)
  const secretKey = createHash('sha256').update(BOT_TOKEN).digest();
  const hmac = createHmac('sha256', secretKey).update(checkString).digest('hex');

  return hmac === hash;
}

/**
 * Check if the authenticated Telegram user is the admin.
 */
export function isAdmin(telegramId: string): boolean {
  return ADMIN_ID !== '' && telegramId === ADMIN_ID;
}

/* ━━━━━━━━━━━━━━ Session Manager ━━━━━━━━━━━━━━ */

interface Session {
  token: string;
  telegramId: string;
  username: string;
  createdAt: number;
  lastActiveAt: number;
}

class SessionManager {
  private sessions = new Map<string, Session>();

  create(telegramId: string, username: string): string {
    // Evict oldest if at capacity
    if (this.sessions.size >= MAX_SESSIONS) {
      let oldestToken = '';
      let oldestTime = Infinity;
      for (const [token, s] of this.sessions) {
        if (s.lastActiveAt < oldestTime) {
          oldestTime = s.lastActiveAt;
          oldestToken = token;
        }
      }
      if (oldestToken) this.sessions.delete(oldestToken);
    }

    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, {
      token,
      telegramId,
      username,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    logger.info({ telegramId, username }, 'Session created');
    return token;
  }

  validate(token: string): Session | null {
    const session = this.sessions.get(token);
    if (!session) return null;

    // Check TTL
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(token);
      return null;
    }

    // Refresh activity
    session.lastActiveAt = Date.now();
    return session;
  }

  destroy(token: string): void {
    this.sessions.delete(token);
  }
}

export const sessionManager = new SessionManager();

/* ━━━━━━━━━━━━━━ Cookie helpers ━━━━━━━━━━━━━━ */

export function parseCookie(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === COOKIE_NAME) return rest.join('=');
  }
  return undefined;
}

export function setSessionCookie(res: ServerResponse, token: string): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
  );
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  );
}

/* ━━━━━━━━━━━━━━ Auth Middleware ━━━━━━━━━━━━━━ */

/** Routes that don't require authentication */
const PUBLIC_PATHS = ['/login', '/auth/telegram/callback', '/health'];

/**
 * Returns true if the request is authenticated (or is a public path).
 * If not authenticated, sends 401 or redirects to /login.
 */
export function authMiddleware(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  // Allow public paths
  for (const pp of PUBLIC_PATHS) {
    if (path === pp || path.startsWith(pp + '/')) return true;
  }

  // Check session cookie
  const token = parseCookie(req);
  if (token) {
    const session = sessionManager.validate(token);
    if (session) return true;
  }

  // Not authenticated
  if (path.startsWith('/api/')) {
    // API requests get 401 JSON
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
  } else {
    // Page requests get redirected to login
    res.writeHead(302, { Location: '/login' });
    res.end();
  }
  return false;
}

/* ━━━━━━━━━━━━━━ Login Page HTML ━━━━━━━━━━━━━━ */

export function getLoginPageHtml(): string {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? 'polypatronbot';
  const origin = process.env.DASHBOARD_ORIGIN ?? 'https://poly.qzx.digital';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PolyPatronBot — Login</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%23111'/><text x='16' y='23' text-anchor='middle' font-size='20' font-family='sans-serif' font-weight='bold' fill='%2300d4aa'>P</text></svg>">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0a0e17;
    color: #e0e0e0;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }
  .login-card {
    background: #141b2d;
    border: 1px solid #1e2a45;
    border-radius: 16px;
    padding: 48px 40px;
    text-align: center;
    max-width: 400px;
    width: 90%;
  }
  .login-card h1 {
    font-size: 24px;
    margin-bottom: 8px;
    color: #fff;
  }
  .login-card p {
    color: #8892a4;
    margin-bottom: 32px;
    font-size: 14px;
  }
  .tg-widget {
    display: flex;
    justify-content: center;
    margin-bottom: 24px;
  }
  .error {
    color: #ff6b6b;
    font-size: 13px;
    margin-top: 16px;
    display: none;
  }
  .error.visible { display: block; }
</style>
</head>
<body>
<div class="login-card">
  <h1>PolyPatronBot</h1>
  <p>Sign in with your Telegram account to access the dashboard.</p>
  <div class="tg-widget">
    <script async src="https://telegram.org/js/telegram-widget.js?22"
      data-telegram-login="${botUsername}"
      data-size="large"
      data-radius="8"
      data-auth-url="${origin}/auth/telegram/callback"
      data-request-access="write">
    </script>
  </div>
  <div id="error" class="error"></div>
</div>
<script>
  const params = new URLSearchParams(location.search);
  if (params.get('error') === 'denied') {
    const el = document.getElementById('error');
    el.textContent = 'Access denied. Only the admin can log in.';
    el.classList.add('visible');
  }
  if (params.get('error') === 'invalid') {
    const el = document.getElementById('error');
    el.textContent = 'Invalid authentication data. Please try again.';
    el.classList.add('visible');
  }
</script>
</body>
</html>`;
}
