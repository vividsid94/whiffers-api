// The sign-in email. Sent through Resend's HTTP API when RESEND_API_KEY is
// set; without it (local dev) the link is printed to the console instead.

import { isLocalAuth } from './auth.js';

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function sendSignInEmail({ to, url, env = process.env }) {
  if (!env.RESEND_API_KEY) {
    // Live (not localhost), a missing key is a setup mistake, not a reason to
    // print people's sign-in links into the server log.
    if (!isLocalAuth(env)) throw new Error('RESEND_API_KEY is not set');
    console.log(`\n[auth] sign-in link for ${to}:\n${url}\n`);
    return;
  }
  const from = env.AUTH_EMAIL_FROM || 'Whiffers <signin@whiffers230.com>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      subject: 'Your Whiffers sign-in link',
      text: `Tap this link to sign in to Whiffers:\n\n${url}\n\nIt works once and expires in 10 minutes. If you didn't ask for it, you can ignore this email.`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#27231F">
  <h1 style="font-size:20px;margin:0 0 12px">Sign in to Whiffers</h1>
  <p style="font-size:14px;line-height:1.5;margin:0 0 20px">Tap the button to sign in. The link works once and expires in 10 minutes.</p>
  <a href="${escapeHtml(url)}" style="display:inline-block;background:#C87845;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:12px">Sign in</a>
  <p style="font-size:12px;line-height:1.5;color:#8A7A68;margin:24px 0 0">If you didn't ask for this, you can ignore this email.</p>
</div>`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}
