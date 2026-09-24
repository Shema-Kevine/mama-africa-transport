const http = require('node:http');

const port = Number(process.env.PORT || 3001);
const googleApiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
const googleEndpoint = process.env.GOOGLE_TRANSLATE_API_URL || 'https://translation.googleapis.com/language/translate/v2';
const allowedOrigin = String(process.env.ALLOWED_ORIGIN || '').trim();
const maxBodyBytes = 256 * 1024;
const maxTexts = 100;

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin' } : {})
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBodyBytes) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      raw += chunk;
    });
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

async function handleTranslation(request, response) {
  if (!googleApiKey) {
    sendJson(response, 503, { error: 'Google Translation is not configured on the server.' });
    return;
  }

  let payload;
  try {
    payload = await readJson(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  const source = payload.source === 'auto' ? 'auto' : 'en';
  const target = String(payload.target || '').trim().toLowerCase();
  const texts = Array.isArray(payload.texts) ? payload.texts : [];
  if (!/^[a-z]{2,8}(?:-[a-z]{2})?$/.test(target)) {
    sendJson(response, 400, { error: 'A valid target language is required.' });
    return;
  }
  if (!texts.length || texts.length > maxTexts || texts.some(text => typeof text !== 'string' || text.length > 4000)) {
    sendJson(response, 400, { error: `Provide between 1 and ${maxTexts} valid text strings.` });
    return;
  }

  const url = new URL(googleEndpoint);
  url.searchParams.set('key', googleApiKey);
  try {
    const googleResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts, source, target, format: 'text' }),
      signal: AbortSignal.timeout(12000)
    });
    const result = await googleResponse.json().catch(() => ({}));
    if (!googleResponse.ok) {
      sendJson(response, 502, { error: 'Google Translation rejected the request.' });
      return;
    }
    const translations = Array.isArray(result?.data?.translations)
      ? result.data.translations.map(item => String(item?.translatedText || ''))
      : [];
    if (translations.length !== texts.length || translations.some(text => !text)) {
      sendJson(response, 502, { error: 'Google Translation returned an incomplete response.' });
      return;
    }
    sendJson(response, 200, { translations });
  } catch {
    sendJson(response, 502, { error: 'Google Translation is temporarily unavailable.' });
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    sendJson(response, 200, { ok: true, configured: Boolean(googleApiKey) });
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' } : {});
    response.end();
    return;
  }
  if (request.method === 'POST' && request.url === '/translate') {
    await handleTranslation(request, response);
    return;
  }
  sendJson(response, 404, { error: 'Not found.' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Translation proxy listening on ${port}; Google API configured: ${Boolean(googleApiKey)}`);
});
