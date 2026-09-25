# Changelog

## Unreleased — current `main`

- Added Docker Compose deployment with Linux containers for Linux, macOS, and supported Windows hosts, plus Russian and English setup guides.
- Added automatic TLS certificate reload for new proxy connections, without restarting established tunnels.
- Improved certificate renewal, credential permissions, public-address validation, health checks, and Ubuntu firewall handling.
- Fixed incomplete unauthenticated request bodies retaining connections, and truncated upstream HTTP responses appearing complete to clients.
- Improved Chrome proxy ownership, incognito and WebRTC handling; external-IP checks now reject results collected while the route changes.
- Expanded Go, extension, installer, and container tests. CI builds the Docker images and cross-compiles the server for six OS/architecture targets.

These changes are available from `main`. The `v0.1.0` preview archive predates them.

## [0.1.0 — MVP preview](https://github.com/coffegorio/self-hosted-browser-vpn/releases/tag/v0.1.0)

- Authenticated HTTPS proxy with HTTP forwarding and CONNECT tunnels.
- Chrome Manifest V3 extension with connection keys, domain exclusions, and external-IP checks.
- Ubuntu 24.04/26.04 installer with Let's Encrypt certificates, renewal, key rotation, and removal.
- Russian documentation, an English project guide, local tests, GitHub Actions CI, and the MIT license.

The project remains an MVP. It is a browser proxy, and the extension is loaded unpacked rather than installed from the Chrome Web Store.
