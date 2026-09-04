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

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);
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
function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies['gp_session'];
  const valid = verify(token);
  if (!valid) return res.status(401).json({ error: 'No autenticado' });
  next();
}

app.use(express.json({ limit: '25mb' }));

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'Falta la contraseña' });
  }
  const a = Buffer.from(password);
  const b = Buffer.from(APP_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });

  const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  const token = sign(`${expiresAt}|ok`);
  res.setHeader('Set-Cookie', `gp_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `gp_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const cookies = parseCookies(req);
  const valid = verify(cookies['gp_session']);
  res.json({ authenticated: !!valid });
});

app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT data, updated_at FROM app_state WHERE id = 1');
    if (result.rows.length === 0) {
      return res.json({ data: null, updatedAt: null });
    }
    res.json({ data: result.rows[0].data, updatedAt: result.rows[0].updated_at });
  } catch (err) {
    console.error('GET /api/data failed:', err);
    res.status(500).json({ error: 'Error leyendo los datos' });
  }
});

app.put('/api/data', requireAuth, async (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Cuerpo inválido' });
  }
  try {
    await pool.query(
      `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify(data)]
    );
    res.json({ ok: true, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('PUT /api/data failed:', err);
    res.status(500).json({ error: 'Error guardando los datos' });
  }
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
