# Docker Compose installation

[Русский](README.md) · [Project home](../README.en.md)

This method runs the server on **Linux, macOS, or Windows** hosts with Docker Engine and Docker Compose that can run Linux containers. Docker Desktop works for supported macOS and desktop Windows versions. The chosen host must be reachable from the internet through a public IPv4 address or a domain. Ubuntu 24.04/26.04 also has a [native installer](../docs/installation.md) (Russian).

[Docker Desktop does not support Windows Server](https://docs.docker.com/desktop/setup/install/windows-install/). This is a Linux container deployment, not a native macOS or Windows service or a device-wide VPN.

The target host architectures are **amd64 and arm64**; the pinned [Certbot image](https://hub.docker.com/r/certbot/certbot/tags/) publishes both. Other CPU architectures are not claimed.

## Before you start

- Install [Docker with Compose](https://docs.docker.com/compose/install/) and check `docker compose version` and Linux container support.
- Have a **public IPv4 address**, or a domain whose A record points to one. If the domain has an AAAA record, its IPv6 address must also reach the host on 80/TCP; remove a stale AAAA record. If the host is behind a router or NAT, forward the inbound ports to it.
- Reserve and allow inbound **80/TCP** for Let's Encrypt HTTP-01 and the chosen proxy port, **443/TCP** by default. Both must pass the host, router, and provider firewalls. Keep 80/TCP accessible for renewal. Docker publishes the container ports; on Linux, check [Docker's firewall behavior](https://docs.docker.com/engine/network/packet-filtering-firewalls/).
- If Docker Engine runs rootless on Linux, publishing port 80 may require [privileged port configuration](https://docs.docker.com/engine/security/rootless/tips/).
- If 443 is occupied, set a free `SHBVPN_PORT` such as 8443. Port 80 must be available for this deployment.

The host also needs outbound connectivity to Let's Encrypt and destination websites. On a home computer, sleep, shutdown, and a changing public address interrupt the proxy and certificate renewal. An always-on VPS is usually easier to operate.

## First run

From the repository root, copy the example settings. On Linux/macOS:

```bash
cp deploy/settings.env.example deploy/settings.env
```

In Windows PowerShell:

```powershell
Copy-Item deploy/settings.env.example deploy/settings.env
```

Edit `deploy/settings.env`. Choose a domain:

```dotenv
SHBVPN_KIND=domain
SHBVPN_HOST=proxy.example.com
SHBVPN_PORT=443
SHBVPN_EMAIL=you@example.com
```

Or a public IPv4 address:

```dotenv
SHBVPN_KIND=ip
SHBVPN_HOST=203.0.113.10
SHBVPN_PORT=8443
SHBVPN_EMAIL=
```

Replace the examples with **your actual public** address or domain. `SHBVPN_EMAIL` is optional. IP certificates use Let's Encrypt's short-lived profile. If the host has other public ingress addresses behind NAT or floating IPs, list them separated by commas in `SHBVPN_SELF_ADDRESSES`; the proxy must know them to block connections back to itself. Leaving the value empty preserves the saved list, while `SHBVPN_CLEAR_SELF_ADDRESSES=1` removes it.

Start from the repository root:

```bash
docker compose --env-file deploy/settings.env -f deploy/compose.yaml up --build -d
docker compose --env-file deploy/settings.env -f deploy/compose.yaml ps
```

The first certificate may take a while. Inspect the status and retrieve the connection key:

```bash
docker compose --env-file deploy/settings.env -f deploy/compose.yaml logs --tail=100 cert-manager
docker compose --env-file deploy/settings.env -f deploy/compose.yaml exec cert-manager python3 /app/manager.py health
docker compose --env-file deploy/settings.env -f deploy/compose.yaml exec cert-manager python3 /app/manager.py show-key
```

The `shbvpn1:` key contains a password. Keep it secret. Load the local `extension` directory into Chrome and follow the [browser guide](../docs/usage.md) (Russian). A healthy local service is not a substitute for checking the external IP from Chrome on your network.

## Services and state

`acme` serves only HTTP-01 challenge files on public port 80. `cert-manager` obtains and renews the Certbot certificate, stores credentials, and checks the live proxy. `proxy` accepts HTTPS on the selected public port. The named volumes `acme_webroot`, `certbot_state`, and `runtime` preserve the state. The connection password and private TLS key are not stored in `settings.env`. The proxy and ACME containers run as non-root users with read-only root filesystems and no Docker socket.

The manager checks the certificate and proxy every 12 hours, retrying failures after one hour. On renewal it publishes a matching certificate/key pair; the Go proxy loads that pair for new TLS connections without a restart. Monitor `docker compose ... ps` and the `cert-manager` logs, especially for short-lived IP certificates.

## Management

Show the key again:

```bash
docker compose --env-file deploy/settings.env -f deploy/compose.yaml exec cert-manager python3 /app/manager.py show-key
```

Rotate the password:

```bash
docker compose --env-file deploy/settings.env -f deploy/compose.yaml exec cert-manager python3 /app/manager.py rotate
docker compose --env-file deploy/settings.env -f deploy/compose.yaml restart proxy
docker compose --env-file deploy/settings.env -f deploy/compose.yaml exec cert-manager python3 /app/manager.py health
```

Then use **Заменить сервер** (Replace server) in the extension. The old password may still work between `rotate` and the proxy restart; perform those steps together.

Changing `SHBVPN_SELF_ADDRESSES` or `SHBVPN_CLEAR_SELF_ADDRESSES` requires another `up -d` to recreate `cert-manager`. Check that the new list has been written to `/runtime/config.json` (`docker compose --env-file deploy/settings.env -f deploy/compose.yaml exec cert-manager cat /runtime/config.json`), then run `restart proxy` to load it. Saved `SHBVPN_KIND`, `SHBVPN_HOST`, and `SHBVPN_PORT` are tied to the `runtime` volume and cannot be changed in place. For a new address or port, make a backup, remove the old installation and its volumes, and create a new one. The old key will stop working.

To rebuild after a source update:

```bash
git pull --ff-only
docker compose --env-file deploy/settings.env -f deploy/compose.yaml up --build -d
```

For a backup, stop the containers and preserve **both** `runtime` and `certbot_state` volumes together using [Docker's volume backup procedure](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes). They hold configuration, credentials, private TLS material, and Certbot state. Protect the backup like a password. Keep `deploy/settings.env` as well; that file alone is not the connection key. Restore matching volumes with the same address and port.

Remove containers while **keeping state**:

```bash
docker compose --env-file deploy/settings.env -f deploy/compose.yaml down
```

Also remove volumes, **permanently deleting the key, certificate, and Certbot state**:

```bash
docker compose --env-file deploy/settings.env -f deploy/compose.yaml down -v
```

See [troubleshooting](../docs/troubleshooting.md) (Russian). Do not run the container and Ubuntu installations on the same host with the same ports.
