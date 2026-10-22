# Deploying the sports complex app

One Linux server runs everything with Docker: PostgreSQL, the Go backend,
and Caddy, which serves the website, forwards `/api` to the backend and gets
the HTTPS certificate by itself. The files are in [`deploy/`](deploy/).

```
internet ──443/80──> Caddy (web) ──/api──> backend:8080 ──> db (PostgreSQL)
                       └── website files (React, API mode)
volumes: pgdata (database) · uploads (slip images) · caddy_data (certificates)
```

## 1. What you need

- A Linux server (Ubuntu 22.04/24.04), 1-2 GB RAM is enough to start;
  e.g. DigitalOcean / Vultr / AWS Lightsail in Singapore (US$6-12/month).
- A domain name (optional but needed for HTTPS and the LINE login later),
  with an **A record** pointing to the server's IP address.
- Ports 80 and 443 open to the internet.

## 2. Install Docker (once)

```sh
ssh root@YOUR_SERVER_IP
curl -fsSL https://get.docker.com | sh
# firewall: SSH + web only
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw allow 443/udp && ufw --force enable
```

## 3. Get the code and write the settings

```sh
git clone https://github.com/proudkittapa/temp.git /opt/arena
cd /opt/arena
cp deploy/.env.example deploy/.env
cp golang-backend/.env.example golang-backend/.env
```

**`deploy/.env`** (Docker settings):

| Setting | Value |
|---|---|
| `SITE_ADDRESS` | your domain, e.g. `arena.example.com` (or `:80` to test by IP over plain HTTP) |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` (letters and digits only) |

**`golang-backend/.env`** (the shop's settings - the Docker file already sets
`DATABASE_URL`, `GIN_MODE=release`, `PORT`, `SEED_DEMO_USERS=false` and
`TRUSTED_PROXIES`, so leave those out or as they are):

| Setting | Value |
|---|---|
| `JWT_SECRET` | `openssl rand -hex 32` - **required**; the server refuses to start without it |
| `PROMPTPAY_ID` | the shop's real PromptPay number - the example value would send customers' money elsewhere |
| court counts, `NO_SHOW_*`, `DB_*`, ... | only if not the defaults (see the comments in the file) |

Both `.env` files stay on the server only: never commit them or send them in
chat. Keep `chmod 600` on them.

## 4. Start

```sh
cd /opt/arena/deploy
docker compose up -d --build
docker compose ps          # all three "healthy" / "running" after ~1 minute
docker compose logs -f backend
```

Open `https://YOUR_DOMAIN` (or `http://YOUR_SERVER_IP` with `SITE_ADDRESS=:80`).
The first start builds the images (a few minutes) and gets the certificate.

## 5. First admin and shop details

1. On the website, **register** an account with the owner's phone number.
2. Make it an admin:
   ```sh
   docker compose exec backend /app/arena-backend make-admin 0812345678
   ```
3. Sign in at `https://YOUR_DOMAIN/#/admin`:
   - Admin → Pricing → ข้อมูลร้าน: shop name, address, phone, tax ID, VAT.
   - Prices, opening hours, courts, products.
   - Staff: they register on the site, then the admin gives them a role
     (Admin → บัญชีสตาฟเวร).
4. The counter is at `https://YOUR_DOMAIN/#/staff`.

There are no demo accounts on the server (`SEED_DEMO_USERS=false`).

## 6. Backups

`deploy/backup.sh` saves the database and the slip images to
`deploy/backups/` and deletes copies older than 30 days. Run it every night:

```sh
crontab -e
# add:
30 3 * * * /opt/arena/deploy/backup.sh >> /opt/arena/deploy/backups/backup.log 2>&1
```

Copy `deploy/backups/` **off the server** too (e.g. `rclone` to object
storage, or download it regularly) - a backup on the same disk is lost with
the server.

### Restore (test this once before going live)

The database is put back exactly as it was at the backup. The slip images
are extracted over the current folder: missing ones come back, and any
added after the backup stay (unused, harmless).

```sh
cd /opt/arena/deploy
docker compose stop backend web
docker compose exec -T db pg_restore -U arena -d arena --clean --if-exists < backups/db-YYYYMMDD-HHMMSS.dump
docker compose run --rm --no-deps --entrypoint tar -v "$PWD/backups:/backups" backend \
  xzf /backups/uploads-YYYYMMDD-HHMMSS.tgz -C /app/uploads
docker compose start backend web
```

## 7. Updating to a new version

```sh
cd /opt/arena && git pull
cd deploy && ./backup.sh && docker compose up -d --build
```

The backend finishes requests in progress before it stops (up to 30 s) and
applies database changes by itself when it starts.

## 8. Day to day

| Task | Command (in `/opt/arena/deploy`) |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs -f backend` (or `web`, `db`) |
| Restart the app | `docker compose restart backend` |
| Stop everything | `docker compose down` (data stays in the volumes) |
| Database shell | `docker compose exec db psql -U arena -d arena` |

- Containers restart by themselves after a crash or a server reboot.
- Uptime monitor (e.g. UptimeRobot, free): check `https://YOUR_DOMAIN/readyz`
  - it answers 200 only when the backend is up and the database responds.
- **Never** run `docker compose down -v`: `-v` deletes the volumes - the
  database, the slip images and the certificates.

## 9. Quick demo from a laptop instead (no server)

`npm run dev:api` and `cloudflared tunnel --url http://localhost:3000`
(`brew install cloudflared`) give a temporary `https://...trycloudflare.com`
address (Vite allows those hosts). It works only while the laptop is on, the
address changes on every start, and the demo accounts (password `123456`)
are open to anyone with the link - test data only.
