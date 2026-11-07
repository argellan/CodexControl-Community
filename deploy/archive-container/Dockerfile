# Build only from an allowlisted release context, never the private workspace.
# The deployer records/pins the resolved official Python image digest.
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
FROM ${PYTHON_IMAGE}
ARG PUID=1000
ARG PGID=1000
RUN set -eu; \
    case "$PUID:$PGID" in *[!0-9:]*|0:*) exit 64;; esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends openssh-server util-linux; \
    rm -rf /var/lib/apt/lists/*; \
    rm -f /etc/ssh/ssh_host_*; \
    if ! getent group "$PGID" >/dev/null; then groupadd --gid "$PGID" codex; fi; \
    useradd --uid "$PUID" --gid "$PGID" --no-create-home --home-dir /nonexistent --shell /bin/sh codex; \
    usermod --password '*' codex; \
    mkdir -p /keys /catalog /archive /config /run/sshd /etc/codexcontrol /opt/codexcontrol; \
    chmod 0700 /keys; \
    chmod 0755 /catalog /archive /config /run/sshd
COPY scripts/archive-receiver.py /opt/codexcontrol/archive-receiver.py
COPY deploy/archive-container/sshd_config /etc/codexcontrol/sshd_config
COPY deploy/archive-container/entrypoint.sh /usr/local/bin/codex-archive-entrypoint
COPY deploy/archive-container/authorized-command.sh /usr/local/bin/codex-archive-command
RUN chmod 0555 /usr/local/bin/codex-archive-entrypoint /usr/local/bin/codex-archive-command; \
    chmod 0444 /opt/codexcontrol/archive-receiver.py /etc/codexcontrol/sshd_config; \
    test -z "$(find /etc/ssh -maxdepth 1 -name 'ssh_host_*' -print -quit)"
ENV PUID=${PUID} PGID=${PGID} PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 2222
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/codex-archive-entrypoint"]
