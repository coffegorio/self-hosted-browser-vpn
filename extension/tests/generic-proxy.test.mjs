import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { validateConnection, buildPacScript, isMatchingProxyChallenge } from '../core.mjs';
const profile = {v:2,scheme:'https',host:'proxy.example.com',port:443,username:'',password:''};
for (const [scheme, prefix] of [['http','PROXY'],['https','HTTPS'],['socks5','SOCKS5']]) {
  test(`${scheme}: arbitrary user endpoint routes without DIRECT fallback`, () => {
    const connection = {...profile, scheme};
    assert.equal(validateConnection(connection).scheme, scheme);
    const context = vm.createContext({});
    vm.runInContext(buildPacScript(connection), context);
    assert.equal(context.FindProxyForURL('https://example.org', 'example.org'), `${prefix} proxy.example.com:443`);
  });
}
test('reject unsupported protocols, authenticated SOCKS and partial credentials', () => {
  for (const changes of [{scheme:'direct'},{scheme:'socks5',username:'user',password:'secret'},{username:'user'},{password:'secret'}]) {
    assert.throws(() => validateConnection({...profile,...changes}));
  }
});
test('anonymous proxy never supplies credentials to a challenge', () => {
  assert.equal(isMatchingProxyChallenge({isProxy:true,statusCode:407,scheme:'basic',challenger:{host:profile.host,port:443}},profile),false);
});
