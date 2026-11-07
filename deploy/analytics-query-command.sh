#!/bin/sh
# Author: Bishop Crockett
# Owner: Argellan.com
# License: MIT
# SPDX-License-Identifier: MIT
# Attribution covers ARGELLAN-authored implementation and modifications only.
# Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
# A separate authorized-key entry must force this command. Never reuse the
# archive sender's forced-command key or grant a remote shell to the hub.
set -eu
umask 077
PATH=/usr/bin:/bin
export PATH
unset ENV BASH_ENV CDPATH PYTHONHOME PYTHONPATH
case "${SSH_ORIGINAL_COMMAND-}" in
    analytics-query)
        exec /opt/codexcontrol/analytics-runtime/bin/python -I -B /opt/codexcontrol/scripts/archive-analytics.py --config /etc/codexcontrol/analytics.json --query
        ;;
    *) printf '%s\n' 'Analytics command refused' >&2; exit 64 ;;
esac
