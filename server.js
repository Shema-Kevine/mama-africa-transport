'use strict';

/**
 * Mama Africa Transport API
 *
 * Small dependency-free service for the static dashboard. It provides a
 * shared SQLite database, server-side sessions, role enforcement, GPS
 * receipts, document metadata/encrypted file storage, and audit logging.
 * The browser UI can still run in local-only mode when this service is not
 * available.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'data', 'mama-africa.sqlite'));
const staticRoot = path.resolve(process.env.STATIC_ROOT || __dirname);
const dataDirectory = path.dirname(databasePath);
const allowedOrigin = String(process.env.ALLOWED_ORIGIN || '').trim().replace(/\/$/, '');
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const maxJsonBytes = 12 * 1024 * 1024;
const maxDocumentBytes = 8 * 1024 * 1024;
const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const secureCookies = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true' || (isProduction && /^https:\/\//i.test(allowedOrigin));
const configuredAdminPassword = String(process.env.ADMIN_PASSWORD || '').trim();
const configuredDocumentKey = String(process.env.DOCUMENT_ENCRYPTION_KEY || '').trim();
if (isProduction && !configuredAdminPassword) throw new Error('ADMIN_PASSWORD must be set in production.');
if (isProduction && !configuredDocumentKey) throw new Error('DOCUMENT_ENCRYPTION_KEY must be set in production.');

fs.mkdirSync(dataDirectory, { recursive: true });
const db = new DatabaseSync(databasePath);
try { fs.chmodSync(databasePath, 0o600); } catch { /* best effort on non-POSIX volumes */ }
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK(role IN ('admin', 'driver')),
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    driver_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Active',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    language TEXT NOT NULL DEFAULT 'en',
    privacy_consent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS taxis (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    driver_id TEXT NOT NULL,
    taxi_id TEXT NOT NULL DEFAULT '',
    record_date TEXT NOT NULL DEFAULT '',
    record_time TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS trips_driver_idx ON trips(driver_id, record_date DESC, record_time DESC);
  CREATE TABLE IF NOT EXISTS fuel_records (
    id TEXT PRIMARY KEY,
    driver_id TEXT NOT NULL,
    taxi_id TEXT NOT NULL DEFAULT '',
    record_date TEXT NOT NULL DEFAULT '',
    record_time TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS fuel_driver_idx ON fuel_records(driver_id, record_date DESC, record_time DESC);
  CREATE TABLE IF NOT EXISTS maintenance_records (
    id TEXT PRIMARY KEY,
    driver_id TEXT NOT NULL,
    taxi_id TEXT NOT NULL DEFAULT '',
    record_date TEXT NOT NULL DEFAULT '',
    record_time TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS maintenance_driver_idx ON maintenance_records(driver_id, record_date DESC, record_time DESC);
  CREATE TABLE IF NOT EXISTS gps_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    taxi_id TEXT NOT NULL,
    driver_id TEXT NOT NULL DEFAULT '',
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    accuracy REAL,
    source TEXT NOT NULL DEFAULT 'driver-portal',
    consent_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS gps_taxi_idx ON gps_locations(taxi_id, recorded_at DESC);
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    driver_id TEXT NOT NULL,
    taxi_id TEXT NOT NULL DEFAULT '',
    document_type TEXT NOT NULL DEFAULT '',
    document_number TEXT NOT NULL DEFAULT '',
    authority TEXT NOT NULL DEFAULT '',
    expiry TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Pending',
    reference TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    byte_size INTEGER NOT NULL DEFAULT 0,
    content BLOB,
    content_iv BLOB,
    content_tag BLOB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS documents_driver_idx ON documents(driver_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT '',
    entity_id TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at DESC);
`);

function nowIso() {
  return new Date().toISOString();
}

function id(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(8).toString('hex')}`;
}

function safeJson(value, fallback = {}) {
  try {
    if (typeof value === 'string' && value.startsWith('enc:v1:')) return JSON.parse(decryptPayload(value));
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  response.end(body);
}

function sendError(response, status, message, details = undefined) {
  sendJson(response, status, { error: message, ...(details ? { details } : {}) });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxJsonBytes) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function parseCookies(request) {
  const header = String(request.headers.cookie || '');
  return Object.fromEntries(header.split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, expected] = String(stored || '').split(':');
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(String(password), salt, 64);
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (expectedBuffer.length === actual.length && crypto.timingSafeEqual(actual, expectedBuffer)) return true;
    const legacyExpected = Buffer.from(crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex'), 'hex');
    return legacyExpected.length === expectedBuffer.length && crypto.timingSafeEqual(legacyExpected, expectedBuffer);
  } catch {
    return false;
  }
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    username: row.username,
    driverId: row.driver_id || '',
    status: row.status,
    mustChangePassword: Boolean(row.must_change_password),
    privacyConsent: Boolean(row.privacy_consent),
    language: row.language || 'en',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at || ''
  };
}

function userForRequest(request) {
  const token = parseCookies(request).mama_session;
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'Active'
  `).get(tokenHash, Date.now());
  if (!row) return null;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), tokenHash);
  return publicUser(row);
}

function sessionCookie(token, maxAgeSeconds = Math.floor(sessionTtlMs / 1000)) {
  const secure = secureCookies ? '; Secure' : '';
  return `mama_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearSessionCookie() {
  return 'mama_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

function requireUser(request, response, role = '') {
  const user = userForRequest(request);
  if (!user) {
    sendError(response, 401, 'Authentication required.');
    return null;
  }
  if (role && user.role !== role) {
    sendError(response, 403, 'You do not have permission to perform this action.');
    return null;
  }
  return user;
}

function validateOrigin(request) {
  const origin = String(request.headers.origin || '').replace(/\/$/, '');
  return !origin || !allowedOrigin || origin === allowedOrigin;
}

function audit(userId, action, entityType = '', entityId = '', details = {}) {
  db.prepare('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(userId || ''), action, entityType, entityId, JSON.stringify(details), nowIso());
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validUsername(value) {
  return /^[a-z0-9._-]{4,40}$/.test(value);
}

function getAdminCount() {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'Active'").get().count || 0);
}

function seedAdmin() {
  if (getAdminCount()) return;
  const username = normalizeUsername(process.env.ADMIN_USERNAME || 'admin');
  const password = configuredAdminPassword || 'mamaafrica';
  const timestamp = nowIso();
  db.prepare(`INSERT INTO users (id, role, username, password_hash, status, privacy_consent, created_at, updated_at) VALUES (?, 'admin', ?, ?, 'Active', 1, ?, ?)`)
    .run(id('usr_'), username, hashPassword(password), timestamp, timestamp);
  console.warn(`Created bootstrap administrator '${username}'. Change ADMIN_PASSWORD before production.`);
}

seedAdmin();

function rowsForTable(table, user) {
  const config = {
    taxis: { admin: true },
    drivers: { admin: true },
    trips: { driver: 'driver_id' },
    fuel_records: { driver: 'driver_id' },
    maintenance_records: { driver: 'driver_id' }
  }[table];
  if (!config) return [];
  if (user.role === 'admin') return db.prepare(`SELECT data FROM ${table}`).all().map(row => safeJson(row.data));
  if (table === 'drivers') return db.prepare('SELECT data FROM drivers WHERE id = ?').all(user.driverId).map(row => safeJson(row.data));
  if (table === 'taxis') {
    const taxi = assignedTaxiForUser(user);
    return taxi ? [safeJson(taxi.data)] : [];
  }
  return db.prepare(`SELECT data FROM ${table} WHERE ${config.driver} = ?`).all(user.driverId).map(row => safeJson(row.data));
}

function assignedTaxiForUser(user) {
  if (user.role === 'admin') return null;
  const driver = db.prepare('SELECT data FROM drivers WHERE id = ?').get(user.driverId);
  const data = safeJson(driver?.data);
  return data.taxiId ? db.prepare('SELECT data FROM taxis WHERE id = ?').get(data.taxiId) : null;
}

function latestGpsForUser(user) {
  const taxiRows = user.role === 'admin'
    ? db.prepare('SELECT taxi_id, latitude, longitude, accuracy, source, recorded_at FROM gps_locations ORDER BY recorded_at DESC').all()
    : (() => {
        const taxi = assignedTaxiForUser(user);
        return taxi ? db.prepare('SELECT taxi_id, latitude, longitude, accuracy, source, recorded_at FROM gps_locations WHERE taxi_id = ? ORDER BY recorded_at DESC LIMIT 1').all(safeJson(taxi.data).id) : [];
      })();
  const latest = new Map();
  for (const row of taxiRows) if (!latest.has(row.taxi_id)) latest.set(row.taxi_id, row);
  return Object.fromEntries([...latest.entries()].map(([taxiId, row]) => [taxiId, {
    lat: row.latitude,
    lon: row.longitude,
    accuracy: row.accuracy,
    source: row.source,
    updatedAt: row.recorded_at
  }]));
}

function documentsForUser(user) {
  const rows = user.role === 'admin'
    ? db.prepare('SELECT * FROM documents ORDER BY updated_at DESC').all()
    : db.prepare('SELECT * FROM documents WHERE driver_id = ? ORDER BY updated_at DESC').all(user.driverId);
  return rows.map(row => ({
    id: row.id,
    driverId: row.driver_id,
    taxiId: row.taxi_id,
    type: row.document_type,
    number: row.document_number,
    authority: row.authority,
    expiry: row.expiry,
    status: row.status,
    reference: row.reference,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function stateForUser(user) {
  const state = {
    taxis: rowsForTable('taxis', user),
    drivers: rowsForTable('drivers', user),
    trips: rowsForTable('trips', user),
    fuelRecords: rowsForTable('fuel_records', user),
    maintenanceRecords: rowsForTable('maintenance_records', user),
    taxiLocations: latestGpsForUser(user),
    documents: documentsForUser(user)
  };
  if (user.role === 'admin') state.userAccounts = db.prepare('SELECT * FROM users ORDER BY username').all().map(publicUser);
  return state;
}

const collectionTables = {
  taxis: 'taxis',
  drivers: 'drivers',
  trips: 'trips',
  fuelRecords: 'fuel_records',
  maintenanceRecords: 'maintenance_records'
};

function syncCollection(type, records, user) {
  const table = collectionTables[type];
  if (!table || !Array.isArray(records) || records.length > 10000) throw new Error('Invalid collection payload.');
  if ((type === 'taxis' || type === 'drivers') && user.role !== 'admin') throw new Error('Only administrators can change this collection.');
  const ids = [];
  const timestamp = nowIso();
  db.exec('BEGIN');
  try {
    for (const source of records) {
    if (!source || typeof source !== 'object') continue;
    const record = { ...source };
    if (JSON.stringify(record).length > 100000) throw new Error('A record is too large.');
    const recordId = String(record.id || id(type.slice(0, 3) + '_'));
    record.id = recordId;
    if (type === 'trips' || type === 'fuelRecords' || type === 'maintenanceRecords') {
      if (user.role !== 'admin' && String(record.driverId || '') !== user.driverId) throw new Error('A driver cannot write another driver\'s record.');
      if (user.role !== 'admin') {
        const assigned = assignedTaxiForUser(user);
        const assignedId = assigned ? safeJson(assigned.data).id : '';
        if (record.taxiId && assignedId && String(record.taxiId) !== assignedId) throw new Error('A driver record must use the assigned taxi.');
        record.taxiId = assignedId;
      }
      record.driverId = user.role === 'admin' ? String(record.driverId || '') : user.driverId;
    }
    ids.push(recordId);
    const data = encryptPayload(record);
    if (type === 'taxis' || type === 'drivers') {
      if (type === 'taxis') {
        const plate = String(record.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (plate && db.prepare('SELECT data FROM taxis WHERE id <> ?').all().map(row => safeJson(row.data)).some(item => String(item.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === plate)) throw new Error('A taxi with the same number plate already exists.');
      }
      if (type === 'drivers') {
        const identity = String(record.nin || record.license || '').trim().toUpperCase();
        if (identity) {
          const duplicate = db.prepare('SELECT data FROM drivers WHERE id <> ?').all().map(row => safeJson(row.data)).find(item => String(item.nin || item.license || '').trim().toUpperCase() === identity);
          if (duplicate) throw new Error('A driver with the same NIN or licence already exists.');
        }
      }
      db.prepare(`INSERT INTO ${table} (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`).run(recordId, data, timestamp);
    } else {
      db.prepare(`INSERT INTO ${table} (id, driver_id, taxi_id, record_date, record_time, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET driver_id=excluded.driver_id, taxi_id=excluded.taxi_id, record_date=excluded.record_date, record_time=excluded.record_time, data=excluded.data, updated_at=excluded.updated_at`)
        .run(recordId, String(record.driverId || ''), String(record.taxiId || ''), String(record.date || ''), String(record.time || ''), data, timestamp);
    }
  }
  if (!ids.length) {
    if (user.role === 'admin') db.prepare(`DELETE FROM ${table}`).run();
    else db.prepare(`DELETE FROM ${table} WHERE driver_id = ?`).run(user.driverId);
  } else {
    const placeholders = ids.map(() => '?').join(',');
    if (user.role === 'admin') db.prepare(`DELETE FROM ${table} WHERE id NOT IN (${placeholders})`).run(...ids);
    else db.prepare(`DELETE FROM ${table} WHERE driver_id = ? AND id NOT IN (${placeholders})`).run(user.driverId, ...ids);
  }
    audit(user.id, 'sync_collection', type, '', { count: records.length });
    db.exec('COMMIT');
    return stateForUser(user);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function syncAccounts(records, user) {
  if (user.role !== 'admin' || !Array.isArray(records) || records.length > 1000) throw new Error('Only administrators can sync accounts.');
  const timestamp = nowIso();
  const ids = [];
  for (const source of records) {
    if (!source || typeof source !== 'object') continue;
    const username = normalizeUsername(source.username);
    const role = source.role === 'driver' ? 'driver' : 'admin';
    if (!validUsername(username)) throw new Error('Every account needs a valid username.');
    const accountId = String(source.id || id('usr_'));
    const existing = db.prepare('SELECT * FROM users WHERE id = ? OR username = ?').get(accountId, username);
    const suppliedPassword = String(source.password || '');
    const suppliedHash = String(source.passwordHash || '');
    if (suppliedPassword && suppliedPassword.length < 10) throw new Error('Account passwords must be at least 10 characters.');
    const passwordHash = suppliedPassword
      ? hashPassword(suppliedPassword)
      : existing?.password_hash || (suppliedHash || '');
    if (!passwordHash) throw new Error('Every new account needs a password.');
    const driverId = role === 'driver' ? String(source.driverId || '') : '';
    db.prepare(`INSERT INTO users (id, role, username, password_hash, driver_id, status, must_change_password, language, privacy_consent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET role=excluded.role, username=excluded.username, password_hash=excluded.password_hash, driver_id=excluded.driver_id, status=excluded.status, must_change_password=excluded.must_change_password, language=excluded.language, privacy_consent=excluded.privacy_consent, updated_at=excluded.updated_at`)
      .run(accountId, role, username, passwordHash, driverId, source.status === 'Suspended' ? 'Suspended' : 'Active', source.mustChangePassword ? 1 : 0, String(source.language || 'en'), source.privacyConsent ? 1 : 0, existing?.created_at || timestamp, timestamp);
    ids.push(accountId);
  }
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM users WHERE id NOT IN (${placeholders}) AND role <> 'admin'`).run(...ids);
  }
  audit(user.id, 'sync_accounts', 'user', '', { count: records.length });
  return stateForUser(user);
}

function documentKey() {
  const configured = String(process.env.DOCUMENT_ENCRYPTION_KEY || '').trim();
  if (configured) return crypto.createHash('sha256').update(configured).digest();
  const keyPath = path.join(dataDirectory, 'document.key');
  try {
    if (fs.existsSync(keyPath)) return Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
    const generated = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, generated.toString('hex'), { mode: 0o600 });
    return generated;
  } catch {
    return crypto.createHash('sha256').update(`${databasePath}:document-key`).digest();
  }
}

const encryptionKey = documentKey();

function encryptPayload(value) {
  const encrypted = encryptContent(Buffer.from(JSON.stringify(value)));
  return `enc:v1:${encrypted.iv.toString('base64url')}:${encrypted.tag.toString('base64url')}:${encrypted.content.toString('base64url')}`;
}

function decryptPayload(value) {
  const parts = String(value).split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') throw new Error('Invalid encrypted payload.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(parts[2], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8');
}

function encryptContent(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const content = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return { content, iv, tag: cipher.getAuthTag() };
}

function decryptContent(row) {
  if (!row.content) return Buffer.alloc(0);
  if (!row.content_iv || !row.content_tag) return Buffer.from(row.content);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(row.content_iv));
  decipher.setAuthTag(Buffer.from(row.content_tag));
  return Buffer.concat([decipher.update(Buffer.from(row.content)), decipher.final()]);
}

function getDocumentForUser(documentId, user) {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  if (!row || (user.role !== 'admin' && row.driver_id !== user.driverId)) return null;
  return row;
}

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  if (request.method !== 'GET' && !validateOrigin(request)) {
    sendError(response, 403, 'Request origin is not allowed.');
    return;
  }

  if (request.method === 'GET' && pathname === '/api/health') {
    sendJson(response, 200, { ok: true, database: true, encryptedDocuments: true, configured: true });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/auth/session') {
    const user = userForRequest(request);
    if (!user) {
      sendError(response, 401, 'No active session.');
      return;
    }
    sendJson(response, 200, { user, state: stateForUser(user) });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/login') {
    let body;
    try { body = await readJson(request); } catch (error) { sendError(response, 400, error.message); return; }
    const username = normalizeUsername(body.username);
    const role = body.role === 'driver' ? 'driver' : 'admin';
    const row = db.prepare('SELECT * FROM users WHERE username = ? AND role = ? AND status = \'Active\'').get(username, role);
    if (!row || !verifyPassword(body.password, row.password_hash)) {
      sendError(response, 401, 'The username, password, or account type is not recognised.');
      return;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const timestamp = nowIso();
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.createHash('sha256').update(token).digest('hex'), row.id, Date.now() + sessionTtlMs, timestamp, timestamp);
    db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, row.id);
    audit(row.id, 'login', 'user', row.id, { role });
    sendJson(response, 200, { user: publicUser({ ...row, last_login_at: timestamp }) }, { 'Set-Cookie': sessionCookie(token) });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    const token = parseCookies(request).mama_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(crypto.createHash('sha256').update(token).digest('hex'));
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/setup') {
    if (getAdminCount()) {
      sendError(response, 409, 'An administrator account already exists.');
      return;
    }
    let body;
    try { body = await readJson(request); } catch (error) { sendError(response, 400, error.message); return; }
    const username = normalizeUsername(body.username);
    if (!validUsername(username) || String(body.password || '').length < 10) {
      sendError(response, 400, 'Use a valid username and a password with at least 10 characters.');
      return;
    }
    const timestamp = nowIso();
    const userId = id('usr_');
    db.prepare(`INSERT INTO users (id, role, username, password_hash, status, privacy_consent, created_at, updated_at) VALUES (?, 'admin', ?, ?, 'Active', 1, ?, ?)`)
      .run(userId, username, hashPassword(body.password), timestamp, timestamp);
    audit(userId, 'setup_admin', 'user', userId);
    sendJson(response, 201, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) });
    return;
  }

  const user = requireUser(request, response);
  if (!user) return;

  if (request.method === 'PATCH' && pathname === '/api/account') {
    let body;
    try { body = await readJson(request); } catch (error) { sendError(response, 400, error.message); return; }
    const language = String(body.language || user.language || 'en').slice(0, 8);
    const privacyConsent = body.privacyConsent === undefined ? user.privacyConsent : Boolean(body.privacyConsent);
    db.prepare('UPDATE users SET language = ?, privacy_consent = ?, updated_at = ? WHERE id = ?').run(language, privacyConsent ? 1 : 0, nowIso(), user.id);
    audit(user.id, 'account_preferences_update', 'user', user.id, { language, privacyConsent });
    sendJson(response, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/state') {
    sendJson(response, 200, { user, state: stateForUser(user) });
    return;
  }

  if (request.method === 'PUT' && pathname === '/api/accounts/sync') {
    let body;
    try { body = await readJson(request); } catch (error) { sendError(response, 400, error.message); return; }
    try {
      sendJson(response, 200, { state: syncAccounts(body.records, user) });
    } catch (error) {
      sendError(response, 400, error.message);
    }
    return;
  }

  if (request.method === 'PUT' && pathname.startsWith('/api/collections/')) {
    const type = pathname.slice('/api/collections/'.length);
    let body;
    try { body = await readJson(request); } catch (error) { sendError(response, 400, error.message); return; }
    try {
      const state = syncCollection(type, body.records, user);
      sendJson(response, 200, { state });
    } catch (error) {
      sendError(response, 400, error.message);
    }
    return;
  }

  if (request.method === 'PUT' && pathname === '/api/gps/batch') {
    if (user.role !== 'admin') {
      sendError(response, 403, 'Only administrators can batch GPS locations.');
      return;
    }
    let body;
    try { body = await readJson(request); } catch (error) { sendError(response, 400, error.message); return; }
    const locations = Array.isArray(body.locations) ? body.locations.slice(0, 1000) : [];
    const timestamp = nowIso();
    db.exec('BEGIN');
    try {
      for (const location of locations) {
        const taxiId = String(location.taxiId || '');
        const latitude = Number(location.lat);
        const longitude = Number(location.lon ?? location.lng);
        if (!taxiId || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
        db.prepare('INSERT INTO gps_locations (taxi_id, driver_id, latitude, longitude, accuracy, source, consent_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(taxiId, String(location.driverId || ''), latitude, longitude, Number.isFinite(Number(location.accuracy)) ? Number(location.accuracy) : null, String(location.source || 'administrator').slice(0, 80), timestamp, timestamp);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      sendError(response, 400, error.message);
      return;
    }
    audit(user.id, 'gps_batch', 'taxi', '', { count: locations.length });
    sendJson(response, 200, { taxiLocations: latestGpsForUser(user) });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/gps') {
    let body;
    try { body = await readJson(request); } catch (error) { sendError(response, 400, error.message); return; }
    const latitude = Number(body.lat);
    const longitude = Number(body.lon ?? body.lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      sendError(response, 400, 'A valid latitude and longitude are required.');
      return;
    }
    if (user.role === 'driver' && body.consent !== true) {
      sendError(response, 403, 'Driver location consent is required.');
      return;
    }
    const taxiId = user.role === 'admin' ? String(body.taxiId || '') : String(assignedTaxiForUser(user) ? safeJson(assignedTaxiForUser(user).data).id : '');
    if (!taxiId) {
      sendError(response, 400, 'An assigned taxi is required.');
      return;
    }
    const timestamp = nowIso();
    db.prepare('INSERT INTO gps_locations (taxi_id, driver_id, latitude, longitude, accuracy, source, consent_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(taxiId, user.role === 'driver' ? user.driverId : String(body.driverId || ''), latitude, longitude, Number.isFinite(Number(body.accuracy)) ? Number(body.accuracy) : null, String(body.source || 'driver-portal').slice(0, 80), timestamp, timestamp);
    audit(user.id, 'gps_report', 'taxi', taxiId, { consent: true });
    sendJson(response, 201, { ok: true, taxiLocations: latestGpsForUser(user) });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/documents') {
    let body;
    try { body = await readJson(request); } catch (error) { sendError(response, 400, error.message); return; }
    const driverId = user.role === 'admin' ? String(body.driverId || '') : user.driverId;
    if (!driverId || !db.prepare('SELECT id FROM drivers WHERE id = ?').get(driverId)) {
      sendError(response, 400, 'A valid driver is required.');
      return;
    }
    let content = Buffer.alloc(0);
    if (body.contentBase64) {
      try { content = Buffer.from(String(body.contentBase64), 'base64'); } catch { content = Buffer.alloc(0); }
      if (content.length > maxDocumentBytes) {
        sendError(response, 413, 'The document is too large.');
        return;
      }
    }
    const mimeType = String(body.mimeType || 'application/octet-stream').toLowerCase();
    const allowedMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain']);
    if (content.length && !allowedMimeTypes.has(mimeType)) {
      sendError(response, 415, 'Only PDF, JPG, PNG, WEBP, and text documents are supported.');
      return;
    }
    const encrypted = encryptContent(content);
    const documentId = String(body.id || id('doc_'));
    const timestamp = nowIso();
    db.prepare(`INSERT INTO documents (id, driver_id, taxi_id, document_type, document_number, authority, expiry, status, reference, file_name, mime_type, byte_size, content, content_iv, content_tag, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET driver_id=excluded.driver_id, taxi_id=excluded.taxi_id, document_type=excluded.document_type, document_number=excluded.document_number, authority=excluded.authority, expiry=excluded.expiry, status=excluded.status, reference=excluded.reference, file_name=excluded.file_name, mime_type=excluded.mime_type, byte_size=excluded.byte_size, content=excluded.content, content_iv=excluded.content_iv, content_tag=excluded.content_tag, updated_at=excluded.updated_at`)
      .run(documentId, driverId, String(body.taxiId || ''), String(body.type || ''), String(body.number || ''), String(body.authority || ''), String(body.expiry || ''), String(body.status || 'Pending'), String(body.reference || ''), String(body.fileName || ''), String(body.mimeType || ''), content.length, encrypted.content, encrypted.iv, encrypted.tag, timestamp, timestamp);
    audit(user.id, 'document_save', 'document', documentId, { driverId, byteSize: content.length });
    sendJson(response, 201, { document: documentsForUser(user).find(document => document.id === documentId) });
    return;
  }

  const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)\/download$/);
  if (request.method === 'GET' && documentMatch) {
    const row = getDocumentForUser(decodeURIComponent(documentMatch[1]), user);
    if (!row) {
      sendError(response, 404, 'Document not found.');
      return;
    }
    const content = decryptContent(row);
    audit(user.id, 'document_download', 'document', row.id, { driverId: row.driver_id });
    response.writeHead(200, {
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Length': content.length,
      'Content-Disposition': `attachment; filename="${String(row.file_name || 'document').replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(content);
    return;
  }

  if (request.method === 'GET' && pathname === '/api/audit' && user.role === 'admin') {
    sendJson(response, 200, { audit: db.prepare('SELECT id, user_id AS userId, action, entity_type AS entityType, entity_id AS entityId, details, created_at AS createdAt FROM audit_logs ORDER BY id DESC LIMIT 500').all().map(row => ({ ...row, details: safeJson(row.details) })) });
    return;
  }

  sendError(response, 404, 'API route not found.');
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function serveStatic(request, response, pathname) {
  let requested = pathname === '/' ? '/index.html' : pathname;
  try { requested = decodeURIComponent(requested); } catch { requested = '/index.html'; }
  const filePath = path.resolve(staticRoot, `.${requested}`);
  if (!filePath.startsWith(staticRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const fallback = path.join(staticRoot, 'index.html');
    if (!fs.existsSync(fallback)) {
      sendError(response, 404, 'Not found.');
      return;
    }
    response.writeHead(200, { 'Content-Type': contentTypes['.html'], 'Cache-Control': 'no-store' });
    fs.createReadStream(fallback).pipe(response);
    return;
  }
  response.writeHead(200, {
    'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(filePath).pipe(response);
}

const authAttempts = new Map();
function authRateLimited(request) {
  const key = String(request.socket.remoteAddress || 'unknown');
  const now = Date.now();
  const recent = (authAttempts.get(key) || []).filter(time => now - time < 15 * 60 * 1000);
  if (recent.length >= 20) return true;
  recent.push(now);
  authAttempts.set(key, recent);
  return false;
}

const server = http.createServer(async (request, response) => {
  const requestOrigin = String(request.headers.origin || '').replace(/\/$/, '');
  if (allowedOrigin) response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  else if (requestOrigin) response.setHeader('Access-Control-Allow-Origin', requestOrigin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Vary', 'Origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' });
    response.end();
    return;
  }
  try {
    if (String(request.url || '').startsWith('/api/auth/login') && authRateLimited(request)) {
      sendError(response, 429, 'Too many login attempts. Try again later.');
      return;
    }
    const pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
    if (!pathname.startsWith('/api/')) {
      serveStatic(request, response, pathname);
      return;
    }
    await handleRequest(request, response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendError(response, 500, 'Unexpected server error.');
    else response.end();
  }
});

server.listen(port, host, () => {
  console.log(`Mama Africa API listening on ${host}:${port}; database: ${databasePath}`);
});

function shutdown() {
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
