// Tester accounts: the only accounts with a username and password. The site
// has no password sign-up, so they're made here.
//
//   node scripts/testers.mjs add          asks for a username and password
//   node scripts/testers.mjs list
//   node scripts/testers.mjs remove <username>
//   node scripts/testers.mjs password <username>   sets a new password
//
// Uses DATABASE_URL (production or staging) when it's set, otherwise the
// local dev database in .local/pglite - stop the local dev server first, as
// PGlite can only be open in one process at a time.
//
// The password is typed at a hidden prompt, so it never appears on screen or
// in shell history, and isn't stored anywhere but as a hash.

import readline from 'readline';
import { fileURLToPath } from 'url';
import { createAuth, USERNAME_PATTERN } from '../auth/auth.js';
import { ensureAuthSchema } from '../auth/mount.js';

process.env.BETTER_AUTH_SECRET ||= 'local-dev-auth-secret-0123456789abcdef';

async function openDatabase() {
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    return { database: pool, close: () => pool.end(), where: 'DATABASE_URL' };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGliteDialect } = await import('kysely-pglite-dialect');
  const pglite = new PGlite(fileURLToPath(new URL('../.local/pglite', import.meta.url)));
  return { database: { dialect: new PGliteDialect(pglite), type: 'postgres' }, close: () => pglite.close(), where: 'local .local/pglite' };
}

// One reader for the whole run (a new one per question would lose typed-ahead
// or piped lines). While a hidden question is open, everything echoed except
// the question itself is swallowed.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let hiddenQuestion = null;
const writeToOutput = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => { if (!hiddenQuestion || s.includes(hiddenQuestion)) writeToOutput(s); };

// Lines are queued as they arrive, so input typed (or piped) before a
// question is asked isn't lost.
const lines = [];
const waiting = [];
let inputClosed = false;
rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
rl.on('close', () => { inputClosed = true; while (waiting.length) waiting.shift()(null); });

async function ask(question, { hidden = false } = {}) {
  hiddenQuestion = hidden ? question : null;
  rl.output.write(question);
  const line = lines.length ? lines.shift() : inputClosed ? null : await new Promise((resolve) => waiting.push(resolve));
  if (hidden) { hiddenQuestion = null; rl.output.write('\n'); }
  if (line === null) throw new Error('Input ended before the answer was given.');
  return line.trim();
}

async function askPassword(ctx) {
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  for (;;) {
    const password = await ask(`Password (${minPasswordLength}+ characters, hidden): `, { hidden: true });
    if (password.length < minPasswordLength || password.length > maxPasswordLength) {
      console.log(`Must be ${minPasswordLength}-${maxPasswordLength} characters.`);
      continue;
    }
    const again = await ask('Same password again: ', { hidden: true });
    if (again !== password) { console.log("They don't match - try again."); continue; }
    return password;
  }
}

// A tester's email is never mailed; it just has to be unique.
const testerEmail = (username) => `${username.toLowerCase()}@testers.whiffers.invalid`;

async function findByUsername(ctx, username) {
  return ctx.adapter.findOne({ model: 'user', where: [{ field: 'username', value: username.toLowerCase() }] });
}

const [command, arg] = process.argv.slice(2);
const db = await openDatabase();
const auth = createAuth({ database: db.database });
await ensureAuthSchema(auth);
const ctx = await auth.$context;
console.log(`(using ${db.where})`);

try {
  if (command === 'add') {
    const username = arg || await ask('Username (3-20 letters, numbers, _): ');
    if (!USERNAME_PATTERN.test(username)) throw new Error('Usernames are 3-20 letters, numbers or underscores.');
    if (await findByUsername(ctx, username)) throw new Error(`${username} is already taken.`);
    const password = await askPassword(ctx);
    const user = await ctx.internalAdapter.createUser({
      email: testerEmail(username),
      emailVerified: true,
      name: username,
      username: username.toLowerCase(),
      displayUsername: username,
      role: 'tester',
    });
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: await ctx.password.hash(password),
    });
    console.log(`Created tester ${username}. They sign in from "Tester sign-in" with that username and password.`);
  } else if (command === 'list') {
    const testers = await ctx.adapter.findMany({ model: 'user', where: [{ field: 'role', value: 'tester' }] });
    if (!testers.length) console.log('No testers yet.');
    for (const t of testers) console.log(`${t.displayUsername || t.username}  (created ${new Date(t.createdAt).toISOString().slice(0, 10)})`);
  } else if (command === 'remove' || command === 'password') {
    if (!arg) throw new Error(`Usage: node scripts/testers.mjs ${command} <username>`);
    const user = await findByUsername(ctx, arg);
    if (!user || user.role !== 'tester') throw new Error(`No tester called ${arg}.`);
    if (command === 'remove') {
      await ctx.internalAdapter.deleteUserSessions(user.id);
      await ctx.internalAdapter.deleteAccounts(user.id);
      await ctx.internalAdapter.deleteUser(user.id);
      console.log(`Removed tester ${arg}.`);
    } else {
      await ctx.internalAdapter.updatePassword(user.id, await ctx.password.hash(await askPassword(ctx)));
      await ctx.internalAdapter.deleteUserSessions(user.id); // sign them out everywhere
      console.log(`New password set for ${arg}; they've been signed out everywhere.`);
    }
  } else {
    console.log('Usage: node scripts/testers.mjs add | list | remove <username> | password <username>');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  rl.close();
  await db.close();
}
