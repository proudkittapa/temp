#!/bin/sh
# Backs up the database and the slip images into deploy/backups/ (or the
# folder given), and deletes backups older than 30 days. Run it daily from
# cron (see DEPLOY.md) and copy the folder off the server.
set -eu
cd "$(dirname "$0")"
DEST=${1:-./backups}
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST"

# Database: a consistent snapshot while the app keeps running.
docker compose exec -T db pg_dump -U arena -d arena --format=custom > "$DEST/db-$STAMP.dump.part"
mv "$DEST/db-$STAMP.dump.part" "$DEST/db-$STAMP.dump"

# Slip images.
docker compose exec -T backend tar czf - -C /app/uploads . > "$DEST/uploads-$STAMP.tgz.part"
mv "$DEST/uploads-$STAMP.tgz.part" "$DEST/uploads-$STAMP.tgz"

find "$DEST" -name 'db-*.dump' -mtime +30 -delete
find "$DEST" -name 'uploads-*.tgz' -mtime +30 -delete
echo "Backup written: $DEST/db-$STAMP.dump, $DEST/uploads-$STAMP.tgz"
