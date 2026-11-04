import {chromium} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(path.join(root,'icons'),{recursive:true});
const browser=await chromium.launch({channel:'chromium',headless:true});
try {
 const page=await browser.newPage();
 for(const size of [16,32,48,128]){
  await page.setViewportSize({width:size,height:size});
  await page.setContent(`<style>*{margin:0}svg{display:block}</style><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128"><rect width="128" height="128" rx="30" fill="#096a55"/><path d="M39 89 89 39M45 39h44v44" fill="none" stroke="white" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  await page.screenshot({path:path.join(root,`icons/icon-${size}.png`)});
 }
}finally{await browser.close();}
