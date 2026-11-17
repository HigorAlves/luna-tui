#!/bin/sh
# Starts the company brain (RFC 0010). The `brain` compose service runs this in omnigraph's own
# image, in place of its entrypoint.
#
# Omnigraph guards a cluster with a lock file. `cluster apply` keeps its lock after it exits, and
# a server that was killed keeps its lock too: in both cases the next start is refused until that
# exact lock is cleared. So this script clears a lock it finds before and after the apply.
#
# That is safe only because this container is the cluster's one user. Never point a second
# process at the same volume.
set -eu

CONFIG="${BRAIN_CONFIG:-/config}"
CLUSTER="${OMNIGRAPH_CLUSTER:?OMNIGRAPH_CLUSTER names the cluster folder}"
LOCK="$CLUSTER/__cluster/lock.json"

clear_lock() {
  [ -f "$LOCK" ] || return 0
  id="$(sed -n 's/.*"lock_id"[^"]*"\([^"]*\)".*/\1/p' "$LOCK" | head -n 1)"
  if [ -z "$id" ]; then
    echo "brain: $LOCK names no lock id; not starting" >&2
    exit 1
  fi
  echo "brain: clearing the lock $id left by $1"
  omnigraph cluster force-unlock "$id" --target "$CLUSTER" >/dev/null
}

mkdir -p "$CLUSTER"
clear_lock "an earlier run"
# Creates the cluster the first time, and applies a changed schema, query or policy after that.
omnigraph cluster apply --target "$CLUSTER" --config "$CONFIG" --as owner >/dev/null
clear_lock "the apply"

# The image's own entrypoint reads OMNIGRAPH_CLUSTER and OMNIGRAPH_BIND and starts the server.
exec "${BRAIN_SERVER:-/usr/local/bin/omnigraph-entrypoint}"
