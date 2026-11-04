# Chrome Web Store listing draft

Name: Self-Hosted Browser VPN

Short description:
Connect Chrome to your own HTTP, HTTPS or SOCKS5 proxy. Check your exit IP and manage domain exclusions.

Full description:
Use a proxy server you control or obtain from your provider. Enter the address, port and protocol directly, or import a shbvpn1 key from the project's optional server installer.

Features:
- HTTP and HTTPS proxies with optional Basic authentication.
- SOCKS5 without username/password authentication (a Chrome limitation).
- Explicit connect and disconnect controls.
- External IP check with an optional expected exit IP comparison.
- Domain exclusions for sites you intentionally want to access directly.
- Proxy-setting conflict and connection error reporting.
- WebRTC non-proxied UDP restriction while connected.

You supply the proxy. No account with the extension developer or subscription is required. This extension affects browser web requests; it does not create a system VPN or route other applications. A displayed active setting is not proof of a working connection: use the IP check before signing in. The expected-IP check is manual and is not a continuous firewall. Localhost and link-local destinations have browser-level bypass behavior. Browser policies and other extensions may prevent proxy control.

Credentials are stored locally in your Chrome profile and are not encrypted by this extension. IP checks contact api.ipify.org only when requested. The extension has no analytics or advertising.

## Dashboard declarations to review before submission

Single purpose: Configure and verify a user-supplied browser proxy.

proxy: Set and clear the user's chosen proxy configuration.
privacy: Restrict non-proxied WebRTC UDP while connected.
storage: Save proxy configuration and local state.
webRequest + webRequestAuthProvider: Respond to HTTP proxy authentication challenges only for the configured proxy endpoint.
<all_urls>: Proxy authentication challenges occur for arbitrary destination URLs, including those not known before installation. There are no content scripts.
Remote code: None. All executable extension code is packaged locally.

Publication option proposed: Unlisted (still requires normal store review).
Privacy policy URL: https://github.com/coffegorio/self-hosted-browser-vpn/blob/codex/chrome-store-release/store/PRIVACY.md

Reviewer instructions: see store/REVIEWER-INSTRUCTIONS.md.

Do not submit until the release checklist and browser network tests are complete.
