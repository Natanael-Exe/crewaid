import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import profiles
import seats


class ProfileLifecycleTests(unittest.TestCase):
    def test_retirement_is_deferred_and_reaping_preserves_other_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            chrome = home / '.chrome'
            for name in ('bot-a', 'bot-b', 'Default'):
                (chrome / name).mkdir(parents=True)
                (chrome / name / 'Cookies').write_text(name)
            state = {'profile': {'info_cache': {p: {} for p in ('bot-a', 'bot-b', 'Default')},
                                 'last_used': 'bot-a', 'last_active_profiles': ['bot-a', 'bot-b']},
                     'unrelated': 123}
            (chrome / 'Local State').write_text(json.dumps(state))
            profiles.retire(home, 'bot-a')
            self.assertTrue((chrome / 'bot-a' / 'Cookies').exists())
            # D-060 moved a seat's browser onto its own `--user-data-dir`, but
            # the retirement tombstone stays at `<home>/.crewaid-deleted-profiles`
            # where `profiles.reap` and `workspace-paths.ts` both look for it.
            with mock.patch.object(seats, 'MACHINE_HOME', home):
                with self.assertRaises(seats.SeatError):
                    seats.profile_for('bot-a')
            profiles.reap(home)
            profiles.reap(home)
            self.assertFalse((chrome / 'bot-a').exists())
            self.assertEqual((chrome / 'bot-b' / 'Cookies').read_text(), 'bot-b')
            self.assertTrue((chrome / 'Default').exists())
            actual = json.loads((chrome / 'Local State').read_text())
            self.assertNotIn('bot-a', actual['profile']['info_cache'])
            self.assertEqual(actual['profile']['last_used'], 'Default')
            self.assertEqual(actual['profile']['last_active_profiles'], ['bot-b'])
            self.assertEqual(actual['unrelated'], 123)

    def test_invalid_names_and_symlinks_cannot_redirect_retirement(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            for name in ('../escape', '.', 'Default', 'bad/name', 'a\n'):
                with self.assertRaises(ValueError):
                    profiles.retire(home, name)
            outside = home / 'outside'
            outside.mkdir()
            (home / profiles.DELETED).symlink_to(outside)
            with self.assertRaises(ValueError):
                profiles.retire(home, 'bot-a')
            self.assertEqual(list(outside.iterdir()), [])

    def test_reaper_unlinks_profile_symlinks_without_following_them(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            outside = home / 'outside'
            outside.mkdir()
            (outside / 'keep').write_text('safe')
            (home / '.chrome').mkdir()
            (home / '.chrome' / 'bot-a').symlink_to(outside)
            profiles.retire(home, 'bot-a')
            profiles.reap(home)
            self.assertEqual((outside / 'keep').read_text(), 'safe')


class SeatCapacityTests(unittest.TestCase):
    def test_capacity_counts_threads_and_memory_before_launching_chrome(self):
        for resource in ('pids', 'memory'):
            with self.subTest(resource=resource), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for name in ('pids', 'memory'):
                    (root / f'{name}.max').write_text('512' if name == resource else 'max')
                    (root / f'{name}.current').write_text('500')
                with self.assertRaisesRegex(seats.SeatError, resource):
                    seats._check_capacity(root)

    def test_capacity_refusal_does_not_start_a_desktop(self):
        # Admission runs before anything is spawned, so a refused seat leaves
        # no X server, no browser and no VNC behind. `_start` is the whole of
        # what a seat costs (D-060), which makes it the one thing to assert
        # was never reached.
        with mock.patch.object(seats, '_check_capacity', side_effect=seats.SeatError('full')), \
             mock.patch.object(seats.SeatRegistry, '_start') as start:
            with self.assertRaisesRegex(seats.SeatError, 'full'):
                seats.SeatRegistry().create(bot_id='bot-a')
            start.assert_not_called()

class DisplayProfileRetirementTests(unittest.TestCase):
    def test_reaps_new_seat_storage_and_preserves_other_identities(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            for profile in ('bot-a', 'bot-b', 'company-google'):
                path = home / '.seats' / profile / 'Default'
                path.mkdir(parents=True)
                (path / 'Cookies').write_text(profile)
            profiles.retire(home, 'bot-a')
            profiles.reap(home)
            profiles.reap(home)
            self.assertFalse((home / '.seats' / 'bot-a').exists())
            for profile in ('bot-b', 'company-google'):
                self.assertEqual((home / '.seats' / profile / 'Default' / 'Cookies').read_text(), profile)

    def test_seat_symlinks_do_not_erase_external_data(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            outside = home / 'outside'
            outside.mkdir()
            (outside / 'keep').write_text('safe')
            (home / '.seats').mkdir()
            (home / '.seats' / 'bot-a').symlink_to(outside)
            profiles.retire(home, 'bot-a')
            profiles.reap(home)
            self.assertFalse((home / '.seats' / 'bot-a').is_symlink())
            self.assertEqual((outside / 'keep').read_text(), 'safe')

class DisplayProfileMigrationTests(unittest.TestCase):
    def test_migration_preserves_sessions_and_encryption_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            chrome = home / '.chrome'
            for name in ('bot-a', 'company-google', 'Default'):
                source = chrome / name
                source.mkdir(parents=True)
                (source / 'Preferences').write_text('{}')
                (source / 'Cookies').write_bytes(b'cookie database')
            (chrome / 'Local State').write_text(json.dumps({
                'os_crypt': {'encrypted_key': 'test-key'},
                'profile': {'last_used': 'bot-a', 'info_cache': {'bot-a': {'name': 'A'}}}}))
            profiles.migrate(home)
            profiles.migrate(home)
            for name in ('bot-a', 'company-google'):
                target = home / '.seats' / name
                self.assertEqual((target / 'Default' / 'Cookies').read_bytes(), b'cookie database')
                state = json.loads((target / 'Local State').read_text())
                self.assertEqual(state['os_crypt']['encrypted_key'], 'test-key')
                self.assertEqual(state['profile']['last_used'], 'Default')
                self.assertFalse((chrome / name).exists())
            self.assertTrue((chrome / 'Default').exists())

    def test_migration_never_overwrites_an_existing_seat(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            source = home / '.chrome' / 'bot-a'
            source.mkdir(parents=True)
            (source / 'Preferences').write_text('{}')
            target = home / '.seats' / 'bot-a' / 'Default'
            target.mkdir(parents=True)
            (target / 'Cookies').write_text('current')
            profiles.migrate(home)
            self.assertEqual((target / 'Cookies').read_text(), 'current')
            self.assertTrue(source.exists())
