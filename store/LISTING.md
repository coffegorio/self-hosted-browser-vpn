# Chrome Web Store · Self-Hosted Browser VPN 0.2.1

- **Name** — Self-Hosted Browser VPN
- **Primary language** — Russian
- **Category** — Privacy & Security
- **Home page** — https://github.com/coffegorio/self-hosted-browser-vpn
- **Support** — https://github.com/coffegorio/self-hosted-browser-vpn/issues
- **Privacy policy** — https://github.com/coffegorio/self-hosted-browser-vpn/blob/c1ef2553c19bb2e33cb7c5f787856e1fd12164ef/store/PRIVACY.md
- **Store icon** — `extension/icons/icon-128.png`
- **Screenshots** — `store/screenshots/setup.png`, `store/screenshots/configured.png`, `store/screenshots/verified.png`

## Short description

Настройте HTTP, HTTPS или SOCKS5-прокси для Chrome. Проверяйте внешний IP и добавляйте исключения для сайтов.

## Detailed description

Подключите Chrome к своему прокси. Введите адрес и порт или импортируйте ключ `shbvpn1` от сервера проекта. Подойдёт и прокси, который у вас уже есть. Расширение бесплатно. Сервер предоставляет пользователь, аккаунт у разработчика расширения не нужен.

- Подключение к HTTP и HTTPS с необязательной Basic-аутентификацией и к SOCKS5 без логина и пароля.
- Ручная проверка внешнего IPv4 или IPv6. Можно сохранить ожидаемый адрес и сравнить его с результатом.
- Исключения для доменов, которые должны открываться напрямую.
- Индикация ошибок прокси и конфликтов с настройками Chrome.

Расширение управляет веб-трафиком текущего профиля Chrome. Другие приложения сохраняют свои сетевые настройки. Проверка IP работает по кнопке и обращается к сервису ipify. Значок ON показывает, что настройки применены. Чтобы проверить соединение, нажмите «Проверить внешний IP». При конфликте или смене настроек браузер может перейти на другой маршрут.

Логин и пароль прокси хранятся локально в профиле Chrome. HTTPS шифрует соединение с прокси. При выборе HTTP логин и пароль Basic-аутентификации могут передаваться открыто. В расширении нет аналитики и рекламы.

## Privacy practices

**Single purpose.** Configure and verify a user-supplied proxy for Chrome web requests.

| Permission | Justification |
| --- | --- |
| `proxy` | Set the chosen proxy and user-defined direct exceptions when the user connects. Clear this extension's setting on disconnect. |
| `privacy` | Restrict non-proxied WebRTC UDP while the user is connected and remove the restriction on disconnect. |
| `storage` | Save the proxy endpoint, optional proxy credentials, exceptions, expected IP, and connection state locally. |
| `webRequest` | Handle proxy challenges and clear per-request retry bookkeeping when a request ends. |
| `webRequestAuthProvider` | Respond to matching Basic proxy challenges for the user's configured endpoint. |
| `<all_urls>` | A proxy challenge can occur for any website the user visits, including destinations unknown at installation. There are no content scripts. |

**Remote code.** None. Extension code and PAC generation are bundled locally. The IP endpoint returns JSON data only.

**Data disclosures.** Disclose authentication information used for optional proxy login and location/IP information used for the exit-IP check. The entered proxy username and password are stored locally and sent only to the user's selected proxy on a matching challenge. The observed IP is displayed in the popup and an expected IP is saved locally only if the user enters it. Pressing the IP check button sends an HTTPS request to ipify, which sees the request's exit IP. The developer operates no collection endpoint. The user's chosen proxy handles the web traffic routed to it. The extension keeps no browsing log, cookies, page content, analytics or advertising data.

Verify the dashboard declarations against the [privacy policy](PRIVACY.md) before certifying them. Keep the existing proposed **Unlisted** visibility if the release is intended for direct-link installation. Use **Public** if the owner wants discovery in the store. Both undergo review.

## Review

Paste the [reviewer instructions](REVIEWER-INSTRUCTIONS.md) into **Test instructions**. The reviewer can use a proxy they control. There is no developer login or paid feature to unlock.

[Listing fields](https://developer.chrome.com/docs/webstore/cws-dashboard-listing) · [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) · [Distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
