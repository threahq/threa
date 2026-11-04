#!/bin/sh
# COPY TO PROGRAM runs inside PostgreSQL, which owns the data volume.
set -eu

sql() { psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atq "$@"; }
memory="SELECT pg_size_pretty(trim(pg_read_file('/sys/fs/cgroup/memory.current'))::bigint)"

before=$(sql -c "$memory")
data_directory=$(sql -c "SHOW data_directory")
# A file removed mid-run (dropped relation, recycled WAL) is not a failure.
program="find '$data_directory' -ignore_readdir_race -type f -exec sh -c 'for f; do dd if=\"\$f\" iflag=nocache count=0 status=none || [ ! -e \"\$f\" ] || exit 1; done' sh {} +"
sql -v program="$program" <<'SQL'
COPY (SELECT 1) TO PROGRAM :'program';
SQL
after=$(sql -c "$memory")

echo "postgres memory: $before -> $after"
