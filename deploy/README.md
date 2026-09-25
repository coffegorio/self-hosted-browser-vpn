# Установка через Docker Compose

[English](README.en.md) · [Главная страница](../README.md)

Этот способ запускает серверную часть на **Linux, macOS или Windows** с Docker Engine и Docker Compose, способными запускать Linux-контейнеры. На macOS и обычных настольных версиях Windows для этого подходит Docker Desktop. Это установка прокси **на выбранном хосте**: он должен быть доступен из интернета по публичному IPv4 или домену. Для VPS с Ubuntu 24.04/26.04 также остаётся [установщик без контейнеров](../docs/installation.md).

Docker Desktop [не поддерживается на Windows Server](https://docs.docker.com/desktop/setup/install/windows-install/). Контейнерный вариант не является нативной службой macOS или Windows и не превращает браузерный прокси в VPN для всего устройства.

Ориентир для архитектуры хоста — **amd64 или arm64**: используемый [образ Certbot](https://hub.docker.com/r/certbot/certbot/tags/) опубликован для обеих. Работа на других архитектурах не заявлена.

## Перед запуском

- Установите [Docker с Compose](https://docs.docker.com/compose/install/) и убедитесь, что доступны `docker compose version` и Linux-контейнеры.
- Подготовьте **публичный IPv4** либо домен с A-записью на публичный IPv4. Если у домена есть AAAA-запись, её IPv6-адрес тоже должен вести на доступный хост с открытым 80/TCP; устаревшую AAAA-запись уберите. Если хост находится за роутером или NAT, перенаправьте входящие порты на него.
- Освободите и откройте извне **80/TCP** для проверки Let's Encrypt и выбранный порт прокси, по умолчанию **443/TCP**. Оба порта должны быть доступны через файрвол хоста, роутер и файрвол провайдера. Порт 80 должен оставаться открытым для продления сертификата. Docker публикует порты контейнеров; на Linux отдельно проверьте [взаимодействие Docker с файрволом](https://docs.docker.com/engine/network/packet-filtering-firewalls/).
- Если Docker Engine запущен в rootless-режиме на Linux, для публикации порта 80 может потребоваться [настройка привилегированных портов](https://docs.docker.com/engine/security/rootless/tips/).
- Если порт 443 занят, выберите свободный порт, например 8443, через `SHBVPN_PORT`. Порт 80 другим сервисом занимать нельзя.

Серверу нужны исходящие соединения к Let's Encrypt и сайтам назначения. Для домашнего компьютера или ноутбука учитывайте его сон, выключение и смену публичного адреса: прокси и продление сертификата в это время недоступны. VPS с постоянной доступностью обычно удобнее.

## Первый запуск

Из корня проекта скопируйте пример настроек. На Linux/macOS:

```bash
cp deploy/settings.env.example deploy/settings.env
```

В Windows PowerShell:

```powershell
Copy-Item deploy/settings.env.example deploy/settings.env
```

Откройте `deploy/settings.env` и установите один из вариантов:

```dotenv
SHBVPN_KIND=domain
SHBVPN_HOST=proxy.example.com
SHBVPN_PORT=443
SHBVPN_EMAIL=you@example.com
```

или:

```dotenv
SHBVPN_KIND=ip
SHBVPN_HOST=203.0.113.10
SHBVPN_PORT=8443
SHBVPN_EMAIL=
```

Замените примеры на **свой публичный** адрес или домен. `SHBVPN_EMAIL` необязателен; для IP-сертификатов используется профиль Let's Encrypt с коротким сроком действия. Если у хоста есть дополнительные публичные входящие адреса за NAT или floating IP, укажите их через запятую в `SHBVPN_SELF_ADDRESSES`. Прокси блокирует подключения к собственным адресам, поэтому все такие адреса нужно перечислить. При пустом значении ранее сохранённый список остаётся; `SHBVPN_CLEAR_SELF_ADDRESSES=1` удаляет его.

Запустите контейнеры из корня проекта:

```bash
docker compose --env-file deploy/settings.env -f deploy/compose.yaml up --build -d
docker compose --env-file deploy/settings.env -f deploy/compose.yaml ps
```

Первый выпуск сертификата может занять время. После запуска проверьте состояние и получите ключ подключения:

```bash
docker compose --env-file deploy/settings.env -f deploy/compose.yaml logs --tail=100 cert-manager
docker compose --env-file deploy/settings.env -f deploy/compose.yaml exec cert-manager python3 /app/manager.py health
docker compose --env-file deploy/settings.env -f deploy/compose.yaml exec cert-manager python3 /app/manager.py show-key
```

Ключ начинается с `shbvpn1:` и содержит пароль. Не публикуйте его. Загрузите локальную папку `extension` в Chrome и [подключите браузер](../docs/usage.md). Статус `healthy` и локальная проверка не заменяют проверку внешнего IP в Chrome из вашей сети.

## Из чего состоит установка

`acme` отдаёт только файлы проверки HTTP-01 на публичном порту 80. `cert-manager` получает и продлевает сертификат Certbot, хранит учётные данные и проверяет работающий прокси. `proxy` принимает HTTPS на выбранном публичном порту. Данные сохраняются в именованных томах `acme_webroot`, `certbot_state` и `runtime`; ключ и приватный TLS-ключ не записываются в `settings.env`. Контейнеры прокси и ACME работают без root, с файловой системой только для чтения и без Docker socket.

`cert-manager` проверяет сертификат и прокси каждые 12 часов и повторяет неудачную попытку через час. После выпуска нового сертификата он публикует согласованную пару сертификат/ключ, а Go-прокси подхватывает её для новых TLS-соединений без перезапуска. Следите за `docker compose ... ps` и журналом `cert-manager`, особенно при коротком сроке IP-сертификата.

## Управление

Повторно показать ключ:

```bash
docker compose --env-file deploy/settings.env -f deploy/compose.yaml exec cert-manager python3 /app/manager.py show-key
```

Сменить пароль:

```bash
docker compose --env-file deploy/settings.env -f deploy/compose.yaml exec cert-manager python3 /app/manager.py rotate
docker compose --env-file deploy/settings.env -f deploy/compose.yaml restart proxy
docker compose --env-file deploy/settings.env -f deploy/compose.yaml exec cert-manager python3 /app/manager.py health
```

После перезапуска замените ключ через **Заменить сервер** в расширении. Между `rotate` и перезапуском прокси старый пароль ещё может работать; планируйте эти действия вместе.

Изменение `SHBVPN_SELF_ADDRESSES` или `SHBVPN_CLEAR_SELF_ADDRESSES` требует повторного `up -d` для обновления контейнера `cert-manager`. Проверьте, что новый список уже записан в `/runtime/config.json` (команда `docker compose --env-file deploy/settings.env -f deploy/compose.yaml exec cert-manager cat /runtime/config.json`), затем выполните `restart proxy` для его загрузки. Сохранённые `SHBVPN_KIND`, `SHBVPN_HOST` и `SHBVPN_PORT` закреплены за томом `runtime`: их нельзя менять у действующей установки. Для нового адреса или порта сохраните резервную копию, удалите старую установку вместе с томами и создайте новую; старый ключ перестанет работать.

Чтобы обновить образы после изменения исходного кода:

```bash
git pull --ff-only
docker compose --env-file deploy/settings.env -f deploy/compose.yaml up --build -d
```

Для резервной копии остановите контейнеры и сохраните **оба** тома `runtime` и `certbot_state` вместе, используя [механизм резервного копирования томов Docker](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes). В них находятся конфигурация, учётные данные, TLS-ключ и состояние Certbot. Защитите копию как пароль. Сохраняйте также `deploy/settings.env`; само по себе это не секретный ключ подключения. При восстановлении нужны согласованные тома и те же адрес/порт.

Остановить и удалить контейнеры, **сохранив данные**:

```bash
docker compose --env-file deploy/settings.env -f deploy/compose.yaml down
```

Удалить также тома и тем самым **безвозвратно потерять ключ, сертификат и состояние Certbot**:

```bash
docker compose --env-file deploy/settings.env -f deploy/compose.yaml down -v
```

Для диагностики см. [решение проблем](../docs/troubleshooting.md). Не запускайте контейнерный и Ubuntu-вариант одновременно на одном хосте с теми же портами.
