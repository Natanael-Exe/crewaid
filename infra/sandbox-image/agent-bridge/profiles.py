#!/usr/bin/env python3
"""Retire profiles durably; erase them only before the browser starts."""
import json
import os
from pathlib import Path
import re
import shutil
import sys

DELETED = '.crewaid-deleted-profiles'


def validate(profile: str) -> None:
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', profile) or profile == 'Default':
        raise ValueError('invalid bot profile')


def marker(home: Path, profile: str) -> Path:
    validate(profile)
    return home / DELETED / profile


def retire(home: Path, profile: str) -> None:
    target = marker(home, profile)
    target.parent.mkdir(mode=0o700, exist_ok=True)
    if target.parent.is_symlink():
        raise ValueError('profile retirement directory is a symlink')
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def reap(home: Path) -> None:
    pending = home / DELETED
    if not pending.exists():
        return
    chrome = home / '.chrome'
    seats = home / '.seats'
    if seats.is_symlink():
        raise ValueError('seat profile storage must not be a symlink')
    if pending.is_symlink() or chrome.is_symlink():
        raise ValueError('profile storage must not be a symlink')
    retired = [entry.name for entry in pending.iterdir()]
    for profile in retired:
        validate(profile)
        for path in (chrome / profile, seats / profile):
            if path.is_symlink():
                path.unlink()
            elif path.exists():
                shutil.rmtree(path)
    state = chrome / 'Local State'
    if state.is_symlink():
        raise ValueError('Chrome Local State must not be a symlink')
    if state.exists():
        data = json.loads(state.read_text())
        profiles = data.get('profile', {})
        cache = profiles.get('info_cache', {})
        for profile in retired:
            cache.pop(profile, None)
        if profiles.get('last_used') in retired:
            profiles['last_used'] = 'Default'
        if 'last_active_profiles' in profiles:
            profiles['last_active_profiles'] = [
                p for p in profiles['last_active_profiles'] if p not in retired
            ]
        # Atomic replacement: an interrupted boot must not truncate Local State.
        temporary = chrome / '.crewaid-local-state.tmp'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(data, out)
            out.flush()
            os.fsync(out.fileno())
        temporary.replace(state)
    # Keep tombstones: a delayed allocation must never recreate a deleted bot.




def migrate(home: Path) -> None:
    """Move legacy bot/identity profiles before any browser has opened them.

    Chrome's Local State contains the encryption metadata for profile cookies.
    Moving only a profile directory would leave existing logins unreadable.
    Existing display-seat profiles always win; never merge two cookie jars.
    """
    chrome = home / '.chrome'
    seats = home / '.seats'
    if chrome.is_symlink() or seats.is_symlink():
        raise ValueError('profile storage must not be a symlink')
    if not chrome.exists():
        return
    state = chrome / 'Local State'
    if state.is_symlink():
        raise ValueError('Chrome Local State must not be a symlink')
    for profile in chrome.iterdir():
        if profile.name == 'Default' or not profile.is_dir():
            continue
        # Chrome also stores caches beside profiles. Preferences identifies a
        # profile without treating every cache directory as a browser identity.
        if not (profile / 'Preferences').is_file():
            continue
        validate(profile.name)
        if profile.is_symlink():
            raise ValueError('legacy profile must not be a symlink')
        if marker(home, profile.name).exists():
            continue
        destination = seats / profile.name
        if destination.is_symlink():
            raise ValueError('seat profile must not be a symlink')
        target = destination / 'Default'
        if target.exists() or target.is_symlink():
            continue
        destination.mkdir(mode=0o700, parents=True, exist_ok=True)
        target_state = destination / 'Local State'
        if target_state.is_symlink():
            raise ValueError('seat Local State must not be a symlink')
        if state.exists():
            data = json.loads(state.read_text())
            # Profile paths in Local State are relative to the user-data-dir.
            old = data.get('profile', {}).get('info_cache', {}).get(profile.name, {})
            data['profile'] = {'info_cache': {'Default': old}, 'last_used': 'Default',
                               'last_active_profiles': ['Default']}
            temporary = destination / '.crewaid-local-state.tmp'
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as out:
                json.dump(data, out)
                out.flush()
                os.fsync(out.fileno())
            temporary.replace(target_state)
        profile.rename(target)


if __name__ == '__main__':
    if sys.argv[1] == 'retire':
        retire(Path('/home/bot'), sys.argv[2])
    elif sys.argv[1] == 'reap':
        reap(Path('/home/bot'))
        migrate(Path('/home/bot'))
    else:
        raise ValueError('unknown profile operation')
