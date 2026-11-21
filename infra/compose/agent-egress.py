#!/usr/bin/env python3
"""Install the sandbox firewall in the Docker daemon's Linux host namespace."""
import argparse
import fcntl
import json
import ipaddress
import os
import re
import subprocess

DENIED = ('0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
          '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16',
          '224.0.0.0/4', '240.0.0.0/4')


def run(*args, **kwargs):
    try:
        return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout
    except subprocess.CalledProcessError as error:
        # Preserve nested installer diagnostics in CI and the systemd journal.
        # CalledProcessError's default traceback omits captured stderr.
        raise RuntimeError(f'{args[0]} exited {error.returncode}: {error.stderr.strip()}') from error


def rules(chain, ipv6=False, subnets=(), trusted=()):
    lines = [f':{chain} - [0:0]', f'-F {chain}']
    # Only replies to connections initiated outside the sandbox bypass egress
    # restrictions. An already established sandbox-originated flow must not.
    lines += [f'-A {chain} -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j RETURN']
    # A trusted source sits ON the bridge (D-155: the self-hosted orchestrator
    # reaches computers directly instead of through published ports), so its
    # own packets arrive here too; they are not a sandbox's and are not fenced.
    # Sandboxes run without capabilities, so they cannot claim its address.
    lines += [f'-A {chain} -s {address} -j RETURN' for address in trusted]
    if not ipv6:
        lines += [f'-A {chain} -m addrtype --dst-type LOCAL -j DROP']
        lines += [f'-A {chain} -d {cidr} -j DROP' for cidr in (*DENIED, *subnets)]
        lines += [f'-A {chain} -p tcp -m multiport --dports 80,443 '
                  '-m conntrack --ctstate NEW,ESTABLISHED --ctdir ORIGINAL -j RETURN']
    lines += [f'-A {chain} -j DROP']
    return '\n'.join(['*mangle', *lines, 'COMMIT', ''])


def ingress_rules(chain, control=None, trusted=()):
    # Docker DNATs a port published on a host address for packets arriving on
    # any interface but a Docker bridge: a neighbour on the provider's LAN
    # routing to that address reaches an unauthenticated screen and DevTools
    # port. Naming the control interface makes it the only way in; the
    # bridges' own path, through docker-proxy, is `control_rules`'.
    # Without one the chain is empty, so a remote control plane (Stage 1) and a
    # host-process orchestrator keep working, and dropping the flag reverts.
    # A trusted source on the bridge itself is the other way in (D-155): with
    # nothing published, the orchestrator opens connections straight to a
    # computer's address, and nothing else may.
    lines = [f':{chain} - [0:0]', f'-F {chain}']
    if control is not None or trusted:
        if control is not None:
            lines += [f'-A {chain} -i {control} -j RETURN']
        lines += [f'-A {chain} -s {address} -j RETURN' for address in trusted]
        lines += [f'-A {chain} -m conntrack --ctstate NEW -j DROP']
    return '\n'.join(['*mangle', *lines, 'COMMIT', ''])


def control_rules(chain, control=None, addresses=()):
    # The ingress chain only sees packets Docker DNATs. A container on another
    # Docker bridge is exempt from that DNAT (Docker RETURNs every bridge's own
    # traffic to its userland proxy), so its connection to a published port
    # ends at docker-proxy, a host process that dials the sandbox itself and
    # never crosses FORWARD. Refusing it on INPUT, at the published address,
    # closes that path; the host's own processes arrive on `lo` and keep it.
    lines = [f':{chain} - [0:0]', f'-F {chain}']
    if control is not None:
        lines += [f'-A {chain} -i lo -j RETURN', f'-A {chain} -i {control} -j RETURN']
        lines += [f'-A {chain} -d {address} -m conntrack --ctstate NEW -j DROP'
                  for address in addresses]
    return '\n'.join(['*mangle', *lines, 'COMMIT', ''])


def interface_addresses(name, ipv6):
    # Link-local addresses are reachable only from the interface's own link,
    # which is the control plane; publishing uses the global one.
    found = json.loads(run('ip', '-j', '-6' if ipv6 else '-4', 'address', 'show', 'dev', name))
    return tuple(addr['local'] for interface in found for addr in interface['addr_info']
                 if addr.get('scope', 'global') != 'link'
                 and ipaddress.ip_address(addr['local']).version == (6 if ipv6 else 4))


