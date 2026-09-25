import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProxyConfig } from '../core.mjs';

const connection = {
  v: 1,
  host: 'proxy.example.test',
  port: 8443,
  username: 'client',
  password: 'secret'
};
const expected = buildProxyConfig(connection);
const challenge = {
  isProxy: true,
  statusCode: 407,
  scheme: 'Basic',
  challenger: { host: connection.host, port: connection.port }
};

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(details) { for (const listener of listeners) listener(details); },
    get listener() { return listeners[0]; }
  };
}

let loadNumber = 0;
async function loadBackground(options = {}) {
  const state = {
    data: { connection, enabled: true, exclusions: [], proxyError: null, ...options.data },
    proxyOwner: options.proxyOwner || 'controlled_by_this_extension',
    proxyValue: options.proxyValue === undefined ? expected : options.proxyValue,
    ownProxyPreference: (options.proxyOwner || 'controlled_by_this_extension') === 'controlled_by_this_extension',
    incognitoProxyOwner: options.incognitoProxyOwner ?? null,
    incognitoProxyValue: options.incognitoProxyValue ?? null,
    rtcOwner: options.rtcOwner || 'controlled_by_this_extension',
    rtcValue: options.rtcValue || 'disable_non_proxied_udp',
    incognitoRtcOwner: options.incognitoRtcOwner ?? null,
    incognitoRtcValue: options.incognitoRtcValue ?? null,
    incognitoAllowed: options.incognitoAllowed || false,
    tabIncognito: false,
    proxySetCount: 0,
    proxyClearCount: 0,
    badge: '',
    fetchCount: 0,
    fetchResponse: async () => ({ ok: true, json: async () => ({ ip: '203.0.113.9' }) })
  };
  const onMessage = event();
  const onAuthRequired = event();
  const onProxyError = event();
  const onProxyChange = event();
  const onRtcChange = event();
  const onCompleted = event();
  const onErrorOccurred = event();
  const chrome = {
    runtime: { id: 'test-extension', getURL: (path) => `chrome-extension://test-extension/${path}`, onMessage },
    extension: { inIncognitoContext: false, async isAllowedIncognitoAccess() { return state.incognitoAllowed; } },
    tabs: { async get() { return { incognito: state.tabIncognito }; } },
    storage: { local: {
      async get(keys) { return Object.fromEntries(keys.map((key) => [key, state.data[key]])); },
      async set(value) { Object.assign(state.data, value); },
      async remove(keys) { for (const key of keys) delete state.data[key]; },
      async setAccessLevel() {}
    } },
    proxy: {
      settings: {
        onChange: onProxyChange,
        async get({ incognito }) {
          if (state.proxyGetGate) {
            const gate = state.proxyGetGate;
            state.proxyGetGate = null;
            gate.entered();
            await gate.wait;
          }
          return incognito && state.incognitoProxyOwner !== null
            ? { levelOfControl: state.incognitoProxyOwner, value: state.incognitoProxyValue }
            : { levelOfControl: state.proxyOwner, value: state.proxyValue };
        },
        async set({ value }) {
          state.proxySetCount++;
          state.ownProxyPreference = true;
          state.proxyOwner = 'controlled_by_this_extension';
          state.proxyValue = value;
          if (state.proxySetHook) state.proxySetHook();
          if (options.emitChanges) onProxyChange.emit({ levelOfControl: state.proxyOwner });
        },
        async clear() {
          state.proxyClearCount++;
          state.ownProxyPreference = false;
          if (state.proxyOwner === 'controlled_by_this_extension') {
            state.proxyOwner = 'controllable_by_this_extension';
            state.proxyValue = null;
            if (options.emitChanges) onProxyChange.emit({ levelOfControl: state.proxyOwner });
          }
        }
      },
      onProxyError
    },
    privacy: { network: { webRTCIPHandlingPolicy: {
      onChange: onRtcChange,
      async get({ incognito }) {
        return incognito && state.incognitoRtcOwner !== null
          ? { levelOfControl: state.incognitoRtcOwner, value: state.incognitoRtcValue }
          : { levelOfControl: state.rtcOwner, value: state.rtcValue };
      },
      async set({ value }) {
        if (options.rtcSetNoop) return;
        state.rtcOwner = 'controlled_by_this_extension';
        state.rtcValue = value;
        if (options.emitChanges) onRtcChange.emit({ levelOfControl: state.rtcOwner });
      },
      async clear() {
        if (state.rtcOwner === 'controlled_by_this_extension') {
          state.rtcOwner = 'controllable_by_this_extension';
          state.rtcValue = 'default';
          if (options.emitChanges) onRtcChange.emit({ levelOfControl: state.rtcOwner });
        }
      }
    } } },
    action: {
      async setBadgeText({ text }) { state.badge = text; },
      async setBadgeBackgroundColor() {}
    },
    webRequest: { onAuthRequired, onCompleted, onErrorOccurred }
  };
  globalThis.chrome = chrome;
  globalThis.fetch = async (...args) => {
    state.fetchCount++;
    return state.fetchResponse(...args);
  };
  await import(`../background.js?test=${++loadNumber}`);
  async function message(type, fields = {}) {
    return new Promise((resolve) => {
      onMessage.listener({ type, ...fields }, { id: chrome.runtime.id }, resolve);
    });
  }
  async function auth(requestId, overrides = {}) {
    return new Promise((resolve) => {
      onAuthRequired.listener({ ...challenge, requestId, tabId: 1, ...overrides }, resolve);
    });
  }
  async function settle() {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }
  return { state, message, auth, settle, onProxyError, onProxyChange, onRtcChange };
}

