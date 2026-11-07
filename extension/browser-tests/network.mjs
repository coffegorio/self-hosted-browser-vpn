import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {X509Certificate,createHash} from 'node:crypto';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureStoreScreenshot} from './screenshots.mjs';
const root=process.env.SHBVPN_EXTENSION_DIR || fileURLToPath(new URL('../',import.meta.url));
const token=randomBytes(18).toString('hex');
const password=randomBytes(16).toString('hex');
let direct=0,forwarded=0,challenges=0,credentialLeaks=0;
let secureOriginPort, secureSocksOriginPort;
const sockets=new Set();
const origin=http.createServer((req,res)=>{
  if(req.headers['proxy-authorization']) credentialLeaks++;
  if(req.url.startsWith('/probe')) {
    if(req.headers['x-test-route']===token)forwarded++;else direct++;
  }
  res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store','Connection':'close'});
  res.end('controlled-origin');
});
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',()=>resolve(s.address().port)));
const originPort=await listen(origin);
const proxy=http.createServer((req,res)=>{
  if(req.headers['proxy-authorization']!=='Basic '+Buffer.from('tester:'+password).toString('base64')){
    challenges++;
    res.writeHead(407,{'Proxy-Authenticate':'Basic realm="test-proxy"','Connection':'close'});res.end();return;
  }
  let target;try{target=new URL(req.url)}catch{res.writeHead(400);res.end();return;}
  if(target.hostname!=='route-test.example' || target.port!==String(originPort)) {res.writeHead(502);res.end();return;}
  const upstream=http.request({host:'127.0.0.1',port:originPort,path:target.pathname+target.search,headers:{'x-test-route':token}},r=>{
    res.writeHead(r.statusCode,r.headers);r.pipe(res);
  });upstream.on('error',()=>{res.writeHead(502);res.end()});req.pipe(upstream);
});

proxy.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
const proxyPort=await listen(proxy);
const socksOrigin=http.createServer((req,res)=>{
  req.headers['x-test-route']=token;
  origin.emit('request',req,res);
});
const socksOriginPort=await listen(socksOrigin);
const socksSockets=new Set();
const socks=net.createServer(socket=>{
  socksSockets.add(socket);socket.on('close',()=>socksSockets.delete(socket));
  socket.on('error',()=>{});
  let buffer=Buffer.alloc(0),phase=0;
  const receive=chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    if(phase===0){
      if(buffer.length<2||buffer.length<2+buffer[1])return;
      if(buffer[0]!==5){socket.destroy();return;}
      buffer=buffer.subarray(2+buffer[1]);socket.write(Buffer.from([5,0]));phase=1;
    }
    if(phase===1){
      if(buffer.length<5)return;
      if(buffer[0]!==5||buffer[1]!==1||buffer[3]!==3){socket.destroy();return;}
      const n=buffer[4];if(buffer.length<7+n)return;
      const host=buffer.subarray(5,5+n).toString();const port=buffer.readUInt16BE(5+n);
      if(host!=='route-test.example'||![originPort,secureOriginPort].includes(port)){socket.destroy();return;}
      const rest=buffer.subarray(7+n);phase=2;socket.pause();socket.removeListener('data',receive);
      const upstream=net.connect(port===secureOriginPort?secureSocksOriginPort:socksOriginPort,'127.0.0.1',()=>{
        socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));
        if(rest.length)upstream.write(rest);
        socket.pipe(upstream);upstream.pipe(socket);socket.resume();
      });
      upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());
    }
  };socket.on('data',receive);
});
const socksPort=await listen(socks);
const tlsDir=await mkdtemp(path.join(tmpdir(),'proxy-tls-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(tlsDir,'key.pem'),'-out',path.join(tlsDir,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1'],{stdio:'ignore'});
const certificate=await readFile(path.join(tlsDir,'cert.pem'));
const spki=createHash('sha256').update(new X509Certificate(certificate).publicKey.export({type:'spki',format:'der'})).digest('base64');
const secureProxy=https.createServer({key:await readFile(path.join(tlsDir,'key.pem')),cert:certificate},(req,res)=>proxy.emit('request',req,res));

