#!/bin/sh
# teaspill — restore script (T8.3). Inverse of scripts/backup.sh.
#
# Restores any subset of the three teaspill stores from a backup directory
# produced by scripts/backup.sh. Restoring FEWER than all three is a
# supported, DOCUMENTED-LOSSY operation — this script does not refuse
# partial restores, it prints what you're about to do and, for anything
# other than --all, a reminder to read the restore-combination matrix in
# docs/backup-restore.md before proceeding (e.g. catalog+streams WITHOUT
# Restate loses every entity that was still ACTIVE at backup time — its
# live K/V working set is gone and it has no `archived_snapshot` to
# resurrect from, D7 — while ARCHIVED entities are completely fine).
#
# Usage:
#   scripts/restore.sh -d DIR [-p PROJECT] [-f COMPOSE_FILE]
#                       [--postgres] [--streams] [--restate] [--all] [-y]
#
#   -d, --dir DIR        Backup directory to restore from (required; must
#                         contain MANIFEST.txt as written by backup.sh).
#   -p, --project NAME   docker compose project name (default: teaspill).
#   -f, --file FILE      Path to docker-compose.yml.
#       --postgres       Restore the Postgres catalog only.
#       --streams        Restore the durable-streams volume only.
#       --restate        Restore the Restate data volume only.
#       --all            Restore all three (default if no store flag given).
#   -y, --yes            Skip the interactive confirmation prompt (for
#                         scripted/CI use; the printed warning still
#                         prints either way).
#   -h, --help            Print this usage block and exit 0.
#
# IMPORTANT: this is DESTRUCTIVE to the target store(s) — it drops and
# recreates objects in the Postgres database (pg_restore --clean
# --if-exists) and wholesale-overwrites the streams/restate volume
# contents. There is no snapshot-before-you-overwrite safety net here;
# take a fresh backup.sh run first if you want one.
#
# Restate caveat (from docs.restate.dev/server/snapshots, fetched
# 2026-07-17): "you must ensure that only one instance of any given
# Restate node is running when restoring the data store from a backup"
# (split-brain risk) and the restored data's cluster-name/node-name must
# match the running config. This script restores into the SAME compose
# stack's named volume with the SAME `--node-name=restate-1` docker-
# compose.yml already pins, so both are satisfied by construction as long
# as you don't hand-edit docker-compose.yml's Restate node-name between
# backup and restore.
#
# Dependencies: POSIX sh, `docker` with the `compose` plugin.

set -eu

# ---------------------------------------------------------------------------
# Defaults & arg parsing
# ---------------------------------------------------------------------------

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
COMPOSE_PROJECT="${TEASPILL_COMPOSE_PROJECT:-teaspill}"
BACKUP_DIR=""
DO_POSTGRES=0
DO_STREAMS=0
DO_RESTATE=0
ANY_FLAG=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage: scripts/restore.sh -d DIR [-p PROJECT] [-f COMPOSE_FILE]
                           [--postgres] [--streams] [--restate] [--all] [-y]

  -d, --dir DIR       Backup directory to restore from (required).
  -p, --project NAME  docker compose project name (default: teaspill).
  -f, --file FILE     Path to docker-compose.yml.
      --postgres      Restore the Postgres catalog only.
      --streams       Restore the durable-streams volume only.
      --restate       Restore the Restate data volume only.
      --all           Restore all three (default if no store flag given).
  -y, --yes           Skip the interactive confirmation prompt.
  -h, --help          This message.

DESTRUCTIVE. See docs/backup-restore.md for the restore-combination
matrix before restoring anything less than --all.
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
    --postgres)
      DO_POSTGRES=1
      ANY_FLAG=1
      shift
      ;;
    --streams)
      DO_STREAMS=1
      ANY_FLAG=1
      shift
      ;;
    --restate)
      DO_RESTATE=1
      ANY_FLAG=1
      shift
      ;;
    --all)
      DO_POSTGRES=1
      DO_STREAMS=1
      DO_RESTATE=1
      ANY_FLAG=1
      shift
      ;;
    -y | --yes)
      ASSUME_YES=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "restore.sh: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$BACKUP_DIR" ]; then
  echo "restore.sh: -d/--dir BACKUP_DIR is required" >&2
  usage >&2
  exit 1
fi
if [ ! -f "$BACKUP_DIR/MANIFEST.txt" ]; then
  echo "restore.sh: $BACKUP_DIR/MANIFEST.txt not found — is this a backup.sh output directory?" >&2
  exit 1
fi
if [ "$ANY_FLAG" -eq 0 ]; then
  # No store flag given at all ⇒ default to --all (mirrors backup.sh always
  # capturing all three).
  DO_POSTGRES=1
  DO_STREAMS=1
  DO_RESTATE=1
fi

DC="docker compose -p $COMPOSE_PROJECT -f $COMPOSE_FILE"

