# Reviewer instructions

The extension has no developer-operated account or subscription. It requires a proxy supplied by the user. The interface is currently Russian. Do not use personal production credentials when testing.

1. Open the extension popup. In «Тип прокси», choose HTTP, HTTPS or SOCKS5. Enter a reachable proxy hostname and port in «Адрес сервера» and «Порт». HTTP/HTTPS proxies may require both «Логин» and «Пароль». Chrome does not support SOCKS5 username/password authentication. HTTPS proxies require a certificate trusted by Chrome.
2. Press «Сохранить прокси», then «Подключить». This applies browser routing; it does not yet prove connectivity.
3. Press «Проверить внешний IP». It contacts api.ipify.org and displays the outgoing address. Visit an HTTPS website to verify browsing through the proxy.
4. Expand «Ожидаемый IP для входа», save the proxy's expected exit address, and repeat the IP check. A different address must be reported as an error. This is a manual check, not continuous monitoring or a system firewall.
5. Press «Отключить». This clears the extension's routing preference. Other applications are outside this extension's scope.

No website credentials or access to the developer's private server are needed. A reviewer-controlled proxy is sufficient. If the review team requests a hosted test endpoint, the publisher must provision a temporary dedicated endpoint and supply its credentials privately through the review dashboard; no working credentials are included in this public repository.

For reproducible engineering validation, extension/browser-tests/network.mjs starts isolated loopback proxy/origin fixtures with temporary credentials and certificates. Run the documented npm browser tests from extension/README.md. Test-only certificate allowances exist solely in those isolated test processes and are not part of the store ZIP.
