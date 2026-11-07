import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureStoreScreenshot} from './screenshots.mjs';
const root=process.env.SHBVPN_EXTENSION_DIR || fileURLToPath(new URL('../',import.meta.url));
const profile=await mkdtemp(path.join(tmpdir(),'browser-proxy-test-'));
let context;
try {
  context=await chromium.launchPersistentContext(profile,{
    channel:'chromium',headless:true,
    args:['--disable-gpu','--disable-background-networking',`--disable-extensions-except=${root}`,`--load-extension=${root}`]
  });
  let worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).host;
  let page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.locator('#manual-form').waitFor({state:'visible'});
  await captureStoreScreenshot(page,'setup.png',0.92);
  await page.locator('#proxy-type').selectOption('socks5');
  assert.equal(await page.locator('#credentials').isVisible(),false);
  await page.locator('#proxy-host').fill('proxy.example.com');
  await page.locator('#proxy-port').fill('1080');
  await page.locator('#manual-form button').click();
  await page.locator('#connected').waitFor({state:'visible'});
  assert.equal(await page.locator('#server-address').textContent(),'proxy.example.com:1080');
  await page.locator('#connect-button').click();
  await page.waitForFunction(()=>document.getElementById('connect-button').textContent==='Отключить');
  const config=await worker.evaluate(()=>chrome.proxy.settings.get({incognito:false}));
  assert.equal(config.levelOfControl,'controlled_by_this_extension');
  assert.match(config.value.pacScript.data,/SOCKS5 proxy.example.com:1080/);
  await context.close();
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:['--disable-gpu','--disable-background-networking',`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.waitForFunction(()=>document.getElementById('connect-button').textContent==='Отключить');
  const restored=await worker.evaluate(()=>chrome.proxy.settings.get({incognito:false}));
  assert.equal(restored.value.pacScript.data,config.value.pacScript.data);
  await page.waitForFunction(()=>document.getElementById('status-title').textContent==='Маршрутизация включена');
  await captureStoreScreenshot(page,'configured.png',1.2);
  await page.locator('#connect-button').click();
  await page.waitForFunction(()=>document.getElementById('connect-button').textContent==='Подключить');
  assert.deepEqual(errors,[]);
  console.log('PASS: real Chromium loads MV3 worker, saves manual SOCKS5, applies PAC, survives browser restart, disconnects, no popup errors');
} finally {await context?.close();await rm(profile,{recursive:true,force:true});}
