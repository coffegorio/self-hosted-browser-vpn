# Сообщение об уязвимости

Проект пока находится на стадии MVP без стабильных релизов. Исправления ориентированы на актуальную ветку `main`; отдельной поддержки старых версий сейчас нет. Информация о доверии, секретах и границах браузерного прокси находится в [модели безопасности](docs/security.md).

Если вы нашли уязвимость в `server/`, `installer/`, `deploy/` или `extension/`:

1. Отправьте [приватный отчёт через GitHub](https://github.com/coffegorio/self-hosted-browser-vpn/security/advisories/new) — **Security → Report a vulnerability**. Приватные сообщения об уязвимостях включены; детали отчёта не появятся в открытом issue.
2. Если приватная отправка недоступна, создайте [issue](https://github.com/coffegorio/self-hosted-browser-vpn/issues/new/choose) только с кратким, безопасным описанием и просьбой указать приватный канал связи. Не публикуйте шаги эксплуатации, рабочие ключи, адреса личных серверов и данные других людей.
3. В приватном отчёте укажите затронутый компонент и коммит или версию, предпосылки, воспроизводимые шаги с тестовыми данными, возможное воздействие и предложенный способ исправления, если он есть.

Мы подтвердим получение и разберём сообщение по возможности; заранее установленного срока ответа или выпуска исправления нет. Обычные ошибки без риска для безопасности отправляйте через [шаблон ошибки](https://github.com/coffegorio/self-hosted-browser-vpn/issues/new/choose).

Если раскрыт ваш ключ подключения `shbvpn1:…`, считайте пароль прокси скомпрометированным. Для Ubuntu выполните `sudo shbvpn --rotate`; для Docker Compose выполните `rotate` и перезапустите прокси по [руководству](deploy/README.md). Затем замените ключ в расширении. Не помещайте старый или новый ключ в отчёт.

## Reporting in English

Use [GitHub private vulnerability reporting](https://github.com/coffegorio/self-hosted-browser-vpn/security/advisories/new). Include the affected component and commit, prerequisites, reproduction steps with test data, and impact. Do not post exploit details or credentials in a public issue. Fixes target current `main`; older previews have no separate support, and there is no guaranteed response or fix deadline.

If a connection key leaks, rotate the proxy password and replace the key in Chrome. Native Ubuntu installations use `sudo shbvpn --rotate`; Compose installations require both password rotation and a proxy restart, as described in the [Compose guide](deploy/README.en.md).
