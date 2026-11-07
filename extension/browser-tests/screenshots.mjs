import {mkdir} from 'node:fs/promises';
import path from 'node:path';

export async function captureStoreScreenshot(page, name, zoom = 1) {
  const directory = process.env.SHBVPN_STORE_SCREENSHOTS;
  if (!directory) return;

  await mkdir(directory, {recursive: true});
  await page.setViewportSize({width: 1280, height: 800});
  const style = await page.addStyleTag({content: `body { margin: 12px auto 0; zoom: ${zoom}; }`});
  try {
    await page.screenshot({captureBeyondViewport: false, path: path.join(directory, name)});
  } finally {
    await style.evaluate(node => node.remove());
  }
}
