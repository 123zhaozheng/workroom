#!/usr/bin/env bash
# Bring up a LOCAL OpenSandbox server (Docker runtime) for developing / testing the Workroom "opensandbox" provider.
# Idempotent: re-running reuses the venv, the API key and a healthy running server.
#
#   scripts/opensandbox-local.sh            start (prints the endpoint + key file path)
#   scripts/opensandbox-local.sh stop       stop the server we started
#   scripts/opensandbox-local.sh status
#
# State lives OUTSIDE the repo: ${WORKROOM_OPENSANDBOX_HOME:-$HOME/.workroom-opensandbox}
#   venv/  config.toml  api.key (mode 600)  server.log  server.pid
# Nothing here is ever committed; the API key is generated locally and never printed (only its file path).
#
# Requirements: docker (reachable daemon), python3 >= 3.10 with venv, outbound access to PyPI + Docker Hub.
# Pinned: opensandbox-server 1.2.0 (PyPI, Apache-2.0), execd image opensandbox/execd:v1.1.0, egress image opensandbox/egress:v1.1.7
# (the two images are the versions named in that release's example config).
set -euo pipefail

SERVER_VERSION="${OPENSANDBOX_SERVER_VERSION:-1.2.0}"
EXECD_IMAGE="${OPENSANDBOX_EXECD_IMAGE:-opensandbox/execd:v1.1.0}"
EGRESS_IMAGE="${OPENSANDBOX_EGRESS_IMAGE:-opensandbox/egress:v1.1.7}"
SANDBOX_IMAGE="${OPENSANDBOX_TEST_IMAGE:-python:3.12-slim}"
# "dns" only filters DNS names (raw-IP connections are NOT blocked); "dns+nft" adds nftables CIDR/IP enforcement (verified in docs/research/opensandbox.md).
EGRESS_MODE="${OPENSANDBOX_EGRESS_MODE:-dns+nft}"
HOME_DIR="${WORKROOM_OPENSANDBOX_HOME:-$HOME/.workroom-opensandbox}"
HOST="127.0.0.1"
PORT="${OPENSANDBOX_PORT:-8080}"
ENDPOINT="http://$HOST:$PORT"

mkdir -p "$HOME_DIR"
chmod 700 "$HOME_DIR"
cd "$HOME_DIR"

healthy() { curl -fsS --max-time 3 "$ENDPOINT/health" >/dev/null 2>&1; }

case "${1:-start}" in
stop)
	if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then kill "$(cat server.pid)" && echo "stopped $(cat server.pid)"; fi
	rm -f server.pid
	exit 0
	;;
status)
	if healthy; then echo "running at $ENDPOINT (key file: $HOME_DIR/api.key)"; else echo "not running"; exit 1; fi
	exit 0
	;;
start) ;;
*) echo "usage: $0 [start|stop|status]" >&2; exit 2 ;;
esac

if ! docker info >/dev/null 2>&1; then
	echo "BLOCKER: no Docker daemon reachable (docker info failed). Start dockerd (e.g. 'dockerd --storage-driver=vfs &' inside a container) and re-run." >&2
	exit 1
fi

# API key: generated once, 600 permissions, outside the repo.
if [ ! -s api.key ]; then
	umask 077
	python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > api.key
fi
chmod 600 api.key

# Server (pinned) in a venv. pip uses the system CA bundle / proxy settings; TLS verification is never disabled.
if [ ! -x venv/bin/opensandbox-server ] || ! venv/bin/pip show opensandbox-server 2>/dev/null | grep -q "^Version: $SERVER_VERSION\$"; then
	python3 -m venv venv
	venv/bin/pip install -q "opensandbox-server==$SERVER_VERSION"
fi

# Images the server needs (execd is injected into every sandbox; egress sidecar is attached when a networkPolicy is requested).
for img in "$EXECD_IMAGE" "$EGRESS_IMAGE" "$SANDBOX_IMAGE"; do
	docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img" >/dev/null
done

# The egress sidecar sets net.ipv6.conf.all.disable_ipv6 inside its container; on hosts whose kernel has no IPv6 procfs (some nested /
# sandboxed Docker daemons) that fails ("unsafe procfs detected ... disable_ipv6: no such file"). Only then do we turn the sysctl off
# (OPENSANDBOX_EGRESS_DISABLE_IPV6=true|false overrides). IPv6 is not routed in such hosts anyway.
if [ -z "${OPENSANDBOX_EGRESS_DISABLE_IPV6:-}" ]; then
	if [ -d /proc/sys/net/ipv6 ]; then OPENSANDBOX_EGRESS_DISABLE_IPV6=true; else OPENSANDBOX_EGRESS_DISABLE_IPV6=false; echo "note: host kernel has no IPv6 procfs; egress.disable_ipv6=false" >&2; fi
fi

# Config: Docker runtime, loopback only, bridge network (required for networkPolicy / egress sidecar), ports published on loopback.
KEY="$(cat api.key)"
umask 077
cat > config.toml <<EOF
[server]
host = "$HOST"
port = $PORT
api_key = "$KEY"
max_sandbox_timeout_seconds = 86400

[runtime]
type = "docker"
execd_image = "$EXECD_IMAGE"

[docker]
network_mode = "bridge"
publish_host = "127.0.0.1"
no_new_privileges = true
pids_limit = 4096

[egress]
image = "$EGRESS_IMAGE"
mode = "$EGRESS_MODE"
disable_ipv6 = $OPENSANDBOX_EGRESS_DISABLE_IPV6

[store]
type = "sqlite"
path = "$HOME_DIR/opensandbox.db"

[log]
level = "INFO"
EOF
unset KEY
chmod 600 config.toml

if healthy; then
	echo "OpenSandbox already running."
else
	if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then kill "$(cat server.pid)" || true; sleep 1; fi
	nohup venv/bin/opensandbox-server --config "$HOME_DIR/config.toml" > server.log 2>&1 &
	echo $! > server.pid
	for _ in $(seq 1 60); do healthy && break; sleep 1; done
	healthy || { echo "BLOCKER: server did not become healthy; see $HOME_DIR/server.log" >&2; tail -20 server.log >&2; exit 1; }
fi

echo "OpenSandbox $SERVER_VERSION ready"
echo "  endpoint:  $ENDPOINT"
echo "  key file:  $HOME_DIR/api.key   (mode 600; header OPEN-SANDBOX-API-KEY)"
echo "  test image: $SANDBOX_IMAGE"
echo "Run the live tests with:"
echo "  WORKROOM_TEST_OPENSANDBOX_URL=$ENDPOINT WORKROOM_TEST_OPENSANDBOX_KEY=\"\$(cat $HOME_DIR/api.key)\" npm test -- server/test/sandbox-contract.test.ts"
