#!/bin/sh
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin
export PATH
unset ENV BASH_ENV CDPATH PYTHONHOME PYTHONPATH
# Deliberately no shell, SFTP, query, verify, or arbitrary receiver arguments.
# Administrators run maintenance separately through the local container engine.
case "${SSH_ORIGINAL_COMMAND-}" in
    archive) exec /usr/local/bin/python3 -I -B /opt/codexcontrol/archive-receiver.py --config /config/receiver.json ;;
    *) printf '%s\n' 'Archive command refused' >&2; exit 64 ;;
esac
