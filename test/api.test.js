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
      // The child is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('API did not start in time.');
}

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json();
  return { response, body };
}

test('shared API enforces roles, consent, and encrypted document storage', async t => {
  const port = await freePort();
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mama-africa-api-'));
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
  const staticPage = await fetch(apiUrl);
  assert.equal(staticPage.status, 200);
  assert.match(await staticPage.text(), /MAMA AFRICA/);

  const adminLogin = await jsonRequest(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'mamaafrica', role: 'admin' })
  });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = cookieFrom(adminLogin.response);
  assert.ok(adminCookie);

  const taxiSync = await jsonRequest(`${apiUrl}/api/collections/taxis`, {
    method: 'PUT',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ records: [{ id: 'taxi-1', plate: 'UA001AA', make: 'Toyota', model: 'Hiace', year: 2020, color: 'White', status: 'Active' }] })
  });
  assert.equal(taxiSync.response.status, 200);
  const driverSync = await jsonRequest(`${apiUrl}/api/collections/drivers`, {
    method: 'PUT',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ records: [{ id: 'driver-1', name: 'Driver One', phone: '0758387804', license: 'DL1', status: 'Active', residence: 'Kampala', nin: '12345678901234', dob: '1990-01-01', nationality: 'Ugandan', taxiId: 'taxi-1', truckPlate: 'UA001AA' }] })
  });
  assert.equal(driverSync.response.status, 200);
  const accountSync = await jsonRequest(`${apiUrl}/api/accounts/sync`, {
    method: 'PUT',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ records: [{ id: 'account-1', role: 'driver', username: 'driver.one', password: 'driver-password-123', driverId: 'driver-1', status: 'Active' }] })
  });
  assert.equal(accountSync.response.status, 200);

  const driverLogin = await jsonRequest(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ username: 'driver.one', password: 'driver-password-123', role: 'driver' })
  });
  assert.equal(driverLogin.response.status, 200);
  const driverCookie = cookieFrom(driverLogin.response);
  const driverState = await jsonRequest(`${apiUrl}/api/state`, { headers: { Cookie: driverCookie } });
  assert.equal(driverState.response.status, 200);
  assert.equal(driverState.body.state.drivers.length, 1);
  assert.equal(driverState.body.state.drivers[0].id, 'driver-1');

  const noConsent = await jsonRequest(`${apiUrl}/api/gps`, {
    method: 'POST',
    headers: { Cookie: driverCookie },
    body: JSON.stringify({ lat: 0.3476, lon: 32.5825 })
  });
  assert.equal(noConsent.response.status, 403);
  const consentGps = await jsonRequest(`${apiUrl}/api/gps`, {
    method: 'POST',
    headers: { Cookie: driverCookie },
    body: JSON.stringify({ lat: 0.3476, lon: 32.5825, consent: true })
  });
  assert.equal(consentGps.response.status, 201);

  const upload = await jsonRequest(`${apiUrl}/api/documents`, {
    method: 'POST',
    headers: { Cookie: driverCookie },
    body: JSON.stringify({ driverId: 'driver-1', type: 'Driving licence', number: 'DL1', fileName: 'licence.txt', mimeType: 'text/plain', contentBase64: Buffer.from('licence-content').toString('base64') })
  });
  assert.equal(upload.response.status, 201);
  const documentId = upload.body.document.id;
  const download = await fetch(`${apiUrl}/api/documents/${encodeURIComponent(documentId)}/download`, { headers: { Cookie: driverCookie } });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'licence-content');
});
