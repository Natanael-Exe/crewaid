#!/usr/bin/env python3
"""Run only inside the disposable privileged test container, never on the host."""
import json
import pathlib
import subprocess
import time

SCRIPT = pathlib.Path(__file__).parents[1] / 'host-uplink-firewall.sh'


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout


def probe(namespace, address, port, expected):
    # `None` is the host itself, whose connections arrive on `lo`.
    code = ('import socket,sys; s=socket.create_connection((sys.argv[1],int(sys.argv[2])),timeout=.4); '
            'assert s.recv(2)==b"ok"')
    prefix = [] if namespace is None else ['ip', 'netns', 'exec', namespace]
    reached = subprocess.run([*prefix, 'python3', '-c', code, address, str(port)],
                             capture_output=True).returncode == 0
    assert reached == expected, f'{namespace} -> {address}:{port}: reached={reached}, expected={expected}'


if not pathlib.Path('/crewaid-isolated-firewall-test').exists():
    raise SystemExit('Use the test Dockerfile: this probe creates network namespaces.')

# `wan` stands for the internet behind the uplink; `app` for a Dokploy
# container on a Docker bridge, whose published 3000 is DNATed as Docker does.
run('sysctl', '-w', 'net.ipv4.ip_forward=1')
run('ip', 'link', 'add', 'docker-test', 'type', 'bridge')
run('ip', 'addr', 'add', '172.31.0.1/24', 'dev', 'docker-test')
run('ip', 'link', 'set', 'docker-test', 'up')
for name, address, host in (('wan', '198.51.100.2', 'uplink0'), ('app', '172.31.0.2', 'app-host')):
    run('ip', 'netns', 'add', name)
    run('ip', 'link', 'add', host, 'type', 'veth', 'peer', 'name', name + '-eth')
    run('ip', 'link', 'set', name + '-eth', 'netns', name)
    run('ip', '-n', name, 'link', 'set', 'lo', 'up')
    run('ip', '-n', name, 'addr', 'add', address + '/24', 'dev', name + '-eth')
    run('ip', '-n', name, 'link', 'set', name + '-eth', 'up')
    if name == 'app':
        run('ip', 'link', 'set', host, 'master', 'docker-test')
        run('ip', '-n', name, 'route', 'add', 'default', 'via', '172.31.0.1')
    else:
        run('ip', 'addr', 'add', '198.51.100.1/24', 'dev', host)
        run('ip', '-n', name, 'route', 'add', 'default', 'via', '198.51.100.1')
    run('ip', 'link', 'set', host, 'up')
run('iptables', '-N', 'DOCKER-USER')
run('iptables', '-A', 'FORWARD', '-j', 'DOCKER-USER')
run('iptables', '-t', 'nat', '-A', 'PREROUTING', '-d', '198.51.100.1', '-p', 'tcp', '--dport', '3000',
    '-j', 'DNAT', '--to-destination', '172.31.0.2:3000')

listener = '''
import socket,sys,threading,time
def serve(port):
 s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
 s.bind(('0.0.0.0',port)); s.listen()
 while True:
  c,_=s.accept(); c.sendall(b'ok'); c.close()
for port in map(int,sys.argv[1:]): threading.Thread(target=serve,args=(port,),daemon=True).start()
time.sleep(60)
'''
processes = [subprocess.Popen(['python3', '-c', listener, '22', '2377', '7946']),
             subprocess.Popen(['ip', 'netns', 'exec', 'app', 'python3', '-c', listener, '3000'])]
try:
    time.sleep(.5)
    exposed = [('wan', '198.51.100.1', 2377), ('wan', '198.51.100.1', 7946), ('wan', '198.51.100.1', 3000)]
    kept = [('wan', '198.51.100.1', 22), (None, '198.51.100.1', 2377), ('app', '172.31.0.1', 2377),
            ('app', '172.31.0.1', 7946)]
    # Positive controls: every path is open before the script runs.
    for case in exposed + kept:
        probe(*case, True)
    for attempt in range(2):
        out = run('sh', str(SCRIPT), 'uplink0')
        for case in exposed:
            probe(*case, False)
        for case in kept:
            probe(*case, True)
    for binary in ('iptables', 'ip6tables'):
        assert run(binary, '-S', 'INPUT').count('-j CREWAID-UPLINK') == 1
        assert run(binary, '-S', 'DOCKER-USER').count('-j CREWAID-UPLINK-FWD') == 1
    udp = run('iptables', '-S', 'CREWAID-UPLINK')
    assert '-i uplink0 -p udp -m multiport --dports 4789,7946 -j DROP' in udp, udp
    print(json.dumps({'result': 'PASS', 'closed': [f'{p}' for _, _, p in exposed],
                      'kept': ['ssh on the uplink', 'loopback', 'containers'], 'idempotent_installs': 2}))
finally:
    for process in processes:
        process.terminate()
