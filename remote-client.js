(function installMamaAfricaRemote(global) {
  'use strict';

  const configuredBase = document.querySelector('meta[name="mama-africa-api"]')?.content || '/api';
  const apiBase = configuredBase.replace(/\/$/, '');
  const state = {
    enabled: false,
    user: null,
    pending: new Map(),
    timers: new Map(),
    pollTimer: null,
    lastError: null
  };

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 15000));
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method: options.method || 'GET',
        credentials: 'include',
        headers,
        body: options.body === undefined ? undefined : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || `API request failed (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async function probe() {
    try {
      const result = await request('/health', { timeoutMs: 2500 });
      if (result.ok === false) {
        state.enabled = false;
        return false;
      }
      state.enabled = true;
      return true;
    } catch {
      state.enabled = false;
      return false;
    }
  }

  async function session() {
    if (!state.enabled) return null;
    try {
      const result = await request('/auth/session');
      state.user = result.user;
      return result;
    } catch (error) {
      if (error.status === 401) {
        state.user = null;
        return null;
      }
      throw error;
    }
  }

  async function login(credentials) {
    const result = await request('/auth/login', { method: 'POST', body: credentials });
    state.user = result.user;
    return result;
  }

  async function logout() {
    try {
      await request('/auth/logout', { method: 'POST', body: {} });
    } finally {
      state.user = null;
      stopPolling();
    }
  }

  function collectionName(key) {
    return {
      taxis: 'taxis',
      drivers: 'drivers',
      trips: 'trips',
      fuelRecords: 'fuelRecords',
      maintenanceRecords: 'maintenanceRecords'
    }[key] || '';
  }

  function recordsForCollection(key, records) {
    if (!state.user || state.user.role !== 'driver') return records;
    if (!['trips', 'fuelRecords', 'maintenanceRecords'].includes(key)) return [];
    return records.filter(record => record && String(record.driverId || '') === String(state.user.driverId || ''));
  }

  async function flushCollection(key) {
    const pending = state.pending.get(key);
    if (!pending || !state.enabled || !state.user) return;
    if (key === 'taxiLocations') {
      state.pending.delete(key);
      const locations = Object.entries(pending.records || {}).map(([taxiId, location]) => ({ taxiId, ...location }));
      if (state.user.role === 'admin' && locations.length) await request('/gps/batch', { method: 'PUT', body: { locations } });
      return;
    }
    if (key === 'userAccounts') {
      if (state.user.role !== 'admin') {
        state.pending.delete(key);
        return;
      }
      state.pending.delete(key);
      await request('/accounts/sync', { method: 'PUT', body: { records: pending.records } });
      return;
    }
    const type = collectionName(key);
    if (!type) {
      state.pending.delete(key);
      return;
    }
    const records = recordsForCollection(key, pending.records);
    if ((type === 'taxis' || type === 'drivers') && state.user.role !== 'admin') {
      state.pending.delete(key);
      return;
    }
    state.pending.delete(key);
    await request(`/collections/${type}`, { method: 'PUT', body: { records } });
  }

  function queueCollection(key, records) {
    if (!state.enabled || !state.user || !Array.isArray(records)) return;
    if (!['taxis', 'drivers', 'trips', 'fuelRecords', 'maintenanceRecords', 'userAccounts', 'taxiLocations'].includes(key)) return;
    state.pending.set(key, { records: records.slice() });
    clearTimeout(state.timers.get(key));
    state.timers.set(key, setTimeout(() => {
      flushCollection(key).catch(error => {
        state.lastError = error;
        state.pending.set(key, { records: records.slice() });
      });
    }, 250));
  }

  async function getState() {
    if (!state.enabled || !state.user) return null;
    const result = await request('/state');
    state.user = result.user;
    return result.state;
  }

  async function syncAccounts(records) {
    if (!state.enabled || !state.user || state.user.role !== 'admin') return null;
    const result = await request('/accounts/sync', { method: 'PUT', body: { records } });
    return result.state;
  }

  async function updateAccount(preferences) {
    if (!state.enabled || !state.user) return null;
    const result = await request('/account', { method: 'PATCH', body: preferences });
    state.user = result.user;
    return result.user;
  }

  async function reportGps(position, consent = true) {
    if (!state.enabled || !state.user) return null;
    return request('/gps', { method: 'POST', body: { ...position, consent } });
  }

  async function uploadDocument(documentData) {
    if (!state.enabled || !state.user) return null;
    return request('/documents', { method: 'POST', body: documentData, timeoutMs: 30000 });
  }

  async function flushPending() {
    for (const key of [...state.pending.keys()]) {
      try { await flushCollection(key); } catch { /* keep the queued snapshot for the next retry */ }
    }
  }

  global.addEventListener('online', () => { void flushPending(); });

  function startPolling(callback, intervalMs = 15000) {
    stopPolling();
    if (!state.enabled || !state.user || typeof callback !== 'function') return;
    state.pollTimer = setInterval(async () => {
      try {
        const remoteState = await getState();
        if (remoteState) await callback(remoteState);
        state.lastError = null;
      } catch (error) {
        state.lastError = error;
      }
    }, intervalMs);
  }

  function stopPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  global.MamaAfricaRemote = {
    apiBase,
    get enabled() { return state.enabled; },
    get user() { return state.user; },
    get lastError() { return state.lastError; },
    probe,
    session,
    login,
    logout,
    getState,
    queueCollection,
    flushPending,
    syncAccounts,
    updateAccount,
    reportGps,
    uploadDocument,
    startPolling,
    stopPolling,
    request
  };
})(window);
