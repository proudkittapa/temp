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

## 2. Secure the server and install Docker (once)

Log in with an SSH key, not a password. Most providers let you add your key
when you create the server; otherwise, from your laptop:

```sh
ssh-keygen -t ed25519            # only if you have no key yet (~/.ssh/id_ed25519.pub)
ssh-copy-id root@YOUR_SERVER_IP
```

Then on the server:

```sh
ssh root@YOUR_SERVER_IP
# SSH: keys only, no passwords
printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-arena.conf
systemctl reload ssh
# security updates for the server itself, installed automatically
apt update && apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades     # answer "Yes"
# Docker
curl -fsSL https://get.docker.com | sh
# firewall: SSH + web only
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw allow 443/udp && ufw --force enable
```

Before you close this window, check in a **second** terminal that
`ssh root@YOUR_SERVER_IP` still logs you in - if not, you can still undo the
SSH change from the first one.

Ports that Docker publishes go **around** ufw. That is fine for Caddy (80
and 443 are meant to be open), but never add `ports:` to `db` or `backend`
in `docker-compose.yml`: the database or the API would be open to the whole
internet, firewall or not.

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
`DATABASE_URL`, `GIN_MODE=release`, `PORT`, `SEED_DEMO_USERS=false`,
`TRUSTED_PROXIES` and `CORS_ALLOWED_ORIGINS`, so leave those out or as they are):

| Setting | Value |
|---|---|
| `JWT_SECRET` | `openssl rand -hex 32` - **required**; the server refuses to start without it |
| `PROMPTPAY_ID` | the shop's real PromptPay number - **required**; the server refuses to start without it (or with the old example number `0105561008012`, which would send customers' money elsewhere) |
| court counts, `NO_SHOW_*`, `DB_*`, ... | only if not the defaults (see the comments in the file) |

Both `.env` files stay on the server: never commit them or send them in
chat. Keep `chmod 600` on them. Also save a copy of both in your password
manager (see Backups).

## 4. Start

```sh
cd /opt/arena/deploy
docker compose up -d --build
docker compose ps          # all three "healthy" / "running" a few seconds after the build
docker compose logs -f backend
```

Open `https://YOUR_DOMAIN` (or `http://YOUR_SERVER_IP` with `SITE_ADDRESS=:80`).
The first start builds the images (a few minutes) and gets the certificate.

## 5. First admin and shop details

Do this right after the site is up, **before** you tell anyone the address.

1. On the website, **register** an account with the owner's phone number.
2. Look up the account:
   ```sh
   docker compose exec backend /app/arena-backend make-admin 0812345678
   ```
   It shows the account (name, phone, when it was created) and changes
   nothing yet. Check that it is yours: your name, created just now. If it
   is not, stop - someone else registered that number.
3. Make it an admin:
   ```sh
   docker compose exec backend /app/arena-backend make-admin 0812345678 --yes
   ```
4. Sign in at `https://YOUR_DOMAIN/#/admin`:
   - Admin → Pricing → ข้อมูลร้าน: shop name, address, phone, tax ID, VAT.
   - Prices, opening hours, courts, products.
   - Staff: they register on the site, then the admin gives them a role
     (Admin → บัญชีสตาฟเวร).
5. The counter is at `https://YOUR_DOMAIN/#/staff`.

There are no demo accounts on the server (`SEED_DEMO_USERS=false`).

## 6. Backups

`deploy/backup.sh` saves the database and the slip images to the folder you
give it and deletes copies older than 30 days. Use a folder outside the code
(`/var/backups/arena`); without one it uses `deploy/backups/`, which also
works. Run it every night:

```sh
mkdir -p /var/backups/arena && chmod 700 /var/backups/arena
crontab -e
# add:
30 3 * * * /opt/arena/deploy/backup.sh /var/backups/arena >> /var/backups/arena/backup.log 2>&1
```

The backups hold customers' names, phone numbers and bank slips: keep them
private. The script makes them readable by root only; never put them in a
shared folder or send them in chat.

Copy them **off the server** too - a backup on the same disk is lost with
the server - and **encrypt them first**. A simple way is `rclone` with a
"crypt" remote, which encrypts every file before it leaves the server:

```sh
apt install -y rclone
rclone config
#  1. "n" new remote: your storage, e.g. Backblaze B2 or Google Drive, named "store"
#  2. "n" new remote: type "crypt", named "arena-crypt", remote "store:arena-backups",
#     choose a long password (rclone can generate one)
crontab -e
# add (after the backup at 3:30):
30 4 * * * rclone copy /var/backups/arena arena-crypt: --exclude backup.log >> /var/backups/arena/backup.log 2>&1
```

If you download the backups to a laptop instead, keep them on an encrypted
disk (FileVault / BitLocker).

**Keep the secrets separately, in your password manager**: the two `.env`
files (`deploy/.env`, `golang-backend/.env`) and the rclone crypt password.
They are not in the backups. Without the crypt password the off-site copies
cannot be read; without the `.env` files a restore needs new secrets and
everyone has to log in again.

### Restore (test this once before going live)

The database is put back exactly as it was at the backup. The slip images
are extracted over the current folder: missing ones come back, and any
added after the backup stay (unused, harmless).

