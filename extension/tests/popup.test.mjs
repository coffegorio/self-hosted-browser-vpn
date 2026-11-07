import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
const active = { state: 'active', hasConnection: true, enabled: true, exclusions: [], expectedIp: '203.0.113.9' };
const verifiedIp = { ip: '203.0.113.9', matched: true };

function event() {
  let listener;
  return {
    addListener(callback) { listener = callback; },
    emit(value) { listener(value); }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function loadPopup(initial = active) {
  const elements = new Map();
  function get(id) {
    if (!elements.has(id)) {
      const click = event();
      elements.set(id, {
        click, textContent: '', parentElement: { dataset: {} },
        addEventListener(type, listener) { if (type === 'click') click.addListener(listener); }
      });
    }
    return elements.get(id);
  }
  const proxyChanged = event();
  const rtcChanged = event();
  const storageChanged = event();
  const popup = { get, proxyChanged, rtcChanged, storageChanged, status: async () => initial, verify: async () => verifiedIp };
  vm.runInNewContext(source, {
    document: {
      getElementById: get,
      querySelectorAll: () => [get('connect-button'), get('test-button')]
    },
    chrome: {
      runtime: { async sendMessage({ type }) {
        assert.ok(['GET_STATE', 'TEST_IP'].includes(type));
        return { ok: true, result: await (type === 'GET_STATE' ? popup.status() : popup.verify()) };
      } },
      proxy: { settings: { onChange: proxyChanged }, onProxyError: event() },
      privacy: { network: { webRTCIPHandlingPolicy: { onChange: rtcChanged } } },
      storage: { local: { onChanged: storageChanged } }
    }
  });
  await settle();
  return popup;
}

test('an open popup clears verified IP and keeps the latest state after takeover', async () => {
  const popup = await loadPopup();
  popup.get('test-button').click.emit();
  await settle();
  assert.match(popup.get('ip-result').textContent, /IP совпадает/);

  const oldRead = deferred();
  popup.status = () => oldRead.promise;
  popup.rtcChanged.emit();
  popup.status = async () => ({ ...active, state: 'conflict' });
  popup.proxyChanged.emit();
  assert.equal(popup.get('ip-result').textContent, '');
  await settle();
  assert.equal(popup.get('status-title').textContent, 'Конфликт настроек');
  assert.equal(popup.get('test-button').disabled, true);

  oldRead.resolve(active);
  await settle();
  assert.equal(popup.get('status-title').textContent, 'Конфликт настроек');
});

test('a configuration change prevents an in-flight IP result from being shown', async () => {
  const popup = await loadPopup();
  const pending = deferred();
  popup.verify = () => pending.promise;
  popup.get('test-button').click.emit();
  popup.status = async () => ({ ...active, exclusions: ['site.test'] });
  popup.storageChanged.emit({ exclusions: { oldValue: [], newValue: ['site.test'] } });
  await settle();
  assert.equal(popup.get('test-button').disabled, true);

  pending.resolve(verifiedIp);
  await settle();
  assert.equal(popup.get('test-button').disabled, false);
  assert.equal(popup.get('ip-result').textContent, '');
});

test('clearing a proxy error during a successful retry preserves the new result', async () => {
  const popup = await loadPopup({ ...active, state: 'error', canRetryIp: true });
  popup.verify = async () => {
    popup.status = async () => active;
    popup.storageChanged.emit({ proxyError: { oldValue: { code: 'AUTH_FAILED' }, newValue: null } });
    return verifiedIp;
  };
  popup.get('test-button').click.emit();
  await settle();
  assert.match(popup.get('ip-result').textContent, /IP совпадает/);
  assert.equal(popup.get('status-title').textContent, 'Маршрутизация включена');
});