const securePort=await listen(secureProxy);
const tlsOptions={key:await readFile(path.join(tlsDir,'key.pem')),cert:certificate};
const secureOrigin=https.createServer(tlsOptions,(req,res)=>origin.emit('request',req,res));
secureOriginPort=await listen(secureOrigin);
const secureForward=https.createServer(tlsOptions,(req,res)=>{req.headers['x-test-route']=token;origin.emit('request',req,res);});
secureSocksOriginPort=await listen(secureForward);
const ipv4='203.0.113.9';
const ipv6='2001:db8::9';
const ipHosts=new Map([['api.ipify.org',ipv4],['api6.ipify.org',ipv6]]);
const ipRequests=[];
let redirectIpCheck=false;
const ipOrigin=https.createServer(tlsOptions,(req,res)=>{
  const ip=ipHosts.get(req.headers.host);
  assert.ok(ip);
  assert.equal(req.url,'/?format=json');
  ipRequests.push(req.headers.host);
  if(redirectIpCheck){
    res.writeHead(302,{Location:`https://route-test.example:${secureOriginPort}/probe?redirect`});
    res.end();
    return;
  }
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
  res.end(JSON.stringify({ip}));
});
const ipPort=await listen(ipOrigin);
function connectTunnel(req,socket,head){
  socket.on('error',()=>{});
  if(req.headers['proxy-authorization']!=='Basic '+Buffer.from('tester:'+password).toString('base64')){
    challenges++;socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test-proxy"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');return;
  }
  const [host,port]=req.url.split(':');
  const destination=ipHosts.has(host)&&port==='443' ? ipPort
    : req.url===`route-test.example:${secureOriginPort}` ? secureSocksOriginPort : null;
  if(!destination){socket.destroy();return;}
  const upstream=net.connect(destination,'127.0.0.1',()=>{
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if(head.length)upstream.write(head);
    socket.pipe(upstream);upstream.pipe(socket);
  });upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());
}
proxy.on('connect',connectTunnel);secureProxy.on('connect',connectTunnel);
async function scenario(wrongPassword=false,stopProxy=false,scheme='http',invalidTLS=false,destinationTLS=false){
  const profile=await mkdtemp(path.join(tmpdir(),'proxy-network-'));
  let context;
  try {
    context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[
      `--disable-extensions-except=${root}`,`--load-extension=${root}`,
      '--host-resolver-rules=MAP route-test.example 127.0.0.1','--disable-background-networking',
      ...((scheme==='https'||destinationTLS)&&!invalidTLS?[`--ignore-certificate-errors-spki-list=${spki}`]:[])
    ]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const popup=await context.newPage();await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    const message=(type,fields={})=>popup.evaluate(async ({type,fields})=>chrome.runtime.sendMessage({type,...fields}),{type,fields});
    assert.equal((await message('SAVE_CONNECTION',{connection:{v:2,scheme,host:'127.0.0.1',port:scheme==='socks5'?socksPort:scheme==='https'?securePort:proxyPort,username:scheme==='socks5'?'':'tester',password:scheme==='socks5'?'':wrongPassword?'wrong':password}})).ok,true);
    assert.equal((await message('CONNECT')).ok,true);
    const page=await context.newPage();
    const url=`${destinationTLS?'https':'http'}://route-test.example:${destinationTLS?secureOriginPort:originPort}/probe?${randomBytes(6).toString('hex')}`;
    const before={direct,forwarded};
    if(stopProxy){
      const server=scheme==='socks5'?socks:proxy;
      const closing=new Promise(resolve=>server.close(resolve));
      for(const s of scheme==='socks5'?socksSockets:sockets)s.destroy();
      await closing;
    }
    let response,error;
    try{response=await page.goto(url,{timeout:15000});}catch(e){error=e;}
    if(wrongPassword||stopProxy||invalidTLS){
      assert.ok(error||!response||response.status()!==200,'Failed proxy must not load origin');
      assert.equal(direct,before.direct,'Direct fallback reached controlled origin');
      assert.equal(forwarded,before.forwarded);
    }else{
      if(!response) console.error('FAILED STATE',await message('GET_STATE'),{challenges,direct,forwarded});
      assert.ok(response, error?.message || 'Missing response');
      assert.equal(response.status(),200);
      assert.equal(await page.locator('body').textContent(),'controlled-origin');
      assert.ok(forwarded>before.forwarded);assert.equal(direct,before.direct);
    }
    assert.equal((await message('DISCONNECT')).ok,true);
    // A failed navigation can still be committing Chromium's error page.
    const directPage=await context.newPage();
    const directResponse=await directPage.goto(url+'&direct=1',{timeout:15000});
    assert.equal(directResponse.status(),200);
    assert.ok(direct>before.direct,'Control: direct route must actually be reachable');
    assert.equal(credentialLeaks,0,'Proxy credentials reached origin');
    console.log('PASS real browser network:',scheme,destinationTLS?'HTTPS destination':'HTTP destination',invalidTLS?'untrusted TLS certificate rejected':wrongPassword?'wrong credentials rejected':stopProxy?'unreachable proxy without direct fallback':'authenticated HTTP forwarding; direct route after disconnect');
  }finally{await context?.close();await rm(profile,{recursive:true,force:true});}
}

