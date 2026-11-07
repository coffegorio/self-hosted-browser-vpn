# Chrome extension 0.2.1

This directory is a plain Manifest V3 extension; there is no build step or external JavaScript dependency in the shipped extension. Playwright is a development-only test dependency.

## Load locally

1. Open `chrome://extensions` in Chrome, enable **Developer mode**, and choose **Load unpacked**.
2. Select this `extension/` directory.
3. Enter your proxy host (ASCII domain or IPv4), port and protocol. HTTP/HTTPS accept optional Basic credentials; SOCKS5 must not require username/password authentication. HTTPS requires a trusted TLS certificate. Alternatively expand the import section and paste a legacy `shbvpn1:` key. Only one connection is saved; remove it to configure another.
4. Click **Подключить**.
5. Use **Проверить внешний IP** to make an IP check through the current Chrome proxy settings. Check the displayed address against the VPS's public egress address. Click **Отключить** to restore Chrome's previous route when finished.

The connection key is `shbvpn1:` followed by unpadded base64url of UTF-8 JSON with exactly `v`, `host`, `port`, `username`, and `password` fields. `v` is `1`; `host` is an ASCII FQDN or IPv4 address without a scheme; `port` is an integer. The extension stores the parsed credentials in `chrome.storage.local` and limits access to trusted extension contexts. Chrome profile files are not encrypted by this extension, so treat the key and local browser profile as secrets.

The extension installs an inline PAC script with `mandatory: true`. It returns one selected `PROXY`, `HTTPS`, or `SOCKS5` endpoint for normal destinations and `DIRECT` only for explicit domain exclusions. Chrome's own implicit bypass for localhost and link-local addresses still applies. During connection, it sets WebRTC IP handling to `disable_non_proxied_udp`; this may affect video calls. Disconnecting clears both extension settings and returns Chrome to its other configured settings.

The green **ON** badge means Chrome reports that this extension controls the expected proxy and WebRTC settings. It does not prove that the VPS is reachable or that every Chrome networking feature is proxied. A red **!** badge marks a Chrome settings conflict or reported proxy error. The external IP check is the live connection check. A full browser/network acceptance test remains necessary, including DNS, IPv6, WebRTC, proxy failure, browser restart, and incognito behavior. For incognito testing, explicitly allow the extension in incognito so its proxy authentication handler can run there.

## Local tests

From this directory:

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
npm run test:network
npm run test:conflict
```

Tests use isolated temporary profiles and random local credentials. They never modify your everyday Chrome profile. Network fixtures deliberately permit a specific temporary test certificate by SPKI for successful TLS cases; an independent rejection case uses no certificate exception. No certificate exceptions are shipped in the extension.

Build the allowlisted store ZIP from the repository root with `python3 scripts/package-extension.py`. Set `SHBVPN_EXTENSION_DIR` to the absolute path of an extracted ZIP to run the browser tests on that package. To update store screenshots, run both `npm run test:browser` and `npm run test:network` with `SHBVPN_STORE_SCREENSHOTS=../store/screenshots` from this directory. See the [release checklist](../store/RELEASE-CHECKLIST.md).

## Expected exit IP

Expand **Ожидаемый IP для входа**, enter the intended IPv4 or IPv6 address and save. The manual check uses `api.ipify.org` for IPv4 by default and `api6.ipify.org` when an expected IPv6 address is set. It reports mismatches and refuses to run if the selected host is excluded. The popup discards the result when proxy settings, exceptions, expected IP, or WebRTC settings change. The ON badge confirms that settings were applied. The IP check reports one observation each time you run it. Removing or replacing the saved proxy removes the expected IP.

## Boundaries

Disabling/uninstalling the extension, another extension taking control, or a browser policy can restore another route. This extension does not promise a system kill switch. If WebRTC restrictions cannot be maintained it clears its proxy preference and reports an error; other configured routes may then apply. Incognito and corporate policies need acceptance testing in the target environment. Browser extensions cannot route Claude Desktop itself.

[Privacy policy](../store/PRIVACY.md).
