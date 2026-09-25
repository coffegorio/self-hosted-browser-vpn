# Local smoke checks

Run from the repository root:

```sh
python3 tests/smoke_proxy.py
node --test tests/extension_routing.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

The proxy smoke check needs Python 3.9+, OpenSSL, curl, Go 1.22+, and outbound access
to `example.com:443`. It builds the server in a temporary directory, generates
a temporary TLS certificate and credentials, starts the proxy on a free local
port, and removes everything on exit. To use an existing server binary or a
different public test destination:

```sh
python3 tests/smoke_proxy.py --server-bin /absolute/path/to/server --public-target example.org:443
```

The script checks TLS certificate validation, Basic proxy authentication, an
authenticated public CONNECT and HTTPS page fetch through that tunnel, rejection of private, metadata, and configured proxy self destinations
for CONNECT and HTTP, and refusal of new connections after shutdown. The Node
test executes the extension's generated PAC script and verifies that selected
sites use a mandatory HTTPS proxy without a `DIRECT` fallback.

These local checks cannot prove that a particular VPS installation works from
Chrome on a particular network. That requires the manual browser and external
IP checks in `docs/architecture.md`.

The Python unit tests cover public-address validation, installer credentials and
TLS helpers, UFW rule detection, container entrypoints, and certificate-manager
state. They use temporary fixtures and do not install services or request real
certificates. See [development checks](../docs/development.md) for the Go race
tests, extension tests, and Docker image builds.