async function verifyExitIpPopup(){
  const directory=await mkdtemp(path.join(tmpdir(),'proxy-ip-popup-'));
  const rival=path.join(directory,'rival');
  let context;
  try {
    await mkdir(rival);
    await writeFile(path.join(rival,'manifest.json'),JSON.stringify({
      manifest_version:3,name:'Test proxy owner',version:'1.0',permissions:['proxy'],
      background:{service_worker:'rival.js'}
    }));
    await writeFile(path.join(rival,'rival.js'),'chrome.runtime.onInstalled.addListener(()=>{});');
    context=await chromium.launchPersistentContext(path.join(directory,'profile'),{
      channel:'chromium',headless:true,args:[
        `--disable-extensions-except=${root},${rival}`,`--load-extension=${root},${rival}`,
        `--ignore-certificate-errors-spki-list=${spki}`,
        '--host-resolver-rules=MAP route-test.example 127.0.0.1, MAP api.ipify.org ~NOTFOUND, MAP api6.ipify.org ~NOTFOUND',
        '--disable-background-networking'
      ]
    });
    const findWorker=async script=>{
      const matches=worker=>worker.url().endsWith(`/${script}`);
      return context.serviceWorkers().find(matches)||context.waitForEvent('serviceworker',{predicate:matches});
    };
    const [main,other]=await Promise.all([findWorker('background.js'),findWorker('rival.js')]);
    const popup=await context.newPage();
    await popup.goto(`chrome-extension://${new URL(main.url()).host}/popup.html`);
    const message=(type,fields={})=>popup.evaluate(message=>chrome.runtime.sendMessage(message),{type,...fields});
    assert.equal((await message('SAVE_CONNECTION',{connection:{
      v:2,scheme:'https',host:'127.0.0.1',port:securePort,username:'tester',password
    }})).ok,true);
    await popup.locator('#connect-button').click();
    await expect(popup.locator('#status-title')).toHaveText('Маршрутизация включена');

    const result=popup.locator('#ip-result');
    const check=()=>popup.locator('#test-button').click();
    await check();
    await expect(result).toContainText(ipv4);
    assert.deepEqual(ipRequests,['api.ipify.org']);

    assert.equal((await message('SAVE_EXPECTED_IP',{ip:ipv6})).ok,true);
    await expect(result).toBeEmpty();
    await check();
    await expect(result).toHaveText(`IP совпадает: ${ipv6}`);
    assert.deepEqual(ipRequests,['api.ipify.org','api6.ipify.org']);
    await captureStoreScreenshot(popup,'verified.png',1.2);

    assert.equal((await message('SAVE_EXCLUSIONS',{text:'ipify.org'})).ok,true);
    await expect(result).toBeEmpty();
    await check();
    await expect(popup.locator('#error')).toContainText('в исключениях');
    assert.equal(ipRequests.length,2);

    assert.equal((await message('SAVE_EXCLUSIONS',{text:'route-test.example'})).ok,true);
    redirectIpCheck=true;
    const before=direct;
    await check();
    await expect(popup.locator('#error')).toBeVisible();
    await expect(result).toBeEmpty();
    assert.equal(ipRequests.length,3);
    assert.equal(direct,before,'IP check followed a redirect to a direct destination');
    redirectIpCheck=false;

    await check();
    await expect(result).toHaveText(`IP совпадает: ${ipv6}`);
    await other.evaluate(()=>chrome.proxy.settings.set({scope:'regular',value:{mode:'direct'}}));
    await expect(popup.locator('#status-title')).toHaveText('Конфликт настроек');
    await expect(result).toBeEmpty();
    console.log('PASS real browser: IPv4 and IPv6 IP checks, exclusions and redirects, live invalidation after proxy takeover');
  } finally {
    await context?.close();
    await rm(directory,{recursive:true,force:true});
  }
}

try {
  await scenario();assert.ok(challenges>0);await scenario(true);
  await scenario(false,false,'http',false,true);await scenario(true,false,'http',false,true);
  await scenario(false,true);
  await scenario(false,false,'socks5');await scenario(false,false,'socks5',false,true);await scenario(false,true,'socks5');
  await scenario(false,false,'https');await scenario(true,false,'https');
  await scenario(false,false,'https',false,true);await scenario(true,false,'https',false,true);
  await scenario(false,false,'https',true);
  await verifyExitIpPopup();
}
finally {ipOrigin.closeAllConnections();ipOrigin.close();secureOrigin.closeAllConnections();secureOrigin.close();secureForward.closeAllConnections();secureForward.close();secureProxy.closeAllConnections();secureProxy.close();await rm(tlsDir,{recursive:true,force:true});for(const s of socksSockets)s.destroy();socks.close();socksOrigin.closeAllConnections();socksOrigin.close();for(const s of sockets)s.destroy();proxy.closeAllConnections();proxy.close();origin.closeAllConnections();await new Promise(r=>origin.close(r));}
