"""Fast policy tests; the namespace suite exercises the actual kernel rules."""
import importlib.util
import pathlib
import unittest
from unittest import mock
import subprocess

spec = importlib.util.spec_from_file_location('egress', pathlib.Path(__file__).parents[1] / 'agent-egress.py')
egress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(egress)


class PolicyTests(unittest.TestCase):
    def test_private_destinations_precede_web_allow(self):
        policy = egress.rules('TEST')
        for cidr in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'):
            self.assertLess(policy.index(f'-d {cidr} -j DROP'), policy.index('--dports 80,443'))
        self.assertIn('--dst-type LOCAL -j DROP', policy)
        self.assertTrue(policy.endswith('-A TEST -j DROP\nCOMMIT\n'))

    def test_only_reply_direction_bypasses_destination_checks(self):
        policy = egress.rules('TEST')
        self.assertIn('--ctstate ESTABLISHED --ctdir REPLY -j RETURN', policy)
        self.assertNotIn('--ctstate ESTABLISHED,RELATED', policy)
        self.assertIn('--ctstate NEW,ESTABLISHED --ctdir ORIGINAL', policy)

    def test_command_failures_include_captured_stderr(self):
        error = subprocess.CalledProcessError(1, ['modprobe', 'br_netfilter'],
                                              stderr='module not found\n')
        with mock.patch.object(egress.subprocess, 'run', side_effect=error):
            with self.assertRaisesRegex(RuntimeError, 'modprobe exited 1: module not found'):
                egress.run('modprobe', 'br_netfilter')

    def test_invalid_bridge_is_rejected_before_running_commands(self):
        with mock.patch.object(egress, 'run') as command:
            with self.assertRaises(ValueError):
                egress.install('bridge;id')
            command.assert_not_called()

    def test_failed_rule_restore_never_attaches_an_empty_chain(self):
        commands = []

        def command(*args, **kwargs):
            commands.append(args)
            if args[0] == 'ip':
                return '[{"addr_info": [{"local": "172.30.0.1", "prefixlen": 24}]}]'
            if args[0] == 'iptables-restore':
                raise subprocess.CalledProcessError(1, args)
            return ''

        with mock.patch.object(egress.os.path, 'isdir', return_value=True), \
             mock.patch.object(egress.os.path, 'exists', return_value=True), \
             mock.patch.object(egress, 'run', side_effect=command):
            with self.assertRaises(subprocess.CalledProcessError):
                egress.install('agent-test')
        self.assertFalse(any('-I' in args for args in commands))

    def test_control_interface_is_the_only_way_into_the_bridge(self):
        policy = egress.ingress_rules('IN', 'crewaid-ctl0')
        self.assertLess(policy.index('-A IN -i crewaid-ctl0 -j RETURN'),
                        policy.index('-A IN -m conntrack --ctstate NEW -j DROP'))
        self.assertEqual(policy.count('-A IN'), 2)

    def test_without_a_control_interface_the_ingress_chain_is_emptied(self):
        policy = egress.ingress_rules('IN')
        self.assertIn('-F IN', policy)
        self.assertNotIn('-A IN', policy)

    def test_a_trusted_source_on_the_bridge_is_not_fenced_and_comes_before_every_drop(self):
        # D-155: the self-hosted orchestrator sits on the sandbox bridge.
        policy = egress.rules('TEST', trusted=('10.231.0.2',))
        self.assertLess(policy.index('-A TEST -s 10.231.0.2 -j RETURN'),
                        policy.index('--dst-type LOCAL -j DROP'))
        self.assertLess(policy.index('--ctdir REPLY -j RETURN'),
                        policy.index('-A TEST -s 10.231.0.2 -j RETURN'))
        self.assertNotIn('-s ', egress.rules('TEST'))

    def test_a_trusted_source_is_the_only_way_into_the_bridge_without_a_control_interface(self):
        policy = egress.ingress_rules('IN', trusted=('10.231.0.2',))
        self.assertLess(policy.index('-A IN -s 10.231.0.2 -j RETURN'),
                        policy.index('-A IN -m conntrack --ctstate NEW -j DROP'))
        self.assertEqual(policy.count('-A IN'), 2)
        both = egress.ingress_rules('IN', 'crewaid-ctl0', ('10.231.0.2',))
        self.assertEqual(both.count('-j RETURN'), 2)

    def test_an_invalid_trusted_source_is_rejected_before_running_commands(self):
        for address in ('10.0.0.2; id', '10.0.0.0/8', 'fd00::2', 'host'):
            with mock.patch.object(egress, 'run') as command:
                with self.assertRaises(ValueError):
                    egress.install('agent-test', None, (address,))
                command.assert_not_called()

    def test_invalid_control_interface_is_rejected_before_running_commands(self):
        with mock.patch.object(egress, 'run') as command:
            with self.assertRaises(ValueError):
                egress.install('agent-test', 'ctl;id')
            command.assert_not_called()

    def test_ingress_hook_follows_dnat_on_the_bridge(self):
        commands = []

        def command(*args, **kwargs):
            commands.append(args)
            if args[0] == 'ip':
                return '[{"addr_info": [{"local": "172.30.0.1", "prefixlen": 24}]}]'
            return ''

        absent = subprocess.CompletedProcess((), 1)
        with mock.patch.object(egress.os.path, 'isdir', return_value=True), \
             mock.patch.object(egress.os.path, 'exists', return_value=True), \
             mock.patch.object(egress.subprocess, 'run', return_value=absent), \
             mock.patch.object(egress, 'run', side_effect=command):
            egress.install('agent-test', 'crewaid-ctl0')
        for binary in ('iptables', 'ip6tables'):
            self.assertIn((binary, '-w', '10', '-t', 'mangle', '-I', 'FORWARD',
                           '-o', 'agent-test', '-j', 'CREWAID-IN-agent-test'), commands)
            self.assertIn((binary, '-w', '10', '-t', 'mangle', '-I', 'INPUT',
                           '-j', 'CREWAID-CTL-agent-test'), commands)
        self.assertIn(('ip', '-j', '-4', 'address', 'show', 'dev', 'crewaid-ctl0'), commands)

    def test_published_address_admits_only_the_control_interface_and_the_host(self):
        policy = egress.control_rules('CTL', 'crewaid-ctl0', ('172.20.0.1',))
        drop = policy.index('-A CTL -d 172.20.0.1 -m conntrack --ctstate NEW -j DROP')
        self.assertLess(policy.index('-A CTL -i lo -j RETURN'), drop)
        self.assertLess(policy.index('-A CTL -i crewaid-ctl0 -j RETURN'), drop)
        self.assertEqual(policy.count('-A CTL'), 3)

    def test_without_a_control_interface_the_published_chain_is_emptied(self):
        policy = egress.control_rules('CTL', None, ('172.20.0.1',))
        self.assertIn('-F CTL', policy)
        self.assertNotIn('-A CTL', policy)

    def test_published_addresses_skip_link_local_and_the_other_family(self):
        listing = ('[{"addr_info": [{"local": "172.20.0.1", "scope": "global"},'
                   ' {"local": "fe80::1", "scope": "link"}, {"local": "fd00::1", "scope": "global"}]}]')
        with mock.patch.object(egress, 'run', return_value=listing):
            self.assertEqual(egress.interface_addresses('crewaid-ctl0', False), ('172.20.0.1',))
            self.assertEqual(egress.interface_addresses('crewaid-ctl0', True), ('fd00::1',))

    def test_ipv6_cannot_bypass_ipv4_policy(self):
        policy = egress.rules('TEST', True)
        self.assertNotIn('--dports', policy)
        self.assertEqual(policy.count('-j RETURN'), 1)
        self.assertIn('-A TEST -j DROP', policy)


if __name__ == '__main__':
    unittest.main()
