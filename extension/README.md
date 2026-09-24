# Chrome extension MVP

This directory is a plain Manifest V3 extension; there is no build step or external JavaScript dependency.

## Load locally

1. Open `chrome://extensions` in Chrome, enable **Developer mode**, and choose **Load unpacked**.
2. Select this `extension/` directory.
3. Click the extension icon, paste the `shbvpn1:` key produced by the server installer, then click **Подключить**.
4. Use **Проверить внешний IP** to make a request to `api.ipify.org` through the current Chrome proxy settings. Check the displayed address against the VPS's public egress address.

The connection key is `shbvpn1:` followed by unpadded base64url of UTF-8 JSON with exactly `v`, `host`, `port`, `username`, and `password` fields. `v` is `1`; `host` is an ASCII FQDN or IPv4 address without a scheme; `port` is an integer. The extension stores the parsed credentials in `chrome.storage.local` and limits access to trusted extension contexts. Chrome profile files are not encrypted by this extension, so treat the key and local browser profile as secrets.

The extension installs an inline PAC script with `mandatory: true`. It returns one `HTTPS host:port` proxy for normal destinations and `DIRECT` only for explicit domain exclusions. Chrome's own implicit bypass for localhost and link-local addresses still applies. During connection, it sets WebRTC IP handling to `disable_non_proxied_udp`; this may affect video calls. Disconnecting clears both extension settings and returns Chrome to its other configured settings.

The green **ON** badge means Chrome reports that this extension controls the expected proxy and WebRTC settings. It does not prove that the VPS is reachable or that every Chrome networking feature is proxied. A red **!** badge marks a Chrome settings conflict or reported proxy error. The external IP check is the live connection check. A full browser/network acceptance test remains necessary, including DNS, IPv6, WebRTC, proxy failure, browser restart, and incognito behavior. For incognito testing, explicitly allow the extension in incognito so its proxy authentication handler can run there.

## Local tests

Run `npm test` from this directory. The tests cover key validation, authorization challenge matching, and PAC routing without direct fallback for ordinary destinations.
