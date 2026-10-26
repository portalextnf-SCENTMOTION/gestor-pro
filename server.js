require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Strip any sslmode= param from the URL so pg doesn't silently upgrade it to
// full certificate verification (which fails against providers like Neon
// whose certs aren't always in Node's default trust store). We control SSL
// explicitly below instead.
function stripSslMode(connStr) {
  if (!connStr) return connStr;
  try {
    const url = new URL(connStr);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch (err) {
    return connStr;
  }
}
const rawDbUrl = process.env.DATABASE_URL;
const isLocalDb = !!rawDbUrl && rawDbUrl.includes('localhost');

const pool = new Pool({
  connectionString: stripSslMode(rawDbUrl),
  ssl: !rawDbUrl || isLocalDb ? false : { rejectUnauthorized: false }
});

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'SCENTMOTION.ES';

// ---- Password hashing (scrypt, built into Node: no extra dependencies) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(password, stored) {
  try {
    const [alg, saltHex, hashHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(got, expected);
  } catch (e) { return false; }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      data JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci ON users (LOWER(username));
  `);
  // First run: create the administrator and move the existing single-user data to it.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const old = await pool.query('SELECT data FROM app_state WHERE id = 1');
    const oldData = old.rows.length ? old.rows[0].data : null;
    await pool.query(
      'INSERT INTO users (username, password_hash, role, data) VALUES ($1, $2, $3, $4)',
      [ADMIN_USERNAME, hashPassword(APP_PASSWORD), 'admin', oldData ? JSON.stringify(oldData) : null]
    );
    console.log(`Administrador "${ADMIN_USERNAME}" creado${oldData ? ' (datos anteriores migrados)' : ''}.`);
  }
}

// ---- Minimal stateless signed-cookie auth (no session store needed) ----
function sign(value) {
  const h = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  return `${value}.${h}`;
}
function verify(signed) {
  if (!signed) return null;
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [expiresAt] = value.split('|');
  if (Date.now() > Number(expiresAt)) return null;
  return value;
}
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq === -1) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}
async function currentUser(req) {
  const valid = verify(parseCookies(req)['gp_session']);
  if (!valid) return null;
  const id = parseInt(valid.split('|')[1], 10);
  if (!id) return null;
  const r = await pool.query('SELECT id, username, role FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}
async function requireAuth(req, res, next) {
  try {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: 'No autenticado' });
    req.user = u;
    next();
  } catch (e) { res.status(500).json({ error: 'Error de servidor' }); }
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador' });
  next();
}
function setSession(res, userId) {
  const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  const token = sign(`${expiresAt}|${userId}`);
  res.setHeader('Set-Cookie', `gp_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`);
}

app.use(express.json({ limit: '25mb' }));

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'Faltan usuario o contraseña' });
  }
  try {
    const r = await pool.query('SELECT id, username, role, password_hash FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
    const u = r.rows[0];
    if (!u || !checkPassword(password, u.password_hash)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    setSession(res, u.id);
    res.json({ ok: true, user: { username: u.username, role: u.role } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error de servidor' }); }
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `gp_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
});

app.get('/api/session', async (req, res) => {
  try {
    const u = await currentUser(req);
    res.json(u ? { authenticated: true, user: { username: u.username, role: u.role } } : { authenticated: false });
  } catch (e) { res.json({ authenticated: false }); }
});

app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT data, updated_at FROM users WHERE id = $1', [req.user.id]);
    res.json({ data: r.rows[0] ? r.rows[0].data : null, updatedAt: r.rows[0] ? r.rows[0].updated_at : null });
  } catch (err) {
    console.error('GET /api/data failed:', err);
    res.status(500).json({ error: 'Error leyendo los datos' });
  }
});

app.put('/api/data', requireAuth, async (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Cuerpo inválido' });
  try {
    await pool.query('UPDATE users SET data = $1, updated_at = now() WHERE id = $2', [JSON.stringify(data), req.user.id]);
    res.json({ ok: true, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('PUT /api/data failed:', err);
    res.status(500).json({ error: 'Error guardando los datos' });
  }
});

// ---- Administración de usuarios (solo admin) ----
const validName = n => typeof n === 'string' && n.trim().length >= 2 && n.trim().length <= 60;
const validPass = p => typeof p === 'string' && p.length >= 6 && p.length <= 200;

app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY id');
  res.json({ users: r.rows });
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!validName(username)) return res.status(400).json({ error: 'Nombre de usuario no válido (mínimo 2 caracteres)' });
  if (!validPass(password)) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  try {
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
      [username.trim(), hashPassword(password), role === 'admin' ? 'admin' : 'user']);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese nombre' });
    console.error(e); res.status(500).json({ error: 'Error de servidor' });
  }
});

app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { username, password, role } = req.body || {};
  try {
    const cur = (await pool.query('SELECT id, role FROM users WHERE id = $1', [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (username !== undefined && !validName(username)) return res.status(400).json({ error: 'Nombre de usuario no válido' });
    if (password && !validPass(password)) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    const newRole = role === 'admin' ? 'admin' : role === 'user' ? 'user' : cur.role;
    if (cur.role === 'admin' && newRole !== 'admin') {
      const n = (await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'")).rows[0].n;
      if (n <= 1) return res.status(400).json({ error: 'Debe quedar al menos un administrador' });
    }
    if (username !== undefined) await pool.query('UPDATE users SET username = $1 WHERE id = $2', [username.trim(), id]);
    if (password) await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(password), id]);
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [newRole, id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese nombre' });
    console.error(e); res.status(500).json({ error: 'Error de servidor' });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
  const r = await pool.query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: r.rowCount > 0 });
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Gestor Pro escuchando en puerto ${PORT}`));
  })
  .catch(err => {
    console.error('No se pudo inicializar la base de datos:', err);
    process.exit(1);
  });
