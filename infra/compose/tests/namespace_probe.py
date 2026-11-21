#!/usr/bin/env python3
"""Run only inside the disposable privileged test container, never on the host."""
import importlib.util
import json
import pathlib
import subprocess
import time

spec = importlib.util.spec_from_file_location('egress', pathlib.Path(__file__).parents[1] / 'agent-egress.py')
egress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(egress)
run = egress.run


def ip(*args):
    run('ip', *args)


def probe(namespace, address, port, expected):
    # `None` is the host itself, whose connections arrive on `lo`.
    code = ('import socket,sys; s=socket.socket(socket.AF_INET6 if ":" in sys.argv[1] else socket.AF_INET); '
            's.settimeout(.4); s.connect((sys.argv[1],int(sys.argv[2]))); '
            'assert s.recv(2)==b"ok"')
    prefix = [] if namespace is None else ['ip', 'netns', 'exec', namespace]
    result = subprocess.run([*prefix, 'python3', '-c', code, address, str(port)],
                            capture_output=True)
    reached = result.returncode == 0
    assert reached == expected, f'{namespace} -> {address}:{port}: reached={reached}, expected={expected}: {result.stderr.decode()}'


if not pathlib.Path('/crewaid-isolated-firewall-test').exists():
    raise SystemExit('Use the test Dockerfile: this probe creates network namespaces.')

ip('link', 'add', 'agent-test', 'type', 'bridge')
ip('addr', 'add', '172.30.0.1/24', 'dev', 'agent-test')
ip('link', 'set', 'agent-test', 'up')
ip('addr', 'add', '198.51.100.1/24', 'dev', 'agent-test')
run('sysctl', '-w', 'net.ipv4.ip_forward=1')
for name, address in [('bot', '172.30.0.2'), ('peer', '172.30.0.3'), ('wan', '93.184.216.2'),
                      ('ctl', '203.0.113.2')]:
    ip('netns', 'add', name)
    ip('link', 'add', name + '-host', 'type', 'veth', 'peer', 'name', name + '-eth')
    ip('link', 'set', name + '-eth', 'netns', name)
    ip('-n', name, 'link', 'set', 'lo', 'up')
    ip('-n', name, 'addr', 'add', address + '/24', 'dev', name + '-eth')
    ip('-n', name, 'link', 'set', name + '-eth', 'up')
    if name in ('bot', 'peer'):
        ip('link', 'set', name + '-host', 'master', 'agent-test')
        ip('-n', name, 'route', 'add', 'default', 'via', '172.30.0.1')
    else:
        gateway = address.rsplit('.', 1)[0] + '.1'
        ip('addr', 'add', gateway + '/24', 'dev', name + '-host')
        ip('-n', name, 'route', 'add', 'default', 'via', gateway)
    ip('link', 'set', name + '-host', 'up')

for destination in ('10.1.1.1', '192.168.1.1', '169.254.169.254'):
    ip('-n', 'wan', 'addr', 'add', destination + '/32', 'dev', 'lo')
    ip('route', 'add', destination + '/32', 'via', '93.184.216.2')

ip('-n', 'bot', 'addr', 'add', '198.51.100.2/24', 'dev', 'bot-eth')
ip('-n', 'peer', 'addr', 'add', '198.51.100.3/24', 'dev', 'peer-eth')
ip('-n', 'bot', '-6', 'addr', 'add', 'fd00::2/64', 'dev', 'bot-eth', 'nodad')
ip('-n', 'peer', '-6', 'addr', 'add', 'fd00::3/64', 'dev', 'peer-eth', 'nodad')
listener = '''
import socket,threading,time

def echo(c):
 try:
  c.sendall(b'ok')
  while data:=c.recv(2): c.sendall(data)
 except OSError: pass
 finally: c.close()

def listen(port,family):
 s=socket.socket(family); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
 if family==socket.AF_INET6: s.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
 s.bind(('::' if family==socket.AF_INET6 else '0.0.0.0',port)); s.listen()
 while True:
  c,_=s.accept(); threading.Thread(target=echo,args=(c,),daemon=True).start()
for port in (22,53,80,443,5432,6379,5900,9222,8080):
 for family in (socket.AF_INET,socket.AF_INET6):
  threading.Thread(target=listen,args=(port,family),daemon=True).start()
time.sleep(120)
'''
# Docker's userland proxy: a host process on the published address that dials
# the sandbox itself. Docker sends every bridge's own traffic here instead of
# DNATing it, so this connection never crosses FORWARD.
relay = '''
import socket,threading

def pump(a,b):
 try:
  while data:=a.recv(4096): b.sendall(data)
 except OSError: pass
 finally:
  for s in (a,b):
   try: s.shutdown(socket.SHUT_RDWR)
   except OSError: pass

s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(('203.0.113.1',15901)); s.listen()
while True:
 c,_=s.accept()
 try: u=socket.create_connection(('172.30.0.2',5900),timeout=1)
 except OSError:
  c.close(); continue
 for a,b in ((c,u),(u,c)): threading.Thread(target=pump,args=(a,b),daemon=True).start()
'''
processes = [subprocess.Popen(['python3', '-c', listener]),
             subprocess.Popen(['python3', '-c', relay])]
processes += [subprocess.Popen(['ip', 'netns', 'exec', name, 'python3', '-c', listener])
              for name in ('bot', 'peer', 'wan')]
