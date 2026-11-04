#!/bin/sh
# Railway bills Postgres for page cache too, and its memory limit never forces
# reclaim, so cold pages stay forever. Drop the clean cached pages of every data
# file; the drop runs via COPY TO PROGRAM because only Postgres mounts the volume.
set -eu

sql() { psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atq -c "$1"; }
memory="SELECT pg_size_pretty(trim(pg_read_file('/sys/fs/cgroup/memory.current'))::bigint)"

before=$(sql "$memory")
data_directory=$(sql "SHOW data_directory")
sql "COPY (SELECT 1) TO PROGRAM 'find $data_directory -ignore_readdir_race -type f -exec dd if={} iflag=nocache count=0 status=none \;'"
after=$(sql "$memory")

echo "postgres memory: $before -> $after"
