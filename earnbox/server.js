'use strict';
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const POINTS_PER_UNIT = 100;
const MIN_WITHDRAW_POINTS = 1000;
const DAILY_BONUS_POINTS = 10;
const REFERRAL_BONUS_POINTS = 50;
const PAYOUT_METHODS = ['PayPal', 'Bank transfer', 'Airtime / data voucher'];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined) });

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) throw new Error('Set ADMIN_PASSWORD to a unique password of at least 12 characters');
if (!process.env.POSTBACK_SECRET || process.env.POSTBACK_SECRET.length < 32) throw new Error('Set POSTBACK_SECRET to a random secret of at least 32 characters');
if (!/^[a-f0-9]{64}$/i.test(process.env.PAYOUT_ENCRYPTION_KEY || '')) throw new Error('PAYOUT_ENCRYPTION_KEY must be 64 hexadecimal characters');

app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"] } }, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '20kb', type: 'application/json' }));
app.use(cookieParser());
const secureCookie = process.env.NODE_ENV === 'production';
const cookieOptions = { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 * 1000 };
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const random = (n = 32) => crypto.randomBytes(n).toString('hex');
const pointsToMoney = (n) => (Number(n) / POINTS_PER_UNIT).toFixed(2);
const fail = (res, code, error) => res.status(code).json({ error });

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(process.env.PAYOUT_ENCRYPTION_KEY, 'hex'), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), body.toString('hex')].join(':');
}
function decrypt(value) {
  const [iv, tag, body] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(process.env.PAYOUT_ENCRYPTION_KEY, 'hex'), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'hex')), decipher.final()]).toString('utf8');
}
function checkCsrf(req, res, next) {
  const token = req.get('x-csrf-token');
  const cookie = req.cookies.eb_csrf;
  if (!token || !cookie || token !== cookie) return fail(res, 403, 'Security token expired. Refresh and try again.');
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) return fail(res, 403, 'Request origin not allowed');
  next();
}
async function session(req, res, next) {
  const token = req.cookies.eb_session;
  if (token) {
    const result = await pool.query('SELECT token_hash,user_id,is_admin,expires_at FROM sessions WHERE token_hash=$1 AND expires_at>NOW()', [sha(token)]);
    req.auth = result.rows[0] || null;
    if (req.auth && !req.auth.is_admin) {
      const u = await pool.query('SELECT id,username,balance,lifetime,ref_code,referred_by,last_daily,banned,created_at FROM users WHERE id=$1', [req.auth.user_id]);
      req.user = u.rows[0] || null;
    }
  }
  next();
}
app.use('/api', session);
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });
const requireUser = (req, res, next) => req.user ? (req.user.banned ? fail(res, 403, 'This account is suspended') : next()) : fail(res, 401, 'Please log in');
const requireAdmin = (req, res, next) => req.auth?.is_admin ? next() : fail(res, 401, 'Admin login required');
function publicUser(u, referrals = 0) {
  return { id: Number(u.id), username: u.username, balance: Number(u.balance), lifetime: Number(u.lifetime), refCode: u.ref_code, referrals, nextDailyAt: u.last_daily ? new Date(new Date(u.last_daily).getTime() + 86400000).getTime() : 0 };
}
async function newSession(res, userId, admin = false) {
  const token = random();
  await pool.query('INSERT INTO sessions(token_hash,user_id,is_admin,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL \'30 days\')', [sha(token), admin ? null : userId, admin]);
  res.cookie('eb_session', token, cookieOptions);
}
async function tx(fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
  catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

app.get('/api/csrf', (req, res) => {
  let token = req.cookies.eb_csrf;
  if (!token || token.length < 32) { token = random(); res.cookie('eb_csrf', token, { httpOnly: false, secure: secureCookie, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 * 1000 }); }
  res.set('Cache-Control', 'no-store').json({ token });
});
app.get('/api/config', (req, res) => res.json({ appName: 'EarnBox', currencySymbol: 'R', pointsPerUnit: POINTS_PER_UNIT, minWithdrawPoints: MIN_WITHDRAW_POINTS, dailyBonusPoints: DAILY_BONUS_POINTS, referralBonusPoints: REFERRAL_BONUS_POINTS, payoutMethods: PAYOUT_METHODS }));

app.post('/api/signup', signupLimiter, checkCsrf, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return fail(res, 400, 'Username must be 3–20 letters, numbers, or underscores.');
  if (password.length < 10 || password.length > 100) return fail(res, 400, 'Password must be 10–100 characters.');
  const hash = await bcrypt.hash(password, 12);
  try {
    const result = await tx(async (c) => {
      const ref = String(req.body.ref || '').trim().toUpperCase();
      const inviter = ref ? (await c.query('SELECT id FROM users WHERE ref_code=$1 AND banned=FALSE', [ref])).rows[0] : null;
      const code = random(5).toUpperCase();
      const user = (await c.query('INSERT INTO users(username,username_key,password_hash,ref_code,referred_by) VALUES($1,$2,$3,$4,$5) RETURNING id,username,balance,lifetime,ref_code,referred_by,last_daily', [username, username.toLowerCase(), hash, code, inviter?.id || null])).rows[0];
      if (inviter) {
        await c.query('UPDATE users SET balance=balance+$1,lifetime=lifetime+$1 WHERE id=$2', [REFERRAL_BONUS_POINTS, inviter.id]);
        await c.query('INSERT INTO transactions(user_id,points,type,note) VALUES($1,$2,\'referral\',$3)', [inviter.id, REFERRAL_BONUS_POINTS, `${username} joined with your code`]);
      }
      return user;
    });
    await newSession(res, result.id);
    res.status(201).json({ user: publicUser(result) });
  } catch (e) {
    if (e.code === '23505') return fail(res, 400, 'That username is already taken. Please choose another.');
    throw e;
  }
});
app.post('/api/login', authLimiter, checkCsrf, async (req, res) => {
  const key = String(req.body.username || '').trim().toLowerCase();
  const result = await pool.query('SELECT id,username,password_hash,banned,balance,lifetime,ref_code,referred_by,last_daily FROM users WHERE username_key=$1', [key]);
  const u = result.rows[0];
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) return fail(res, 401, 'Wrong username or password.');
  if (u.banned) return fail(res, 403, 'This account is suspended.');
  await newSession(res, u.id);
  res.json({ user: publicUser(u) });
});
app.post('/api/logout', checkCsrf, async (req, res) => {
  if (req.cookies.eb_session) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha(req.cookies.eb_session)]);
  res.clearCookie('eb_session', { ...cookieOptions, maxAge: undefined });
  res.json({ ok: true });
});
app.get('/api/me', requireUser, async (req, res) => {
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE referred_by=$1', [req.user.id]);
  res.json({ user: publicUser(req.user, count.rows[0].n) });
});
app.get('/api/tasks', requireUser, async (req, res) => {
  const { rows } = await pool.query('SELECT id,title,description,points,url FROM tasks WHERE active=TRUE ORDER BY id');
  res.json({ tasks: rows.map(t => ({ ...t, id: Number(t.id), points: Number(t.points), url: t.url ? t.url.replaceAll('{userId}', String(req.user.id)) : '' })) });
});
app.get('/api/history', requireUser, async (req, res) => {
  const { rows } = await pool.query('SELECT id,points,type,note,created_at AS "createdAt" FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  res.json({ items: rows.map(x => ({ ...x, id: Number(x.id), points: Number(x.points), createdAt: new Date(x.createdAt).getTime() })) });
});
app.get('/api/withdrawals', requireUser, async (req, res) => {
  const { rows } = await pool.query('SELECT id,points,amount,method,status,created_at AS "createdAt" FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  res.json({ items: rows.map(x => ({ ...x, id: Number(x.id), points: Number(x.points), amount: Number(x.amount), createdAt: new Date(x.createdAt).getTime() })) });
});
app.post('/api/daily', requireUser, checkCsrf, async (req, res) => {
  const user = await tx(async c => {
    const r = await c.query('UPDATE users SET balance=balance+$1,lifetime=lifetime+$1,last_daily=NOW() WHERE id=$2 AND (last_daily IS NULL OR last_daily<=NOW()-INTERVAL \'24 hours\') RETURNING id,username,balance,lifetime,ref_code,referred_by,last_daily', [DAILY_BONUS_POINTS, req.user.id]);
    if (!r.rowCount) return null;
    await c.query('INSERT INTO transactions(user_id,points,type,note) VALUES($1,$2,\'daily\',\'Daily bonus\')', [req.user.id, DAILY_BONUS_POINTS]);
    return r.rows[0];
  });
  if (!user) return fail(res, 400, 'Daily bonus already claimed. Come back later.');
  res.json({ user: publicUser(user) });
});
app.post('/api/withdraw', requireUser, checkCsrf, async (req, res) => {
  const points = Math.floor(Number(req.body.points));
  const method = String(req.body.method || '');
  const account = String(req.body.account || '').trim();
  if (!Number.isSafeInteger(points) || points < MIN_WITHDRAW_POINTS) return fail(res, 400, `Minimum cash-out is ${MIN_WITHDRAW_POINTS} points.`);
  if (points > 1000000000) return fail(res, 400, 'Amount is too large.');
  if (!PAYOUT_METHODS.includes(method)) return fail(res, 400, 'Choose a payout method.');
  if (account.length < 3 || account.length > 200) return fail(res, 400, 'Enter valid payout details (3–200 characters).');
  const out = await tx(async c => {
    const r = await c.query('SELECT id,username,balance FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    const u = r.rows[0];
    if (!u || Number(u.balance) < points) return false;
    await c.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [points, u.id]);
    const amount = pointsToMoney(points);
    await c.query('INSERT INTO withdrawals(user_id,points,amount,method,account_encrypted) VALUES($1,$2,$3,$4,$5)', [u.id, points, amount, method, encrypt(account)]);
    await c.query('INSERT INTO transactions(user_id,points,type,note) VALUES($1,$2,\'withdraw\',$3)', [u.id, -points, `Cash-out request (${method})`]);
    return true;
  });
  if (!out) return fail(res, 400, 'You do not have enough points.');
  res.json({ ok: true });
});

app.post('/api/admin/login', authLimiter, checkCsrf, async (req, res) => {
  const password = String(req.body.password || '');
  if (!(await bcrypt.compare(password, await bcrypt.hash(process.env.ADMIN_PASSWORD, 10)))) return fail(res, 401, 'Wrong admin password.');
  await newSession(res, null, true);
  res.json({ ok: true });
});
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT (SELECT COUNT(*) FROM users)::int AS users,
    (SELECT COALESCE(SUM(balance),0) FROM users)::bigint AS points_owed,
    (SELECT COUNT(*) FROM withdrawals WHERE status='pending')::int AS pending_count,
    (SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE status='pending')::numeric AS pending_amount,
    (SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE status='paid')::numeric AS paid_amount`);
  res.json({ ...rows[0], points_owed: Number(rows[0].points_owed), currencySymbol: 'R' });
});
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id,username,balance,lifetime,banned,created_at AS "createdAt" FROM users ORDER BY created_at DESC LIMIT 500');
  res.json({ items: rows.map(x => ({ ...x, id: Number(x.id), balance: Number(x.balance), lifetime: Number(x.lifetime), createdAt: new Date(x.createdAt).getTime() })) });
});
app.post('/api/admin/users/:id/ban', requireAdmin, checkCsrf, async (req, res) => {
  const userId = Number(req.params.id);
  const r = await pool.query('UPDATE users SET banned=NOT banned WHERE id=$1 RETURNING banned', [userId]);
  if (!r.rowCount) return fail(res, 404, 'User not found.');
  if (r.rows[0].banned) await pool.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  res.json({ banned: r.rows[0].banned });
});
app.post('/api/admin/credit', requireAdmin, checkCsrf, async (req, res) => {
  const userId = Number(req.body.userId), points = Math.trunc(Number(req.body.points));
  const note = String(req.body.note || 'Admin adjustment').slice(0, 100);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(points) || !points || Math.abs(points) > 1000000) return fail(res, 400, 'Enter a valid user and points amount.');
  const ok = await tx(async c => {
    const r = await c.query('UPDATE users SET balance=balance+$1,lifetime=lifetime+GREATEST($1,0) WHERE id=$2 AND balance+$1>=0 RETURNING id', [points, userId]);
    if (!r.rowCount) return false;
    await c.query('INSERT INTO transactions(user_id,points,type,note) VALUES($1,$2,\'admin\',$3)', [userId, points, note]);
    return true;
  });
  if (!ok) return fail(res, 400, 'User not found or adjustment would make balance negative.');
  res.json({ ok: true });
});
app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT w.id,w.user_id AS "userId",u.username,w.points,w.amount,w.method,w.account_encrypted,w.status,w.created_at AS "createdAt" FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY CASE w.status WHEN \'pending\' THEN 0 WHEN \'paid\' THEN 1 ELSE 2 END,w.created_at DESC LIMIT 500');
  res.json({ items: rows.map(w => { let account = ''; try { account = decrypt(w.account_encrypted); } catch { account = '[unable to decrypt]'; } const { account_encrypted, ...item } = w; return { ...item, account, id: Number(w.id), userId: Number(w.userId), points: Number(w.points), amount: Number(w.amount), createdAt: new Date(w.createdAt).getTime() }; }) });
});
app.post('/api/admin/withdrawals/:id/:action(paid|rejected)', requireAdmin, checkCsrf, async (req, res) => {
  const status = req.params.action;
  const done = await tx(async c => {
    const r = await c.query('SELECT id,user_id,points,status FROM withdrawals WHERE id=$1 FOR UPDATE', [Number(req.params.id)]);
    const w = r.rows[0];
    if (!w || w.status !== 'pending') return false;
    await c.query('UPDATE withdrawals SET status=$1,handled_at=NOW() WHERE id=$2', [status, w.id]);
    if (status === 'rejected') {
      await c.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [w.points, w.user_id]);
      await c.query('INSERT INTO transactions(user_id,points,type,note) VALUES($1,$2,\'refund\',\'Cash-out rejected, points returned\')', [w.user_id, w.points]);
    }
    return true;
  });
  if (!done) return fail(res, 400, 'Withdrawal not found or already handled.');
  res.json({ ok: true });
});
app.get('/api/admin/tasks', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id,title,description,points,url,active FROM tasks ORDER BY id DESC');
  res.json({ items: rows.map(x => ({ ...x, id: Number(x.id), points: Number(x.points) })) });
});
app.post('/api/admin/tasks', requireAdmin, checkCsrf, async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 60), description = String(req.body.description || '').trim().slice(0, 140), points = Math.trunc(Number(req.body.points)), url = String(req.body.url || '').trim();
  if (!title || !Number.isSafeInteger(points) || points <= 0 || points > 1000000) return fail(res, 400, 'Enter a title and a positive points value.');
  if (url && (!url.startsWith('https://') || url.length > 1000)) return fail(res, 400, 'Task link must be a valid HTTPS URL.');
  await pool.query('INSERT INTO tasks(title,description,points,url) VALUES($1,$2,$3,$4)', [title, description, points, url]);
  res.json({ ok: true });
});
app.post('/api/admin/tasks/:id/toggle', requireAdmin, checkCsrf, async (req, res) => {
  const r = await pool.query('UPDATE tasks SET active=NOT active WHERE id=$1 RETURNING active', [Number(req.params.id)]);
  if (!r.rowCount) return fail(res, 404, 'Task not found.');
  res.json({ active: r.rows[0].active });
});
app.delete('/api/admin/tasks/:id', requireAdmin, checkCsrf, async (req, res) => {
  const r = await pool.query('DELETE FROM tasks WHERE id=$1', [Number(req.params.id)]);
  if (!r.rowCount) return fail(res, 404, 'Task not found.');
  res.json({ ok: true });
});

// Signed reward callback: HMAC-SHA256 hex over "user_id:points:txid".
// Keep POSTBACK_SECRET private and configure the offer provider to sign this payload.
app.post('/api/postback', async (req, res) => {
  const { user_id, points: rawPoints, txid, signature } = req.body || {};
  const uid = Number(user_id), points = Math.trunc(Number(rawPoints));
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(points) || points < 1 || points > 100000 || typeof txid !== 'string' || !txid || txid.length > 150 || typeof signature !== 'string') return fail(res, 400, 'Invalid callback payload.');
  const expected = crypto.createHmac('sha256', process.env.POSTBACK_SECRET).update(`${uid}:${points}:${txid}`).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'hex'); } catch { return fail(res, 403, 'Invalid signature.'); }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return fail(res, 403, 'Invalid signature.');
  const credited = await tx(async c => {
    const u = await c.query('SELECT id,banned FROM users WHERE id=$1', [uid]);
    if (!u.rowCount) return 'missing';
    try { await c.query('INSERT INTO postbacks(txid,user_id,points) VALUES($1,$2,$3)', [txid, uid, points]); }
    catch (e) { if (e.code === '23505') return 'duplicate'; throw e; }
    if (!u.rows[0].banned) {
      await c.query('UPDATE users SET balance=balance+$1,lifetime=lifetime+$1 WHERE id=$2', [points, uid]);
      await c.query('INSERT INTO transactions(user_id,points,type,note) VALUES($1,$2,\'offer\',\'Completed an offer\')', [uid, points]);
    }
    return 'credited';
  });
  if (credited === 'missing') return fail(res, 404, 'User not found.');
  res.json({ ok: true, duplicate: credited === 'duplicate' });
});

app.use('/api', (req, res) => fail(res, 404, 'Not found.'));
app.use(express.static(PUBLIC, { index: 'index.html', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, dotfiles: 'deny' }));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : err.message });
});

async function start() {
  await pool.query(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM tasks');
  if (!count.rows[0].n) await pool.query(`INSERT INTO tasks(title,description,points,url) VALUES
    ('Complete surveys','Share your opinion and get rewarded.',150,''),
    ('Try apps','Discover new apps and offers.',300,''),
    ('Play games','Reach milestones in mobile games.',500,'')`);
  const server = app.listen(PORT, () => console.log(`EarnBox running on port ${PORT}`));
  const shutdown = () => server.close(async () => { await pool.end(); process.exit(0); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
start().catch(e => { console.error('EarnBox startup failed:', e); process.exit(1); });