try:
    time.sleep(.5)
    # Positive controls prove that a timeout after installation is the firewall,
    # not an absent service, broken route, or failed namespace setup.
    cases = [('172.30.0.1', 5432), ('172.30.0.1', 6379), ('172.30.0.1', 80),
             ('172.30.0.3', 80), ('172.30.0.3', 5900), ('172.30.0.3', 9222),
             ('172.30.0.3', 8080), ('93.184.216.2', 22), ('93.184.216.2', 53),
             ('fd00::3', 80), ('198.51.100.3', 443), ('10.1.1.1', 443),
             ('192.168.1.1', 443), ('169.254.169.254', 80)]
    for address, port in cases:
        probe('bot', address, port, True)
    # Docker-like DNAT of a gateway port into a different container.
    run('iptables', '-t', 'nat', '-A', 'PREROUTING', '-d', '172.30.0.1', '-p', 'tcp',
        '--dport', '15432', '-j', 'DNAT', '--to-destination', '93.184.216.2:5432')
    probe('bot', '172.30.0.1', 15432, True)
    established = subprocess.Popen(['ip', 'netns', 'exec', 'bot', 'python3', '-u', '-c', '''
import socket,sys
s=socket.create_connection(('93.184.216.2',22)); assert s.recv(2)==b'ok'
print('ready',flush=True); sys.stdin.readline(); s.settimeout(.5); s.sendall(b'hi')
try: s.recv(2)
except socket.timeout: sys.exit(0)
sys.exit(1)
'''], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    processes.append(established)
    assert established.stdout.readline().strip() == 'ready'
    for attempt in range(2):
        run('python3', str(pathlib.Path(__file__).parents[1] / 'agent-egress.py'),
            '--bridge', 'agent-test')
        if attempt == 0:
            established.stdin.write('check\n'); established.stdin.flush()
            assert established.wait(timeout=3) == 0, 'existing forbidden flow bypassed policy'
        for address, port in cases + [('172.30.0.1', 15432)]:
            probe('bot', address, port, False)
        probe('bot', '93.184.216.2', 80, True)
        probe('bot', '93.184.216.2', 443, True)
        # An incoming control connection still gets the sandbox's reply.
        probe('wan', '172.30.0.2', 8080, True)
    # A sandbox port published on the gateway, DNATed as Docker does for a
    # packet arriving on any interface. Without a control interface both the
    # outside host and the control plane reach it.
    run('iptables', '-t', 'nat', '-A', 'PREROUTING', '-d', '172.30.0.1', '-p', 'tcp',
        '--dport', '15900', '-j', 'DNAT', '--to-destination', '172.30.0.2:5900')
    for namespace in ('wan', 'ctl'):
        probe(namespace, '172.30.0.1', 15900, True)
        probe(namespace, '172.30.0.2', 8080, True)
    # The same port answered by the userland proxy on the control gateway.
    for namespace in ('wan', 'ctl', None):
        probe(namespace, '203.0.113.1', 15901, True)
    for attempt in range(2):
        run('python3', str(pathlib.Path(__file__).parents[1] / 'agent-egress.py'),
            '--bridge', 'agent-test', '--control-interface', 'ctl-host')
        probe('wan', '172.30.0.1', 15900, False)
        probe('wan', '172.30.0.2', 8080, False)
        probe('ctl', '172.30.0.1', 15900, True)
        probe('ctl', '172.30.0.2', 8080, True)
        probe('wan', '203.0.113.1', 15901, False)
        probe('ctl', '203.0.113.1', 15901, True)
        probe(None, '203.0.113.1', 15901, True)
        # Replies to the sandbox's own public traffic still come back in.
        probe('bot', '93.184.216.2', 443, True)
        probe('bot', '10.1.1.1', 443, False)
    # D-155: a trusted source ON the bridge — the self-hosted orchestrator,
    # which reaches computers directly with nothing published. It may open
    # connections into a sandbox and its own traffic is not fenced; the
    # sandbox still cannot reach it, and nobody else can reach the sandbox.
    for attempt in range(2):
        run('python3', str(pathlib.Path(__file__).parents[1] / 'agent-egress.py'),
            '--bridge', 'agent-test', '--trusted-source', '172.30.0.3')
        probe('peer', '172.30.0.2', 5900, True)
        probe('peer', '172.30.0.2', 9222, True)
        probe('peer', '93.184.216.2', 22, True)
        probe('peer', '172.30.0.1', 5432, True)
        probe('bot', '172.30.0.3', 80, False)
        probe('bot', '172.30.0.3', 5900, False)
        probe('wan', '172.30.0.2', 8080, False)
        probe('bot', '93.184.216.2', 443, True)
        probe('bot', '10.1.1.1', 443, False)
    # Dropping the flag reverts to any control path.
    run('python3', str(pathlib.Path(__file__).parents[1] / 'agent-egress.py'),
        '--bridge', 'agent-test')
    probe('wan', '172.30.0.2', 8080, True)
    probe('wan', '203.0.113.1', 15901, True)
    for binary in ('iptables', 'ip6tables'):
        saved = run(binary, '-t', 'mangle', '-S', 'PREROUTING')
        assert saved.count('-i agent-test -j CREWAID-agent-test') == 1, saved
        saved = run(binary, '-t', 'mangle', '-S', 'FORWARD')
        assert saved.count('-o agent-test -j CREWAID-IN-agent-test') == 1, saved
        saved = run(binary, '-t', 'mangle', '-S', 'INPUT')
        assert saved.count('-j CREWAID-CTL-agent-test') == 1, saved
    print(json.dumps({'result': 'PASS', 'blocked_paths': len(cases) + 1,
                      'allowed': ['public HTTP', 'public HTTPS', 'control replies'],
                      'control_interface_only': ['published gateway port', 'userland proxy', 'direct'],
                      'trusted_source': ['opens into a sandbox', 'unfenced itself', 'unreachable from a sandbox'],
                      'idempotent_installs': 2}))
finally:
    for process in processes:
        process.terminate()
    for process in processes:
        process.wait()
