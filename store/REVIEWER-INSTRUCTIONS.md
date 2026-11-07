# Reviewer instructions

Self-Hosted Browser VPN configures a user-supplied web proxy for Chrome. The interface is in Russian. There is no developer account, subscription, or developer-operated proxy to sign in to.

1. Open the extension popup. In «Тип прокси», choose HTTP, HTTPS or SOCKS5. Enter a reachable proxy in «Адрес сервера» and «Порт». Use the test username and password if your HTTP/HTTPS proxy requires Basic authentication. Use an unauthenticated SOCKS5 proxy for SOCKS5. For HTTPS proxy transport, Chrome must trust the proxy's certificate.
2. Press «Сохранить прокси», then «Подключить». The status «Маршрутизация включена» indicates that Chrome applied the proxy settings. Open an HTTPS website to verify browsing.
3. Press «Проверить внешний IP». The popup shows the address seen by the IP check service. Open the expected-IP section, enter the address it displayed, save and repeat the check. It should show «IP совпадает». Enter a different address of the same family and repeat. The popup should report a mismatch. To test IPv6, use a proxy with IPv6 egress and enter its IPv6 address before the check.
4. Add an exception under «Исключения для сайтов». Saving it clears the previous IP result. Traffic to that domain and its subdomains uses the direct route. An exception covering the IP check host causes the check to stop before contacting ipify.
5. Press «Отключить». The extension's routing preference is removed and the popup clears the previous IP result. The saved proxy remains available for the next connection.

A reviewer-controlled proxy is sufficient for all flows. Please use disposable test credentials. The publisher can provide a dedicated temporary test proxy privately if requested.

The repository also has automated local fixtures for authenticated HTTP and HTTPS, unauthenticated SOCKS5, IPv4/IPv6 checks and settings conflicts. They use temporary credentials and profiles. From the [release branch](https://github.com/coffegorio/self-hosted-browser-vpn/tree/codex/chrome-store-release), enter the `extension` directory and run `npm ci`, `npx playwright install chromium`, then `npm run test:network` and `npm run test:conflict`. To check the uploaded ZIP, extract it and set `SHBVPN_EXTENSION_DIR` to that absolute directory before running the tests. The certificate allowance applies only to fixture processes. [Full test instructions](../extension/README.md)
