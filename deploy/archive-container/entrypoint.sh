#!/bin/sh
set -eu
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset ENV BASH_ENV CDPATH PYTHONHOME PYTHONPATH

# UID/GID are build-time identity parameters. Runtime disagreement is a refusal,
# never a reason to mutate /etc/passwd or require writable image layers.
setpriv --reuid "$PUID" --regid "$PGID" --clear-groups -- \
    /usr/local/bin/python3 -I -B - <<'PY'
import base64, ipaddress, json, os, pathlib, pwd, stat
def require(value):
    if not value:
        raise SystemExit('Archive container preflight refused')
user = pwd.getpwnam('codex')
uid, gid = int(os.environ['PUID']), int(os.environ['PGID'])
require(uid > 0 and gid > 0 and (user.pw_uid, user.pw_gid) == (uid, gid))
require((os.geteuid(), os.getegid()) == (uid, gid))
source = os.environ.get('ARCHIVE_SOURCE', '')
ipaddress.ip_network(source, strict=True)
require(source and not any(c.isspace() for c in source))
for target in ('/archive', '/catalog'):
    p = pathlib.Path(target)
    s = p.lstat()
    require(not p.is_symlink() and stat.S_ISDIR(s.st_mode) and s.st_uid == uid and not s.st_mode & 0o077)
for target in ('/config/receiver.json', '/config/authorized_keys'):
    p = pathlib.Path(target)
    s = p.lstat()
    require(not p.is_symlink() and stat.S_ISREG(s.st_mode) and s.st_uid == uid and not s.st_mode & 0o077)
config = json.loads(pathlib.Path('/config/receiver.json').read_text())
require(config.get('archiveDirectory') == '/archive' and config.get('catalogDirectory') == '/catalog')
require(not config.get('timescale', {}).get('enabled', False))
keys = pathlib.Path('/config/authorized_keys').read_text().splitlines()
require(len(keys) == 1 and len(keys[0]) < 4096)
prefix = 'restrict,from="' + source + '",command="/usr/local/bin/codex-archive-command" ssh-ed25519 '
require(keys[0].startswith(prefix))
key = keys[0][len(prefix):].split()
require(len(key) in (1, 2) and len(base64.b64decode(key[0], validate=True)) == 51)
PY

mkdir -p /run/sshd
chmod 0755 /run/sshd
test -d /keys
test ! -L /keys
test "$(stat -c %u /keys)" = 0
chmod 0700 /keys
if test ! -e /keys/ssh_host_ed25519_key; then
    ssh-keygen -q -t ed25519 -N '' -f /keys/ssh_host_ed25519_key
fi
test -f /keys/ssh_host_ed25519_key
test ! -L /keys/ssh_host_ed25519_key
chmod 0600 /keys/ssh_host_ed25519_key
ssh-keygen -y -f /keys/ssh_host_ed25519_key > /run/hostkey-derived.pub
if test ! -e /keys/ssh_host_ed25519_key.pub; then
    cp /run/hostkey-derived.pub /keys/ssh_host_ed25519_key.pub
fi
/usr/local/bin/python3 -I -B - <<'PY'
from pathlib import Path
p=Path('/keys/ssh_host_ed25519_key.pub')
if p.is_symlink() or p.read_text().split()[:2] != Path('/run/hostkey-derived.pub').read_text().split()[:2]:
    raise SystemExit('Archive host public key mismatch')
PY

# Initial ownership is prepared once by the deployer with CHOWN only. The
# long-running SSH daemon does not retain that capability.
setpriv --reuid "$PUID" --regid "$PGID" --clear-groups -- \
    /usr/local/bin/python3 -I -B /opt/codexcontrol/archive-receiver.py \
    --config /config/receiver.json --status >/dev/null
/usr/sbin/sshd -t -f /etc/codexcontrol/sshd_config
exec /usr/sbin/sshd -D -e -f /etc/codexcontrol/sshd_config