def valid_interface(name):
    return re.fullmatch(r'[a-zA-Z0-9_.-]{1,15}', name) is not None


def install(bridge, control=None, trusted=()):
    if not valid_interface(bridge):
        raise ValueError('invalid Linux bridge interface name')
    if control is not None and not valid_interface(control):
        raise ValueError('invalid control interface name')
    # Parsed, not interpolated: an address goes straight into a rule.
    trusted = tuple(str(ipaddress.IPv4Address(address)) for address in trusted)
    if not os.path.isdir(f'/sys/class/net/{bridge}/bridge'):
        raise ValueError(f'{bridge} is not a Linux bridge on this host')
    # Bridge packets must traverse netfilter, including same-subnet peer traffic.
    if not os.path.exists('/proc/sys/net/bridge/bridge-nf-call-iptables'):
        run('modprobe', 'br_netfilter')
    for family in ('iptables', 'ip6tables'):
        run('sysctl', '-w', f'net.bridge.bridge-nf-call-{family}=1')
    # Scope chains to the bridge; never flush Docker's or another deployment's rules.
    chain = 'CREWAID-' + bridge
    ingress = 'CREWAID-IN-' + bridge
    published = 'CREWAID-CTL-' + bridge
    addresses = json.loads(run('ip', '-j', '-4', 'address', 'show', 'dev', bridge))
    subnets = tuple(str(ipaddress.ip_network(f"{addr['local']}/{addr['prefixlen']}", strict=False))
                    for interface in addresses for addr in interface['addr_info'])
    for binary, ipv6 in (('iptables', False), ('ip6tables', True)):
        gateways = () if control is None else interface_addresses(control, ipv6)
        # Trusted sources are IPv4 (the bridge's own addresses); IPv6 keeps
        # its blanket drop.
        sources = () if ipv6 else trusted
        run(binary + '-restore', '--wait', '10', '--noflush',
            input=rules(chain, ipv6, subnets, sources))
        run(binary + '-restore', '--wait', '10', '--noflush',
            input=ingress_rules(ingress, control, sources))
        run(binary + '-restore', '--wait', '10', '--noflush',
            input=control_rules(published, control, gateways))
        # FORWARD sees the packet after Docker's DNAT, so `-o bridge` catches a
        # connection to a published port whatever address it was aimed at.
        # INPUT sees the same connection when docker-proxy answers it instead.
        for hook in (('PREROUTING', '-i', bridge, '-j', chain),
                     ('FORWARD', '-o', bridge, '-j', ingress),
                     ('INPUT', '-j', published)):
            check = subprocess.run((binary, '-w', '10', '-t', 'mangle', '-C', *hook),
                                   capture_output=True)
            if check.returncode:
                run(binary, '-w', '10', '-t', 'mangle', '-I', *hook)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--network', default='agent-net')
    parser.add_argument('--bridge', help='explicit local bridge (namespace tests)')
    parser.add_argument('--control-interface',
                        help='the only interface allowed to open connections into the sandbox '
                             'bridge (the orchestrator\'s bridge or tunnel); unset allows any')
    parser.add_argument('--trusted-source', action='append', default=[],
                        help='an IPv4 address ON the sandbox bridge that may open connections '
                             'into it and is not itself fenced (the orchestrator); repeatable')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('run as root on the Linux Docker daemon host')
    # Serialize discovery and atomic chain replacements across concurrent starts.
    with open('/run/crewaid-agent-egress.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        bridge = args.bridge
        if bridge is None:
            info = json.loads(run('docker', 'network', 'inspect', args.network))[0]
            if info['Driver'] != 'bridge':
                raise ValueError('sandbox network must use the bridge driver')
            bridge = (info.get('Options') or {}).get('com.docker.network.bridge.name')
            bridge = bridge or 'br-' + info['Id'][:12]
        install(bridge, args.control_interface, args.trusted_source)


if __name__ == '__main__':
    main()