test('startup clears a saved PAC when WebRTC cannot be restricted', async () => {
  const h = await loadBackground({ rtcOwner: 'controlled_by_other_extensions', rtcValue: 'default' });
  const response = await h.message('GET_STATE');
  assert.equal(response.ok, true);
  assert.equal(response.result.state, 'error');
  assert.ok(h.state.proxyClearCount >= 1);
  assert.equal(h.state.proxySetCount, 0);
  assert.equal(h.state.proxyOwner, 'controllable_by_this_extension');
  assert.equal(h.state.badge, '!');
});

test('startup verifies that Chrome actually applied the WebRTC restriction', async () => {
  const h = await loadBackground({ rtcOwner: 'controllable_by_this_extension', rtcValue: 'default', rtcSetNoop: true });
  assert.equal((await h.message('GET_STATE')).result.state, 'error');
  assert.equal(h.state.proxySetCount, 0);
  assert.equal(h.state.proxyOwner, 'controllable_by_this_extension');
});

test('setting change events raised by startup wait for boot before reconciliation', async () => {
  const h = await loadBackground({
    incognitoAllowed: true,
    rtcOwner: 'controllable_by_this_extension',
    rtcValue: 'default',
    emitChanges: true
  });
  await h.settle();
  assert.equal((await h.message('GET_STATE')).result.state, 'active');
  assert.equal(h.state.proxySetCount, 1);
  assert.equal(h.state.badge, 'ON');
});

test('loss and recovery of WebRTC control removes and reapplies the PAC', async () => {
  const h = await loadBackground();
  assert.equal((await h.message('GET_STATE')).result.state, 'active');
  h.state.rtcOwner = 'controlled_by_other_extensions';
  h.state.rtcValue = 'default';
  h.onRtcChange.emit({ value: 'default' });
  await h.settle();
  assert.equal(h.state.proxyOwner, 'controllable_by_this_extension');
  assert.equal((await h.message('GET_STATE')).result.state, 'error');
  assert.equal(h.state.badge, '!');
  h.state.rtcOwner = 'controllable_by_this_extension';
  h.onRtcChange.emit({ value: 'default' });
  await h.settle();
  assert.equal(h.state.rtcValue, 'disable_non_proxied_udp');
  assert.equal(h.state.proxySetCount, 1);
  assert.equal((await h.message('GET_STATE')).result.state, 'active');
});

test('incognito WebRTC override disables the shared PAC until control returns', async () => {
  const h = await loadBackground({ incognitoAllowed: true });
  assert.equal((await h.message('GET_STATE')).result.state, 'active');
  h.state.incognitoRtcOwner = 'controlled_by_other_extensions';
  h.state.incognitoRtcValue = 'default';
  h.onRtcChange.emit({ incognitoSpecific: true });
  await h.settle();
  assert.equal(h.state.proxyOwner, 'controllable_by_this_extension');
  assert.equal((await h.message('GET_STATE')).result.state, 'error');
  h.state.incognitoRtcOwner = 'controlled_by_this_extension';
  h.state.incognitoRtcValue = 'disable_non_proxied_udp';
  h.onRtcChange.emit({ incognitoSpecific: true });
  await h.settle();
  assert.equal((await h.message('GET_STATE')).result.state, 'active');
});