echo "restore.sh: restoring from $BACKUP_DIR into project '$COMPOSE_PROJECT'"
echo "restore.sh:   postgres=$DO_POSTGRES streams=$DO_STREAMS restate=$DO_RESTATE"
if [ "$DO_POSTGRES" -eq 1 ] && [ "$DO_STREAMS" -eq 1 ] && [ "$DO_RESTATE" -eq 1 ]; then
  echo "restore.sh: restoring ALL THREE stores — clean full recovery (docs/backup-restore.md §Matrix, row 1)."
else
  echo "restore.sh: PARTIAL restore — this is a documented-lossy combination."
  echo "restore.sh: read docs/backup-restore.md 'Restore combinations' before proceeding."
fi
echo "restore.sh: this is DESTRUCTIVE to the store(s) selected above."

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'restore.sh: type "yes" to proceed: '
  read -r CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    echo "restore.sh: aborted." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Postgres — pg_restore --clean --if-exists against the RUNNING database
# (drops/recreates objects inside the existing db rather than dropping the
# database itself, so it needs no superuser CREATE DATABASE privilege and
# works whether the target db is empty or already populated).
# ---------------------------------------------------------------------------

if [ "$DO_POSTGRES" -eq 1 ]; then
  if [ ! -f "$BACKUP_DIR/postgres-catalog.dump" ]; then
    echo "restore.sh: $BACKUP_DIR/postgres-catalog.dump not found, skipping postgres restore" >&2
    exit 1
  fi
  POSTGRES_CONTAINER=$($DC ps -q postgres)
  if [ -z "$POSTGRES_CONTAINER" ]; then
    echo "restore.sh: postgres service is not running under project '$COMPOSE_PROJECT' — start the stack first" >&2
    exit 1
  fi
  POSTGRES_USER=$(docker exec "$POSTGRES_CONTAINER" printenv POSTGRES_USER)
  POSTGRES_DB=$(docker exec "$POSTGRES_CONTAINER" printenv POSTGRES_DB)
  echo "restore.sh: [postgres] pg_restore --clean --if-exists"
  docker exec -i "$POSTGRES_CONTAINER" \
    pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner \
    <"$BACKUP_DIR/postgres-catalog.dump"
fi

# ---------------------------------------------------------------------------
# durable-streams / Restate — stop the container, wipe the volume contents,
# extract the tar, restart. Both MUST be stopped during the overwrite: an
# in-place tar extraction under a live process is exactly the torn-write
# hazard backup.sh's quiesced mode exists to avoid on the WRITE side, and
# it's just as unsafe on the READ (restore) side.
# ---------------------------------------------------------------------------

if [ "$DO_STREAMS" -eq 1 ]; then
  if [ ! -f "$BACKUP_DIR/durable-streams-data.tar.gz" ]; then
    echo "restore.sh: $BACKUP_DIR/durable-streams-data.tar.gz not found, skipping streams restore" >&2
    exit 1
  fi
  echo "restore.sh: [streams] stopping durable-streams"
  $DC stop durable-streams
  DS_CONTAINER=$($DC ps -a -q durable-streams)
  echo "restore.sh: [streams] wiping volume + extracting backup"
  docker run --rm \
    --volumes-from "$DS_CONTAINER" \
    -v "$BACKUP_DIR:/backup:ro" \
    alpine:3.20 \
    sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/durable-streams-data.tar.gz -C /data'
  echo "restore.sh: [streams] restarting durable-streams"
  $DC start durable-streams
fi

if [ "$DO_RESTATE" -eq 1 ]; then
  if [ ! -f "$BACKUP_DIR/restate-data.tar.gz" ]; then
    echo "restore.sh: $BACKUP_DIR/restate-data.tar.gz not found, skipping restate restore" >&2
    exit 1
  fi
  echo "restore.sh: [restate] stopping restate"
  $DC stop restate
  RESTATE_CONTAINER=$($DC ps -a -q restate)
  echo "restore.sh: [restate] wiping volume + extracting backup"
  docker run --rm \
    --volumes-from "$RESTATE_CONTAINER" \
    -v "$BACKUP_DIR:/backup:ro" \
    alpine:3.20 \
    sh -c 'rm -rf /restate-data/* /restate-data/.[!.]* 2>/dev/null; tar xzf /backup/restate-data.tar.gz -C /restate-data'
  echo "restore.sh: [restate] restarting restate"
  $DC start restate
fi

echo "restore.sh: done."
if [ "$DO_POSTGRES" -eq 1 ] && [ "$DO_STREAMS" -eq 1 ] && [ "$DO_RESTATE" -eq 1 ]; then
  echo "restore.sh: all three stores restored — full recovery, no further action expected."
else
  echo "restore.sh: partial restore complete. See docs/backup-restore.md for the expected"
  echo "restore.sh: degradation of this combination and what (if anything) self-heals."
fi
