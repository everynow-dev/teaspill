#!/bin/sh
# teaspill — backup script (T8.3, PLAN.md Phase 8 §5; see https://teaspill.everynow.dev/guides/operations/backup-restore
# for the full story and the restore-combination matrix).
#
# Captures a point-in-time backup of all three teaspill stores (D1, D7 —
# DECISIONS.md) from a RUNNING `docker compose` stack:
#
#   1. Postgres — the CATALOG (registry rows + `archived_snapshot`, the
#      archive-of-record for archived entities, D7). `pg_dump` in custom
#      format, taken via MVCC snapshot — consistent with no pause required,
#      regardless of --live below.
#   2. durable-streams data dir — history/telemetry (D1). The Rust server
#      has no per-stream truncation or export API (https://teaspill.everynow.dev/concepts/timelines-events) and no
#      admin dump command, so the ONLY option is a filesystem-level copy of
#      its data volume.
#   3. Restate data dir — the WORKING SET (live entity K/V: status, seq,
#      outbox, context, subscribers, workspaceRef — D1). NOT the archive
#      (D7). Per Restate's own docs (docs.restate.dev/server/snapshots,
#      fetched 2026-07-17): "Data backups are primarily used for
#      single-node Restate deployments" (which is what this compose stack
#      runs — see docker-compose.yml's single `--node-name=restate-1`) —
#      the recommended mechanism is a full copy of the `restate-data` base
#      directory, EITHER via an atomic block-storage snapshot OR by
#      stopping the process first and archiving its directory. This
#      script does the latter (quiesced mode, default) since it doesn't
#      assume snapshot-capable block storage under the named volume. The
#      S3/GCS/Azure object-store "snapshot" feature Restate also ships is
#      for MULTI-NODE clusters trimming a replicated log — not applicable
#      to this single-node stack; we deliberately do not use it.
#
# Consistency/ordering: see https://teaspill.everynow.dev/guides/operations/backup-restore "Consistency &
# ordering" for why quiescing (the default) is recommended and what
# --live costs you.
#
# Usage:
#   scripts/backup.sh [-d DIR] [-p PROJECT] [-f COMPOSE_FILE] [--live]
#
#   -d, --dir DIR        Backup output directory (default: ./backups/<UTC
#                         timestamp under the repo root>, or
#                         $TEASPILL_BACKUP_DIR if set).
#   -p, --project NAME   docker compose project name (default: teaspill,
#                         matching `name: teaspill` in docker-compose.yml;
#                         override only if you run multiple stacks).
#   -f, --file FILE      Path to docker-compose.yml (default: the repo
#                         root's, resolved relative to this script).
#       --live           Skip stopping restate/durable-streams before
#                         copying their volumes. Faster, zero downtime,
#                         but the three stores end up backed up at
#                         slightly different instants — a "torn" backup.
#                         Postgres is unaffected either way (pg_dump is
#                         always a consistent MVCC snapshot).
#   -h, --help           Print this usage block and exit 0.
#
# Dependencies: POSIX sh, `docker` with the `compose` plugin. No language
# runtime required. Pulls `alpine:3.20` (same default image T4.2's docker
# executor adapter already uses) as a throwaway tar helper container.
#
# Exit status: non-zero on any failure (set -eu; every step must succeed).

set -eu

# ---------------------------------------------------------------------------
# Defaults & arg parsing
# ---------------------------------------------------------------------------

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
COMPOSE_PROJECT="${TEASPILL_COMPOSE_PROJECT:-teaspill}"
BACKUP_DIR="${TEASPILL_BACKUP_DIR:-$REPO_ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ)}"
LIVE=0

usage() {
  cat <<'EOF'
Usage: scripts/backup.sh [-d DIR] [-p PROJECT] [-f COMPOSE_FILE] [--live]

  -d, --dir DIR       Backup output directory.
  -p, --project NAME  docker compose project name (default: teaspill).
  -f, --file FILE     Path to docker-compose.yml.
      --live          Skip quiescing restate/durable-streams (torn backup;
                       see https://teaspill.everynow.dev/guides/operations/backup-restore "Consistency & ordering").
  -h, --help          This message.

Captures Postgres (pg_dump), durable-streams data dir, and Restate data
dir from a running `docker compose` stack. See https://teaspill.everynow.dev/guides/operations/backup-restore.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -d | --dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    -p | --project)
      COMPOSE_PROJECT="$2"
      shift 2
      ;;
    -f | --file)
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --live)
      LIVE=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "backup.sh: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

DC="docker compose -p $COMPOSE_PROJECT -f $COMPOSE_FILE"

