const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`API exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('API did not start in time.');
}

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json();
  return { response, body };
}

// A real 1x1 PNG, so the encrypted round-trip can be checked byte for byte.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

async function bootApi(t) {
  const port = await freePort();
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mama-africa-media-'));
  const apiUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_PATH: path.join(dataDirectory, 'test.sqlite'),
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'mamaafrica',
      DOCUMENT_ENCRYPTION_KEY: 'test-document-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  await waitForServer(apiUrl, child);

  const adminLogin = await jsonRequest(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'mamaafrica', role: 'admin' })
  });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = cookieFrom(adminLogin.response);
  const adminId = adminLogin.body.user.id;

  await jsonRequest(`${apiUrl}/api/collections/taxis`, {
    method: 'PUT',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ records: [{ id: 'taxi-1', plate: 'UA001AA', make: 'Toyota', model: 'Hiace', year: 2020, color: 'White', status: 'Active' }] })
  });
  await jsonRequest(`${apiUrl}/api/collections/drivers`, {
    method: 'PUT',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ records: [
      { id: 'driver-1', name: 'Driver One', phone: '0750000001', status: 'Active', taxiId: 'taxi-1', truckPlate: 'UA001AA' },
      { id: 'driver-2', name: 'Driver Two', phone: '0750000002', status: 'Active', taxiId: 'taxi-1', truckPlate: 'UA001AA' }
    ] })
  });
  await jsonRequest(`${apiUrl}/api/accounts/sync`, {
    method: 'PUT',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ records: [
      { id: 'account-1', role: 'driver', username: 'driver.one', password: 'driver-password-123', driverId: 'driver-1', status: 'Active' },
      { id: 'account-2', role: 'driver', username: 'driver.two', password: 'driver-password-123', driverId: 'driver-2', status: 'Active' }
    ] })
  });

  return { apiUrl, adminCookie, adminId };
}

async function loginDriver(apiUrl, username) {
  const result = await jsonRequest(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ username, password: 'driver-password-123', role: 'driver' })
  });
  assert.equal(result.response.status, 200, `driver ${username} should be able to log in`);
  return cookieFrom(result.response);
}

function uploadMedia(apiUrl, cookie, payload) {
  return jsonRequest(`${apiUrl}/api/media`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ mimeType: 'image/png', contentBase64: PNG_BASE64, ...payload })
  });
}

test('admin uploads identification photos, which are stored encrypted', async t => {
  const { apiUrl, adminCookie, adminId } = await bootApi(t);

  const driverPhoto = await uploadMedia(apiUrl, adminCookie, {
    ownerType: 'driver', ownerId: 'driver-1', kind: 'driver_photo'
  });
  assert.equal(driverPhoto.response.status, 201);
  assert.equal(driverPhoto.body.media.byteSize, PNG_BYTES.length);
  assert.ok(driverPhoto.body.media.url.startsWith('/api/media/'));

  const taxiPhoto = await uploadMedia(apiUrl, adminCookie, {
    ownerType: 'taxi', ownerId: 'taxi-1', kind: 'taxi_photo'
  });
  assert.equal(taxiPhoto.response.status, 201);

  const avatar = await uploadMedia(apiUrl, adminCookie, {
    ownerType: 'user', ownerId: adminId, kind: 'avatar'
  });
  assert.equal(avatar.response.status, 201);

  // The blob must not be readable as plain bytes on disk.
  const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'mama-africa.sqlite'));
  assert.ok(!raw.includes(PNG_BYTES), 'photo bytes should not appear unencrypted in the database file');

  // Downloading returns the exact original bytes.
  const download = await fetch(`${apiUrl}${driverPhoto.body.media.url}`, { headers: { Cookie: adminCookie } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG_BYTES);
});

test('re-uploading the same owner and kind replaces the photo instead of duplicating it', async t => {
  const { apiUrl, adminCookie } = await bootApi(t);

  const first = await uploadMedia(apiUrl, adminCookie, { ownerType: 'driver', ownerId: 'driver-1', kind: 'driver_photo' });
  assert.equal(first.response.status, 201);
  const second = await uploadMedia(apiUrl, adminCookie, { ownerType: 'driver', ownerId: 'driver-1', kind: 'driver_photo' });
  assert.equal(second.response.status, 200, 'second upload should update in place');
  assert.equal(second.body.media.id, first.body.media.id, 'the media id must not change');

  const list = await jsonRequest(`${apiUrl}/api/media`, { headers: { Cookie: adminCookie } });
  const forDriver = list.body.media.filter(item => item.ownerId === 'driver-1');
  assert.equal(forDriver.length, 1, 'there should be exactly one photo for this driver');
});

test('media rejects unsupported types, kinds, owners and empty uploads', async t => {
  const { apiUrl, adminCookie } = await bootApi(t);

  const badMime = await uploadMedia(apiUrl, adminCookie, {
    ownerType: 'driver', ownerId: 'driver-1', kind: 'driver_photo', mimeType: 'application/pdf'
  });
  assert.equal(badMime.response.status, 415);

  const badKind = await uploadMedia(apiUrl, adminCookie, {
    ownerType: 'driver', ownerId: 'driver-1', kind: 'not_a_photo'
  });
  assert.equal(badKind.response.status, 400);

  const badOwnerType = await uploadMedia(apiUrl, adminCookie, {
    ownerType: 'spaceship', ownerId: 'driver-1', kind: 'driver_photo'
  });
  assert.equal(badOwnerType.response.status, 400);

  const missingOwner = await uploadMedia(apiUrl, adminCookie, {
    ownerType: 'driver', ownerId: 'driver-does-not-exist', kind: 'driver_photo'
  });
  assert.equal(missingOwner.response.status, 400);

  const empty = await jsonRequest(`${apiUrl}/api/media`, {
    method: 'POST',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ ownerType: 'driver', ownerId: 'driver-1', kind: 'driver_photo', mimeType: 'image/png' })
  });
  assert.equal(empty.response.status, 400);
});

test('a driver sees only their own photos plus the administrator avatar', async t => {
  const { apiUrl, adminCookie, adminId } = await bootApi(t);

  await uploadMedia(apiUrl, adminCookie, { ownerType: 'driver', ownerId: 'driver-1', kind: 'driver_photo' });
  await uploadMedia(apiUrl, adminCookie, { ownerType: 'driver', ownerId: 'driver-2', kind: 'driver_photo' });
  await uploadMedia(apiUrl, adminCookie, { ownerType: 'taxi', ownerId: 'taxi-1', kind: 'taxi_photo' });
  await uploadMedia(apiUrl, adminCookie, { ownerType: 'user', ownerId: adminId, kind: 'avatar' });

  const cookie = await loginDriver(apiUrl, 'driver.one');
  const list = await jsonRequest(`${apiUrl}/api/media`, { headers: { Cookie: cookie } });
  assert.equal(list.response.status, 200);

  const owners = list.body.media.map(item => `${item.kind}:${item.ownerId}`).sort();
  assert.deepEqual(owners, [
    'driver_photo:driver-1',
    'taxi_photo:taxi-1',
    `avatar:${adminId}`
  ].sort(), 'driver should see their own photo, their taxi photo and the administrator avatar, nothing else');

  // The other driver's photo must be unreachable even with the id in hand.
  const otherPhoto = list.body.media.find(item => item.ownerId === 'driver-1');
  assert.ok(otherPhoto, 'the driver should see their own photo');
  const state = await jsonRequest(`${apiUrl}/api/state`, { headers: { Cookie: adminCookie } });
  assert.equal(state.response.status, 200);
  const otherMedia = state.body.state.media.find(item => item.ownerId === 'driver-2');
  assert.ok(otherMedia, 'admin can list both driver photos');
  const blocked = await fetch(`${apiUrl}${otherMedia.url}`, { headers: { Cookie: cookie } });
  assert.equal(blocked.status, 404, 'another driver photo must not be readable');
});

test('a driver cannot upload or delete photos', async t => {
  const { apiUrl, adminCookie } = await bootApi(t);
  const uploaded = await uploadMedia(apiUrl, adminCookie, { ownerType: 'driver', ownerId: 'driver-1', kind: 'driver_photo' });
  const cookie = await loginDriver(apiUrl, 'driver.one');

  const attempt = await jsonRequest(`${apiUrl}/api/media`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ ownerType: 'driver', ownerId: 'driver-1', kind: 'driver_photo', mimeType: 'image/png', contentBase64: PNG_BASE64 })
  });
  assert.ok(attempt.response.status === 403 || attempt.response.status === 404, 'driver upload must be refused');

  const removal = await fetch(`${apiUrl}${uploaded.body.media.url}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.ok(removal.status === 403 || removal.status === 404, 'driver delete must be refused');

  // And the photo is still there for the administrator.
  const still = await fetch(`${apiUrl}${uploaded.body.media.url}`, { headers: { Cookie: adminCookie } });
  assert.equal(still.status, 200);
});

test('an admin can delete a photo and the driver then sees no photo', async t => {
  const { apiUrl, adminCookie } = await bootApi(t);
  const uploaded = await uploadMedia(apiUrl, adminCookie, { ownerType: 'driver', ownerId: 'driver-1', kind: 'driver_photo' });
  const cookie = await loginDriver(apiUrl, 'driver.one');

  const before = await jsonRequest(`${apiUrl}/api/media`, { headers: { Cookie: cookie } });
  assert.equal(before.body.media.length, 1);

  const removed = await jsonRequest(`${apiUrl}${uploaded.body.media.url}`, { method: 'DELETE', headers: { Cookie: adminCookie } });
  assert.equal(removed.response.status, 200);

  const after = await jsonRequest(`${apiUrl}/api/media`, { headers: { Cookie: cookie } });
  assert.equal(after.body.media.length, 0, 'the deleted photo should be gone');
  assert.ok(uploaded.body.media.url, 'photo had a url');
});
