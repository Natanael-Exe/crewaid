/** Fixed argv program run in a networkless helper, never in a bot-controlled shell. */
export const WORKSPACE_MARKER_PROGRAM = `
import fcntl, os, stat, sys
now = int(sys.argv[1])
clear = sys.argv[2] == 'clear'
path = '/home/bot/.crewaid-orphaned-at'
try:
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
except OSError:
    # A hostile symlink, directory or inaccessible marker is not expiry evidence.
    raise SystemExit(1)
with os.fdopen(fd, 'r+') as marker:
    if not stat.S_ISREG(os.fstat(marker.fileno()).st_mode):
        raise SystemExit(1)
    fcntl.flock(marker, fcntl.LOCK_EX)
    raw = marker.read(64).strip()
    try:
        first = int(raw)
        if first <= 0 or first > now:
            first = now
    except ValueError:
        first = now
    # Clearing writes an empty marker instead of unlinking a locked inode.
    marker.seek(0)
    marker.truncate()
    marker.write('' if clear else str(first))
    marker.flush()
    os.fsync(marker.fileno())
    print('clear' if clear else 'crewaid-retention:' + str(first))
`;

/** Absence is meaningful: reading history must never manufacture it. */
export const RUNTIME_MARKER_PROGRAM = `
import fcntl, os, stat, sys
now = int(sys.argv[1])
write = sys.argv[2] == 'write'
path = '/home/bot/.crewaid-runtime-created-at'
flags = os.O_RDWR if write else os.O_RDONLY
try:
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK)
except FileNotFoundError:
    if not write:
        print('crewaid-runtime:none')
        raise SystemExit(0)
    try:
        fd = os.open(path, flags | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        raise SystemExit(1)
    with os.fdopen(fd, 'w') as marker:
        marker.write(str(now))
        marker.flush()
        os.fsync(marker.fileno())
    print('crewaid-runtime:' + str(now))
    raise SystemExit(0)
with os.fdopen(fd, 'r') as marker:
    if not stat.S_ISREG(os.fstat(marker.fileno()).st_mode):
        raise SystemExit(1)
    fcntl.flock(marker, fcntl.LOCK_SH)
    raw = marker.read(64).strip()
    if not raw.isdecimal() or len(raw) > 16:
        raise SystemExit(1)
    first = int(raw)
    if first <= 0 or first > now:
        raise SystemExit(1)
    print('crewaid-runtime:' + str(first))
`;
