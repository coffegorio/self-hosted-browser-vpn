import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  buildPacScript,
  buildProxyConfig,
  isExcludedHost,
  isEffectiveProxySetting,
  isMatchingProxyChallenge,
  normalizeExclusions,
  parseConnectionKey
} from '../core.mjs';

const connection = {
  v: 1,
  host: 'proxy.example.test',
  port: 8443,
  username: 'client',
  password: 'a-secret-value'
};

function encodeKey(value) {
  return `shbvpn1:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
}

test('connection key decodes exact server format without exposing credentials in the PAC', () => {
  assert.deepEqual(parseConnectionKey(encodeKey(connection)), connection);
  const pac = buildPacScript(connection);
  assert.ok(!pac.includes(connection.username));
  assert.ok(!pac.includes(connection.password));
});

test('invalid hosts, ports, and secret-control characters are rejected', () => {
  for (const value of [
    { ...connection, host: 'https://proxy.example.test' },
    { ...connection, host: 'proxy.example.test; DIRECT' },
    { ...connection, host: '256.1.1.1' },
    { ...connection, port: 0 },
    { ...connection, port: 65536 },
    { ...connection, username: 'bad:name' },
    { ...connection, password: 'bad\nsecret' },
    { ...connection, v: 2 }
  ]) {
    assert.throws(() => parseConnectionKey(encodeKey(value)));
  }
  assert.throws(() => parseConnectionKey('shbvpn1:%%%'));
});

test('PAC sends all ordinary hosts to one HTTPS proxy and only explicit exclusions direct', () => {
  const script = buildPacScript(connection, ['example.com', '192.0.2.10']);
  const context = vm.createContext({});
  vm.runInContext(script, context);
  const route = (host) => vm.runInContext(`FindProxyForURL('https://${host}/', ${JSON.stringify(host)})`, context);
  assert.equal(route('news.site.test'), 'HTTPS proxy.example.test:8443');
  assert.equal(route('example.com'), 'DIRECT');
  assert.equal(route('sub.example.com'), 'DIRECT');
  assert.equal(route('example.com.evil.test'), 'HTTPS proxy.example.test:8443');
  assert.equal(route('192.0.2.10'), 'DIRECT');
  assert.equal(route('192.0.2.11'), 'HTTPS proxy.example.test:8443');
  assert.equal(buildProxyConfig(connection, ['example.com']).pacScript.mandatory, true);
});

test('exclusions reject URLs and PAC syntax; duplicates normalize', () => {
  assert.deepEqual(normalizeExclusions('Example.COM, *.example.com\nother.test'), ['example.com', 'other.test']);
  assert.equal(isExcludedHost('api.ipify.org', ['ipify.org']), true);
  assert.equal(isExcludedHost('api.ipify.org', ['example.org']), false);
  assert.throws(() => normalizeExclusions('https://example.com'));
  assert.throws(() => normalizeExclusions('example.com;DIRECT'));
});

test('effective-state and auth checks require the expected endpoint and browser control', () => {
  const expected = buildProxyConfig(connection);
  assert.equal(isEffectiveProxySetting({ value: expected, levelOfControl: 'controlled_by_this_extension' }, expected), true);
  assert.equal(isEffectiveProxySetting({ value: expected, levelOfControl: 'controlled_by_other_extensions' }, expected), false);
  assert.equal(isEffectiveProxySetting({ value: { ...expected, pacScript: { ...expected.pacScript, mandatory: false } }, levelOfControl: 'controlled_by_this_extension' }, expected), false);
  const challenge = { isProxy: true, statusCode: 407, scheme: 'Basic', challenger: { host: connection.host, port: connection.port } };
  assert.equal(isMatchingProxyChallenge(challenge, connection), true);
  assert.equal(isMatchingProxyChallenge({ ...challenge, isProxy: false }, connection), false);
  assert.equal(isMatchingProxyChallenge({ ...challenge, challenger: { host: 'other.test', port: connection.port } }, connection), false);
  assert.equal(isMatchingProxyChallenge({ ...challenge, scheme: 'Digest' }, connection), false);
});
