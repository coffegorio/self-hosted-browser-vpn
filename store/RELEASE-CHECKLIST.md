# Release gate

- [x] Locate and preserve the existing repository; work on a dedicated branch.
- [x] Add manual HTTP/HTTPS/SOCKS5 configuration while preserving legacy keys.
- [x] Add expected exit IP comparison and failure tests.
- [x] Validate the popup in a real extension-enabled Chromium session.
- [x] Verify authenticated HTTP and HTTPS traffic through controlled test proxies.
- [x] Verify SOCKS5 traffic, unreachable proxy, bad password, TLS failures and absence of direct fallback for ordinary destinations.
- [x] Exercise restart, settings conflicts and disconnect in the browser; IP-check races have unit coverage.
- [x] Inspect screenshots; create extension icons and store screenshots.
- [x] Reconcile user documentation and privacy policy with final behavior.
- [x] Build a clean ZIP excluding tests, credentials and development dependencies; verify contents.
- [x] Push reviewed changes and host the privacy policy on the public release branch.
- [ ] Verify publisher registration, fee and dashboard access with the owner.
- [ ] Upload package, complete privacy/test instructions, submit for review.
- [ ] Record actual review outcome; distinguish submission from publication.

User laptop acceptance remains necessary to confirm corporate policy allows installation and proxy control. Store publication cannot guarantee that policy outcome.
