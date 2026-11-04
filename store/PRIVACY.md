# Privacy policy — Self-Hosted Browser VPN

This extension lets you configure your own proxy for Chrome's web requests. It is not a system VPN. The developer does not operate the proxy you enter.

## Data stored on your device

Proxy address, port, protocol, optional proxy username and password, expected exit IP, domain exclusions and connection settings are stored in Chrome's local extension storage. They are not synced by the extension and are not sent to the developer. Local storage is not encrypted by this extension; protect your computer and browser profile. Removing the extension removes its local settings. The extension also provides a button to remove the saved connection.

## Connections and authentication

Chrome sends proxied requests to the proxy you select. That provider receives connection information and handles traffic under its own policies. The extension only supplies saved proxy credentials to matching proxy authentication challenges; it does not send them to destination websites. HTTPS proxies encrypt the connection to the proxy. HTTP proxies do not encrypt that connection, including Basic proxy authentication. HTTPS destination sites retain their own TLS encryption.

## Optional external IP check

When you press the IP check button, the extension requests https://api.ipify.org?format=json through Chrome's configured route. That service receives the request's source IP and ordinary request metadata. The extension uses its reply to display your external IP and compare it with an optional expected IP. See https://www.ipify.org/ for information about this service. Checks are initiated by you, not continuous monitoring.

## Permissions

Proxy permission sets browser routing. Privacy permission restricts non-proxied WebRTC UDP while connected and clears this extension's preference on disconnect. Storage retains your configuration. Web request and authentication permissions handle proxy authentication for arbitrary destination websites. The extension does not collect page content, cookies, browsing history or analytics, sell data, or use advertising SDKs. Proxy errors are retained locally as a short code and timestamp without website URLs.

## Contact

Questions can be submitted at https://github.com/coffegorio/self-hosted-browser-vpn/issues. Do not include passwords, connection keys or other private information in public issues. Security reporting instructions are in the repository's SECURITY.md.
