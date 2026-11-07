# Privacy policy · Self-Hosted Browser VPN

Self-Hosted Browser VPN configures the proxy you choose for Chrome's web requests. The developer does not operate that proxy.

## Settings on your device

The extension stores your proxy address, port, protocol, optional proxy username and password, expected exit IP, domain exceptions and connection settings in Chrome's local extension storage. The extension does not sync this data or send it to the developer. The extension does not encrypt the local browser profile. You can remove the saved settings from the popup. Uninstalling the extension removes its local settings.

## Proxy connections

Chrome sends traffic for the selected route to the proxy you configured. The proxy provider handles that traffic under its own policies. The extension supplies saved credentials only for matching proxy authentication challenges. HTTPS proxy transport encrypts the connection to the proxy. HTTP proxy transport can expose Basic proxy credentials on that connection. Connections to HTTPS websites retain the websites' own TLS encryption.

## External IP check

When you press the IP check button, the extension requests `https://api.ipify.org?format=json` for IPv4 or `https://api6.ipify.org?format=json` when you configured an expected IPv6 address. [Ipify](https://www.ipify.org/) sees the request's source IP and ordinary request metadata. The extension displays the reply and compares it with the expected IP, if you entered one. The reply is held in the open popup for display and is not saved to disk. The check runs only when requested.

## Permissions and use of data

Proxy permission sets the selected route. Privacy permission restricts non-proxied WebRTC UDP during the connection. Storage retains local settings. Web request and authentication permissions handle proxy challenges for arbitrary destinations. Proxy errors are stored locally as a short code and timestamp without website URLs. The extension keeps no browsing history, page content, cookies, analytics, or advertising data. The developer does not sell user data.

The extension's use of information received through Chrome APIs complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including its Limited Use requirements.

## Contact

Use the [project issue tracker](https://github.com/coffegorio/self-hosted-browser-vpn/issues) for general questions. Keep credentials and private connection information out of public issues. See [SECURITY.md](../SECURITY.md) for security reports.