test('startup does not apply the regular PAC when incognito has a direct override', async () => {
  const h = await loadBackground({
    incognitoAllowed: true,
    incognitoProxyOwner: 'controlled_by_other_extensions',
    incognitoProxyValue: { mode: 'direct' }
  });
  const current = (await h.message('GET_STATE')).result;
  assert.equal(current.state, 'conflict');
  assert.match(current.message, /инкогнито/);
  assert.equal(h.state.proxyOwner, 'controllable_by_this_extension');
  assert.equal(h.state.proxySetCount, 0);
  assert.equal(h.state.badge, '!');
});

test('incognito-only proxy takeover clears the regular PAC and removes ON', async () => {
  const h = await loadBackground({ incognitoAllowed: true });
  assert.equal((await h.message('GET_STATE')).result.state, 'active');
  h.state.incognitoProxyOwner = 'controlled_by_other_extensions';
  h.state.incognitoProxyValue = { mode: 'direct' };
  h.onProxyChange.emit({ incognitoSpecific: true });
  await h.settle();
  assert.equal(h.state.proxyOwner, 'controllable_by_this_extension');
  assert.equal((await h.message('GET_STATE')).result.state, 'conflict');
  assert.equal(h.state.badge, '!');
  h.state.tabIncognito = true;
  assert.deepEqual(await h.auth('incognito-direct'), { cancel: true });
  h.state.incognitoProxyOwner = null;
  h.state.incognitoProxyValue = null;
  h.onProxyChange.emit({ incognitoSpecific: true });
  await h.settle();
  assert.equal((await h.message('GET_STATE')).result.state, 'active');
  assert.equal(h.state.badge, 'ON');
});

test('connect refuses an incognito-only direct override', async () => {
  const h = await loadBackground({
    data: { enabled: false },
    incognitoAllowed: true,
    incognitoProxyOwner: 'controlled_by_other_extensions',
    incognitoProxyValue: { mode: 'direct' }
  });
  assert.equal((await h.message('CONNECT')).ok, false);
  assert.equal(h.state.proxySetCount, 0);
  assert.notEqual(h.state.proxyOwner, 'controlled_by_this_extension');
});

test('incognito PAC mismatch under this extension clears regular PAC without a reapply loop', async () => {
  const h = await loadBackground({ incognitoAllowed: true });
  assert.equal((await h.message('GET_STATE')).result.state, 'active');
  h.state.incognitoProxyOwner = 'controlled_by_this_extension';
  h.state.incognitoProxyValue = { mode: 'direct' };
  h.onProxyChange.emit({ incognitoSpecific: true });
  await h.settle();
  assert.equal(h.state.proxyOwner, 'controllable_by_this_extension');
  assert.equal(h.state.badge, '!');
  h.onProxyChange.emit({ incognitoSpecific: false });
  await h.settle();
  assert.equal(h.state.proxySetCount, 0);
  assert.equal(h.state.proxyOwner, 'controllable_by_this_extension');
});

test('simultaneous regular and incognito takeover clears the dormant own PAC', async () => {
  const h = await loadBackground({ incognitoAllowed: true });
  assert.equal((await h.message('GET_STATE')).result.state, 'active');
  h.state.proxyOwner = 'controlled_by_other_extensions';
  h.state.proxyValue = { mode: 'direct' };
  h.state.incognitoProxyOwner = 'controlled_by_other_extensions';
  h.state.incognitoProxyValue = { mode: 'direct' };
  h.onProxyChange.emit({ incognitoSpecific: true });
  await h.settle();
  assert.equal(h.state.ownProxyPreference, false);
  assert.equal(h.state.badge, '!');
  const clears = h.state.proxyClearCount;
  h.onProxyChange.emit({ incognitoSpecific: false });
  await h.settle();
  assert.equal(h.state.proxyClearCount, clears);
  h.state.proxyOwner = 'controllable_by_this_extension';
  h.state.proxyValue = null;
  h.state.incognitoProxyOwner = null;
  h.state.incognitoProxyValue = null;
  h.onProxyChange.emit({ incognitoSpecific: true });
  await h.settle();
  assert.equal(h.state.ownProxyPreference, true);
  assert.equal((await h.message('GET_STATE')).result.state, 'active');
});

