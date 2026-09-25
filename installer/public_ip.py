"""Validate public IP literals consistently with the proxy's destination guard."""

import ipaddress


_BLOCKED_RANGES = tuple(
    ipaddress.ip_network(network)
    for network in (
        "0.0.0.0/8",
        "100.64.0.0/10",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "240.0.0.0/4",
        "2001::/23",
        "2001:db8::/32",
        "2002::/16",
    )
)
_PUBLIC_IPV6 = ipaddress.ip_network("2000::/3")


def is_public_ip(value: str) -> bool:
    if not isinstance(value, str):
        return False
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        # Python accepts scope IDs (including newlines) on global IPv6 literals;
        # Go rejects zones and systemd would parse them in ExecStart=.
        if address.scope_id is not None:
            return False
        if address.ipv4_mapped is not None:
            address = address.ipv4_mapped
    if not address.is_global or address.is_multicast:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address not in _PUBLIC_IPV6:
        return False
    return not any(address in network for network in _BLOCKED_RANGES)
