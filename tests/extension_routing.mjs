import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { buildProxyConfig, parseConnectionKey } from '../extension/core.mjs';

const connection = {
  v: 1,
  host: 'proxy.example.com',
  port: 443,
  username: 'alice',
  password: 'secret'
};

function evaluatePac(config, url, host) {
  const context = vm.createContext({});
  vm.runInContext(config.pacScript.data, context);
  return context.FindProxyForURL(url, host);
}

test('shbvpn1 connection key can be imported', () => {
  const encoded = Buffer.from(JSON.stringify(connection)).toString('base64url');
  assert.deepEqual(parseConnectionKey(`shbvpn1:${encoded}`), connection);
});

test('selected sites have a mandatory HTTPS proxy with no direct fallback', () => {
  const config = buildProxyConfig(connection, ['direct.example.org']);
  assert.equal(config.mode, 'pac_script');
  assert.equal(config.pacScript.mandatory, true);
  for (const host of ['example.com', 'www.example.com', 'almostdirect.example.org']) {
    const result = evaluatePac(config, `https://${host}/`, host);
    assert.equal(result, 'HTTPS proxy.example.com:443');
    assert.doesNotMatch(result, /DIRECT/);
  }
});

test('only an explicit excluded domain and its subdomains go direct', () => {
  const config = buildProxyConfig(connection, ['direct.example.org']);
  for (const host of ['direct.example.org', 'sub.direct.example.org']) {
    assert.equal(evaluatePac(config, `https://${host}/`, host), 'DIRECT');
  }
});