# ---------------------------------------------------------------------------
# Preflight: postgres must be up (we read its own env for creds rather than
# re-deriving from .env, so we never drift from what the running container
# actually has — the same POSTGRES_USER/POSTGRES_DB docker-compose.yml sets).
# ---------------------------------------------------------------------------

POSTGRES_CONTAINER=$($DC ps -q postgres)
if [ -z "$POSTGRES_CONTAINER" ]; then
  echo "backup.sh: postgres service is not running under project '$COMPOSE_PROJECT'" >&2
  echo "backup.sh: (docker compose -p $COMPOSE_PROJECT -f $COMPOSE_FILE ps -q postgres returned nothing — start the stack first, e.g. 'make dev')" >&2
  exit 1
fi
POSTGRES_USER=$(docker exec "$POSTGRES_CONTAINER" printenv POSTGRES_USER)
POSTGRES_DB=$(docker exec "$POSTGRES_CONTAINER" printenv POSTGRES_DB)

mkdir -p "$BACKUP_DIR"
echo "backup.sh: writing backup to $BACKUP_DIR (project=$COMPOSE_PROJECT, mode=$([ "$LIVE" -eq 0 ] && echo quiesced || echo live))"

# ---------------------------------------------------------------------------
# 1. Postgres catalog — pg_dump, custom format (`-Fc`): compressed,
#    supports selective/parallel pg_restore, and is what pg_restore
#    --clean --if-exists (used by restore.sh) expects.
# ---------------------------------------------------------------------------

echo "backup.sh: [1/3] postgres catalog (pg_dump)"
docker exec "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom \
  >"$BACKUP_DIR/postgres-catalog.dump"

# ---------------------------------------------------------------------------
# 2 & 3. durable-streams + Restate data-dir volumes — filesystem copy via a
# throwaway `--volumes-from` helper container (works whether the source
# container is running or stopped; the named volume itself is unaffected
# by stop/start).
#
# Quiesced mode (default): stop both containers first so tar reads files
# nothing is concurrently writing to — the same guarantee Restate's own
# docs recommend ("stop the restate-server process, archive the base
# directory contents, and then restart the process"). durable-streams runs
# in `file-durable` mode (fsync on every append, docker-compose.yml), so a
# stopped-container copy is exactly its last confirmed state. Agent wakes
# in flight during the pause are retried by their callers, not lost — see
# https://teaspill.everynow.dev/guides/operations/backup-restore.
#
# --live mode: skip stop/start, copy while running. See that doc for what
# this costs.
# ---------------------------------------------------------------------------

if [ "$LIVE" -eq 0 ]; then
  echo "backup.sh: quiescing restate + durable-streams for a consistent volume copy"
  $DC stop restate durable-streams
fi

echo "backup.sh: [2/3] durable-streams data dir (volume tar)"
# `-a` matters here: in quiesced mode the container was just stopped above,
# and a plain `ps -q` (no -a) only lists RUNNING containers — it would
# silently return empty and `--volumes-from ""` fails with a confusing
# docker error. `-a` finds it whether running (--live mode) or stopped.
docker run --rm \
  --volumes-from "$($DC ps -a -q durable-streams)" \
  -v "$BACKUP_DIR:/backup" \
  alpine:3.20 \
  tar czf /backup/durable-streams-data.tar.gz -C /data .

echo "backup.sh: [3/3] restate data dir (volume tar)"
docker run --rm \
  --volumes-from "$($DC ps -a -q restate)" \
  -v "$BACKUP_DIR:/backup" \
  alpine:3.20 \
  tar czf /backup/restate-data.tar.gz -C /restate-data .

if [ "$LIVE" -eq 0 ]; then
  echo "backup.sh: resuming restate + durable-streams"
  $DC start restate durable-streams
fi

# ---------------------------------------------------------------------------
# Manifest — records what/when/how, so restore.sh (and a human) can sanity
# check a backup dir without re-deriving compose/project state.
# ---------------------------------------------------------------------------

{
  echo "teaspill backup"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "compose_project=$COMPOSE_PROJECT"
  echo "compose_file=$COMPOSE_FILE"
  echo "mode=$([ "$LIVE" -eq 0 ] && echo quiesced || echo live)"
  echo "postgres_user=$POSTGRES_USER"
  echo "postgres_db=$POSTGRES_DB"
  echo "files=postgres-catalog.dump,durable-streams-data.tar.gz,restate-data.tar.gz"
} >"$BACKUP_DIR/MANIFEST.txt"

echo "backup.sh: done. See $BACKUP_DIR/MANIFEST.txt"
echo "backup.sh: for the restore-combination matrix (what's clean vs lossy), see https://teaspill.everynow.dev/guides/operations/backup-restore"
