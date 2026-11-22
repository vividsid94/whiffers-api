// Accounts (ACCOUNTS_PLAN.md in the whiffers repo): Better Auth, with users in
// this service's own Postgres next to games.
//
// Players sign in with Google or a one-time email link; there is no public
// password sign-up. A handful of tester accounts sign in with a username and
// password; they're created by scripts/create-tester.mjs, never by the site.
//
// Everyone gets a unique username (the username plugin): testers have one
// from the start, Google and email-link players pick theirs on first sign-in.
// That's the display name shown in games, and later in multiplayer.

import { betterAuth } from 'better-auth';
import { magicLink, username } from 'better-auth/plugins';
import { sendSignInEmail } from './email.js';
import { userDataPlugin } from './userData.js';

const DAY = 60 * 60 * 24;

// Set by mount.js from Express's req.ip; Better Auth's rate limits read it.
export const CLIENT_IP_HEADER = 'x-whiffers-client-ip';

// Local dev is told apart by the API's own address (BETTER_AUTH_URL), not
// NODE_ENV, which Railway doesn't set: anything not on localhost is live, and
// gets secure cookies and no localhost origins.
export const isLocalAuth = (env = process.env) => !env.BETTER_AUTH_URL || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.BETTER_AUTH_URL);

// Frontend origins allowed to make signed-in requests. FRONTEND_ORIGINS is a
// comma-separated list (production and staging sites); local dev adds
// localhost on any port.
export function authOrigins(env = process.env) {
  const list = (env.FRONTEND_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (isLocalAuth(env)) list.push('http://localhost:*');
  return list;
}

export function isAuthOrigin(origin, env = process.env) {
  if (!origin) return false;
  return authOrigins(env).some((allowed) => (allowed.endsWith(':*')
    ? origin.startsWith(allowed.slice(0, -1)) && /^\d+$/.test(origin.slice(allowed.length - 1))
    : origin === allowed));
}

// Usernames: 3-20 letters, numbers or underscores. Unique, compared without
// case (the plugin stores a lowercased copy alongside what you typed).
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

/**
 * @param {object} opts
 * @param {object} opts.database  a pg.Pool, or { dialect, type } for local PGlite
 * @param {object} [opts.env]     process.env by default
 */
export function createAuth({ database, env = process.env }) {
  const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, prompt: 'select_account' } }
    : {};

  return betterAuth({
    appName: 'Whiffers',
    baseURL: env.BETTER_AUTH_URL || 'http://localhost:4000',
    secret: env.BETTER_AUTH_SECRET,
    database,
    trustedOrigins: authOrigins(env),
    telemetry: { enabled: false },

    session: {
      expiresIn: 60 * DAY, // stay signed in for two months...
      updateAge: DAY, // ...counted from your last visit, refreshed daily
    },

    user: {
      additionalFields: {
        // 'player' or 'tester'. Never settable from the browser.
        role: { type: 'string', defaultValue: 'player', input: false },
      },
    },

    // Only testers have passwords, and only the script can create them.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10 },

    socialProviders: google,

    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 20,
        usernameValidator: (name) => USERNAME_PATTERN.test(name),
      }),
      magicLink({
        expiresIn: 10 * 60,
        sendMagicLink: async ({ email, url }) => sendSignInEmail({ to: email, url, env }),
      }),
      userDataPlugin(),
    ],

    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/magic-link': { window: 60 * 60, max: 5 },
        '/sign-in/username': { window: 15 * 60, max: 10 },
        '/sign-in/email': { window: 15 * 60, max: 10 },
      },
    },

    advanced: {
      // In production the site and API share whiffers230.com, so the session
      // cookie is set on the parent domain and both can see it.
      ...(env.AUTH_COOKIE_DOMAIN
        ? { crossSubDomainCookies: { enabled: true, domain: env.AUTH_COOKIE_DOMAIN } }
        : {}),
      useSecureCookies: !isLocalAuth(env),
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
  });
}