test('proxy authorization requires the effective expected PAC and WebRTC policy', async () => {
  const h = await loadBackground();
  assert.deepEqual(await h.auth('valid'), {
    authCredentials: { username: connection.username, password: connection.password }
  });
  h.state.proxyOwner = 'controlled_by_other_extensions';
  assert.deepEqual(await h.auth('stolen-control'), { cancel: true });
  h.state.proxyOwner = 'controlled_by_this_extension';
  h.state.proxyValue = { ...expected, pacScript: { ...expected.pacScript, mandatory: false } };
  assert.deepEqual(await h.auth('wrong-pac'), { cancel: true });
  h.state.proxyValue = expected;
  h.state.rtcOwner = 'controlled_by_other_extensions';
  assert.deepEqual(await h.auth('wrong-rtc'), { cancel: true });
  h.state.rtcOwner = 'controlled_by_this_extension';
  h.state.tabIncognito = true;
  h.state.incognitoProxyOwner = 'controlled_by_other_extensions';
  assert.deepEqual(await h.auth('incognito-override'), { cancel: true });
  assert.deepEqual(await h.auth('unknown-tabless', { tabId: -1, initiator: 'https://other.test' }), { cancel: true });
  h.state.tabIncognito = false;
  assert.deepEqual(await h.auth('own-worker', { tabId: -1, initiator: 'chrome-extension://test-extension' }), {
    authCredentials: { username: connection.username, password: connection.password }
  });
});

test('proxy authorization does not race a disconnect', async () => {
  const h = await loadBackground();
  await h.message('GET_STATE');
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  h.state.proxyGetGate = { entered, wait };
  const authorization = h.auth('racing');
  await enteredPromise;
  const disconnect = h.message('DISCONNECT');
  await h.settle();
  release();
  assert.deepEqual(await authorization, { cancel: true });
  assert.equal((await disconnect).ok, true);
});

test('proxy authorization cancels when Chrome settings change during the lookup', async () => {
  const h = await loadBackground();
  await h.message('GET_STATE');
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  h.state.proxyGetGate = { entered, wait };
  const authorization = h.auth('setting-race');
  await enteredPromise;
  h.state.proxyOwner = 'controlled_by_other_extensions';
  h.onProxyChange.emit({ levelOfControl: h.state.proxyOwner });
  release();
  assert.deepEqual(await authorization, { cancel: true });
});

test('fatal proxy error can be cleared only by a successful IP retry', async () => {
  const h = await loadBackground();
  await h.message('GET_STATE');
  h.onProxyError.emit({ fatal: true, error: 'ERR_PROXY_CONNECTION_FAILED' });
  await h.settle();
  const before = (await h.message('GET_STATE')).result;
  assert.equal(before.state, 'error');
  assert.equal(before.canRetryIp, true);
  assert.equal(h.state.badge, '!');
  assert.deepEqual(await h.message('TEST_IP'), { ok: true, result: { ip: '203.0.113.9' } });
  assert.equal((await h.message('GET_STATE')).result.state, 'active');
  assert.equal(h.state.badge, 'ON');
});

test('saving exclusions does not dismiss an unresolved proxy error', async () => {
  const h = await loadBackground();
  await h.message('GET_STATE');
  h.onProxyError.emit({ fatal: true, error: 'ERR_PROXY_CONNECTION_FAILED' });
  await h.settle();
  assert.equal((await h.message('SAVE_EXCLUSIONS', { text: 'example.org' })).ok, true);
  assert.equal((await h.message('GET_STATE')).result.state, 'error');
  assert.equal(h.state.badge, '!');
});

test('exclusion rollback does not restore a PAC after WebRTC control is lost', async () => {
  const h = await loadBackground();
  await h.message('GET_STATE');
  h.state.proxySetHook = () => { h.state.rtcOwner = 'controlled_by_other_extensions'; };
  const result = await h.message('SAVE_EXCLUSIONS', { text: 'example.org' });
  assert.equal(result.ok, false);
  assert.deepEqual(h.state.data.exclusions, []);
  assert.equal(h.state.proxySetCount, 1);
  assert.equal(h.state.proxyOwner, 'controllable_by_this_extension');
});

test('exclusion rollback does not restore a PAC after incognito proxy takeover', async () => {
  const h = await loadBackground({ incognitoAllowed: true });
  await h.message('GET_STATE');
  h.state.proxySetHook = () => {
    h.state.incognitoProxyOwner = 'controlled_by_other_extensions';
    h.state.incognitoProxyValue = { mode: 'direct' };
  };
  assert.equal((await h.message('SAVE_EXCLUSIONS', { text: 'example.org' })).ok, false);
  assert.deepEqual(h.state.data.exclusions, []);
  assert.equal(h.state.proxySetCount, 1);
  assert.equal(h.state.proxyOwner, 'controllable_by_this_extension');
  assert.equal((await h.message('GET_STATE')).result.state, 'conflict');
  assert.equal(h.state.badge, '!');
});