```sh
cd /opt/arena/deploy
# only if the server's own copies are gone: fetch them back (rclone decrypts them)
rclone copy arena-crypt: /var/backups/arena --include '*-YYYYMMDD-HHMMSS.*'
docker compose stop backend web
docker compose exec -T db pg_restore -U arena -d arena --clean --if-exists < /var/backups/arena/db-YYYYMMDD-HHMMSS.dump
docker compose run --rm --no-deps --entrypoint tar -v /var/backups/arena:/backups backend \
  xzf /backups/uploads-YYYYMMDD-HHMMSS.tgz -C /app/uploads
docker compose start backend web
```

(If you kept the default folder, use `backups/` instead of `/var/backups/arena`.)

## 7. Updating (new version, and monthly security updates)

```sh
cd /opt/arena/deploy && ./backup.sh /var/backups/arena
git pull && docker compose pull && docker compose build --pull && docker compose up -d
```

Do this about **once a month** even when the app has not changed: it brings
in the security fixes for PostgreSQL, Caddy and Alpine Linux (the images
everything runs on). If `up` ever says the network needs to be recreated,
run `docker compose down` and then `docker compose up -d` (the data stays in
the volumes).

The backend finishes requests in progress before it stops (up to 30 s) and
applies database changes by itself when it starts. Rebuilds reuse Go's and
npm's caches, so an update rebuilds only what changed (seconds). The start
settings (`start_interval` in `docker-compose.yml`) need Docker Engine 25
or newer - `curl -fsSL https://get.docker.com | sh` and Docker Desktop
install that; if `docker compose` rejects `start_interval`, update Docker.

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

To try the app **by yourself** on a Mac, use section 10 instead: it runs the
real setup (no demo accounts) and nothing is open to the internet.

`npm run dev:api` and `cloudflared tunnel --url http://localhost:3000`
(`brew install cloudflared`) give a temporary `https://...trycloudflare.com`
address (Vite allows those hosts). It works only while the laptop is on, the
address changes on every start, and the demo accounts (password `123456`)
are open to anyone with the link - their logins are visible on the sign-in
screen. Use test data only (never real customers or the real PromptPay
number), and stop the tunnel (Ctrl+C) as soon as the demo is over.

## 10. Test the real setup on a Mac (Docker Desktop, free)

The same three containers as on a server (database, backend, Caddy), on
your Mac at `http://localhost` - no demo accounts, nothing open to the
internet. For trying the app yourself before renting a server.

1. Install **Docker Desktop for Mac** (docker.com - pick Apple chip or
   Intel chip as in Apple menu → About This Mac), open it once and leave it
   running (whale icon in the menu bar).
2. Get the code (if macOS offers the "command line developer tools", install
   them and run it again):
   ```sh
   git clone https://github.com/proudkittapa/temp.git ~/arena
   ```
3. Settings - the random passwords are written straight into the files.
   Put **your own** PromptPay phone number in the third line (test QR codes
   then pay to you; the app does not start without a real number):
   ```sh
   cd ~/arena
   cp deploy/.env.example deploy/.env
   cp golang-backend/.env.example golang-backend/.env
   sed -i '' "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" deploy/.env
   sed -i '' "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" golang-backend/.env
   sed -i '' "s/^PROMPTPAY_ID=.*/PROMPTPAY_ID=0812345678/" golang-backend/.env
   chmod 600 deploy/.env golang-backend/.env
   ```
   (`sed -i ''` is the Mac form; on Linux it is `sed -i`.) Leave
   `SITE_ADDRESS=:80` in `deploy/.env`.
4. Start (the first time builds for 3-6 minutes):
   ```sh
   cd ~/arena/deploy
   docker compose up -d --build
   docker compose ps      # db, backend, web: running / healthy
   ```
   Open **http://localhost**. If it says the port is already allocated,
   another program uses port 80 - stop it, or ask for help.
5. Make yourself the admin: register on http://localhost with your phone
   number, then (your number):
   ```sh
   docker compose exec backend /app/arena-backend make-admin 0812345678        # shows the account
   docker compose exec backend /app/arena-backend make-admin 0812345678 --yes  # if it is yours
   ```
   Sign in again: the counter (`#/staff`) and settings (`#/admin`) open.
   To test staff roles, register more accounts with made-up numbers (e.g.
   `0800000001`) and give them a role in Admin → บัญชีสตาฟเวร.
6. On your phone (same Wi-Fi): `ipconfig getifaddr en0` on the Mac prints
   e.g. `192.168.1.23` - open `http://192.168.1.23` on the phone (allow
   incoming connections if macOS asks).

| Task | Command (in `~/arena/deploy`) |
|---|---|
| Stop (data kept) | `docker compose stop` |
| Start again | `docker compose start` |
| Latest version | `cd ~/arena && git pull && cd deploy && docker compose up -d --build` |
| Errors | `docker compose logs -f backend` |
| Wipe the test data, start fresh | `docker compose down -v` then `docker compose up -d --build` |

It works only while the Mac is on and awake, and only on your Wi-Fi. Every
visitor reaches it through Docker Desktop's network, so the login limit
counts them as one address - fine for one tester, one more reason this is
not for customers. `down -v` deletes everything in the test copy; never use
it on a real server (section 8).