test('exclusion rollback verifies the restored incognito PAC', async () => {
  const h = await loadBackground({ incognitoAllowed: true });
  await h.message('GET_STATE');
  h.state.proxySetHook = () => {
    h.state.incognitoProxyOwner = 'controlled_by_this_extension';
    h.state.incognitoProxyValue = { mode: 'direct' };
  };
  assert.equal((await h.message('SAVE_EXCLUSIONS', { text: 'example.org' })).ok, false);
  assert.deepEqual(h.state.data.exclusions, []);
  assert.equal(h.state.proxySetCount, 2);
  assert.equal(h.state.proxyOwner, 'controllable_by_this_extension');
  assert.equal(h.state.badge, '!');
});

test('retry keeps the error when a new proxy error occurs during the IP request', async () => {
  const h = await loadBackground();
  await h.message('GET_STATE');
  h.onProxyError.emit({ fatal: true, error: 'ERR_PROXY_CONNECTION_FAILED' });
  await h.settle();
  h.state.fetchResponse = async () => {
    h.onProxyError.emit({ fatal: true, error: 'ERR_PROXY_CONNECTION_FAILED' });
    return { ok: true, json: async () => ({ ip: '203.0.113.9' }) };
  };
  assert.equal((await h.message('TEST_IP')).ok, false);
  await h.settle();
  assert.equal((await h.message('GET_STATE')).result.state, 'error');
  assert.equal(h.state.badge, '!');
});

test('nonfatal proxy error cannot be cleared by a potentially direct IP request', async () => {
  const h = await loadBackground();
  await h.message('GET_STATE');
  h.onProxyError.emit({ fatal: false, error: 'ERR_PAC_SCRIPT_FAILED' });
  await h.settle();
  const before = (await h.message('GET_STATE')).result;
  assert.equal(before.canRetryIp, false);
  assert.equal((await h.message('TEST_IP')).ok, false);
  assert.equal(h.state.fetchCount, 0);
  assert.equal(h.state.badge, '!');
});

test('IP checks reject responses after another popup changes the route', async (t) => {
  for (const retry of [false, true]) {
    for (const change of ['server', 'exclusions', 'disconnect and reconnect']) {
      await t.test(`${change}, retry=${retry}`, async () => {
        const h = await loadBackground();
        await h.message('GET_STATE');
        if (retry) {
          h.onProxyError.emit({ fatal: true, error: 'ERR_PROXY_CONNECTION_FAILED' });
          await h.settle();
        }
        let started;
        let release;
        const began = new Promise((resolve) => { started = resolve; });
        const pending = new Promise((resolve) => { release = resolve; });
        h.state.fetchResponse = async () => {
          started();
          await pending;
          return { ok: true, json: async () => ({ ip: '203.0.113.9' }) };
        };
        const check = h.message('TEST_IP');
        await began;
        if (change === 'server') {
          const key = 'shbvpn1:' + Buffer.from(JSON.stringify({ ...connection, host: 'second.example.test' })).toString('base64url');
          assert.equal((await h.message('IMPORT_KEY', { key })).ok, true);
          assert.equal((await h.message('CONNECT')).ok, true);
        } else if (change === 'exclusions') {
          assert.equal((await h.message('SAVE_EXCLUSIONS', { text: 'api.ipify.org' })).ok, true);
        } else {
          assert.equal((await h.message('DISCONNECT')).ok, true);
          assert.equal((await h.message('CONNECT')).ok, true);
        }
        release();
        assert.equal((await check).ok, false);
        if (retry && change === 'exclusions') {
          assert.equal((await h.message('GET_STATE')).result.state, 'error');
        }
      });
    }
  }
});

test('IP check rejects a browser setting change even when the original setting returns', async () => {
  const h = await loadBackground();
  await h.message('GET_STATE');
  h.state.fetchResponse = async () => {
    h.state.proxyOwner = 'controlled_by_other_extensions';
    h.onProxyChange.emit({ levelOfControl: h.state.proxyOwner });
    h.state.proxyOwner = 'controlled_by_this_extension';
    h.onProxyChange.emit({ levelOfControl: h.state.proxyOwner });
    return { ok: true, json: async () => ({ ip: '203.0.113.9' }) };
  };
  assert.equal((await h.message('TEST_IP')).ok, false);
  await h.settle();
  assert.equal((await h.message('GET_STATE')).result.state, 'active');
});

test('IP check rejects a configuration change while its initial status is being read', async () => {
  const h = await loadBackground();
  await h.message('GET_STATE');
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  h.state.proxyGetGate = { entered, wait };
  const check = h.message('TEST_IP');
  await enteredPromise;
  assert.equal((await h.message('DISCONNECT')).ok, true);
  assert.equal((await h.message('CONNECT')).ok, true);
  release();
  assert.equal((await check).ok, false);
  assert.equal(h.state.fetchCount, 0);
});
