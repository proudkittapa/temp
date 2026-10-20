# Sports Complex Management System

A multi-sport arena management platform: customer booking + PromptPay
checkout, front-desk POS (walk-ins, F&B, equipment rental), and an admin
console (pricing engine, maintenance scheduling, audit log). See
`REQUIREMENTS.md` for the full functional spec and `BACKEND_PLAN.md` for the
production Go/PostgreSQL architecture. `WORKLOG.md` records what each
change did and what is still open - add an entry there before pushing to `main`.

- **Frontend** (`src/`): React 19 + TypeScript + Tailwind, Vite-bundled. By
  default it persists all state to the browser's `localStorage` (see
  `StorageService` in `src/mockData.ts`), so it needs no backend or database.
- **Backend** (`golang-backend/`): a Go + PostgreSQL service implementing the
  same data model. The frontend can use it for login, bookings and slip
  review by running in **API mode** (see below); the rest of the app is still
  `localStorage`-only.

---

## Frontend

### Prerequisites
- Node.js 20+ and npm

### Install dependencies
```bash
npm install
```

### Run the app
```bash
npm run dev
```
Starts the dev server (Vite on port 3000, via `dev-runner.js`). Everything
is kept in the browser, so this needs neither Go nor a database; Ctrl+C
stops everything it started. Open
`http://localhost:3000`. Log in as one of the seeded users (see
`DEFAULT_USERS` in `src/mockData.ts`), e.g. phone `0845678901` / password
`123456` for a seeded member customer, or use the role switcher at the top
of the page to jump straight to the Staff POS or Admin views.

### API mode (real database)
```bash
npm run dev:api
```
Same as `npm run dev`, but sets `VITE_DATA_SOURCE=api` so these features go
through the Go backend and PostgreSQL instead of `localStorage` (needs the
database from the Go Backend section below):

| Feature | Endpoint |
| --- | --- |
| Customer register / login / points balance | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Courts + availability grid | `GET /courts`, `GET /bookings?date=` |
| Multi-slot booking (one code, one PromptPay payment) | `POST /bookings` |
| Customer booking history | `GET /me/bookings` |
| Slip upload (the real image file) | `POST /bookings/:id/upload-slip` |
| Staff slip queue, verify (confirms + awards points), reject | `GET /staff/payments`, `POST /staff/payments/:id/verify`, `POST /staff/payments/:id/reject` |
| Staff walk-in bookings (PromptPay ones wait for staff to confirm the transfer) + the staff booking grid | `POST /staff/bookings`, `GET /bookings?date=` |
| Court closures / days off (Admin panel; enforced on every booking) | `GET /days-off`, `POST /admin/days-off`, `DELETE /admin/days-off/:id` |
| Pricing rules + member-tier discounts (Admin panel; what every booking is charged) | `GET /pricing`, `POST`/`PUT`/`DELETE /admin/pricing-rules`, `PUT /admin/member-discounts/:type` |
| Cancel / refund (manager), record a cash payment (manager), no-show (staff), day's cash-drawer totals | `POST /admin/bookings/:id/cancel`, `POST /admin/payments/:id/refund`, `POST /admin/bookings/:id/mark-cash`, `POST /staff/bookings/:id/no-show`, `GET /staff/summary` |
| Loyalty rewards: redeem points online, voucher check at the counter | `GET /rewards`, `POST /me/rewards/:id/redeem`, `GET /me/vouchers`, `GET`/`POST /staff/vouchers/:code[/dispense]` |
| Counter shop: products with stock (shoes per size), F&B / equipment sales, racket & shoe rentals and returns (Staff POS); products and stock changes (Admin panel → 🥤) | `GET /staff/products`, `POST /pos/order`, `GET /staff/orders?date=`, `GET /staff/rentals`, `POST /staff/rentals/items/:id/return`, `GET`/`POST /admin/products`, `PUT /admin/products/:id`, `POST /admin/products/:id/stock` |
| Admin dashboard, monthly CSV exports (bookings, counter sales), audit log (admin only) | `GET /admin/dashboard?date=`, `GET /admin/report?month=`, `GET /admin/audit-logs` |
| Users list, a customer's membership tier, manual points; staff roles and suspending accounts (admin) (Admin panel → users) | `GET /admin/users`, `PUT /admin/users/:id/member-type`, `POST /admin/users/:id/adjust-points`, `PUT /admin/users/:id/role`, `PUT /admin/users/:id/active` |

`dev-runner.js` starts the backend with `SEED_DEMO_USERS=true`, which creates
the same demo accounts as `DEFAULT_USERS` (all password `123456`) on every
start: customers `0845678901` (member) and `0856789012` (student), staff
`0834567890`, manager `0823456789`, admin `0812345678`. In dev (`npm run dev`
or `npm run dev:api`) every login screen also has one-click buttons for these
accounts; production builds don't include them. The
Staff POS panel asks staff to sign in separately from the customer, and the
Admin panel asks for a manager/admin account (e.g. manager `0823456789`;
editing prices and discounts needs the admin account `0812345678`). Price
previews in the UI are refreshed from the backend, so they always match what
the server charges.

Still `localStorage`-only in API mode (no backend endpoints yet): password
reset (planned: by phone number, see TODO.md), account deletion, and the
other Admin/Manager settings (courts,
deleting users - suspend them instead -, operating hours - the backend has its own `courts` table,
seeded to match, so a court added only in the Admin panel doesn't exist
there yet).

Set `JWT_SECRET` in `golang-backend/.env` (`openssl rand -hex 32`);
otherwise the backend picks a random one per run and everyone is logged out
when it restarts.

`VITE_API_BASE_URL` overrides the API location (default `/api/v1`, which
Vite proxies to `localhost:8080`).

### Type-check
```bash
npm run lint
```
Runs `tsc --noEmit`. No build step is required to catch type errors.

### Run the tests
```bash
npm test
```
Runs the Vitest suite (`src/mockData.test.ts`), covering the booking/pricing
business logic: the FR-1.2 mutex-group rule (a full court blocks every
half-court side, but two half-court sides do NOT block each other), and the
FR-2 pricing engine (half-court rate, membership discount, and their order
of application).

### Production build
```bash
npm run build   # outputs to dist/
npm run preview # serve the built output locally
```

---

## Go Backend (`golang-backend/`)

Used by the frontend's API mode (`npm run dev:api`, above) for auth,
bookings and slip review; everything else in the frontend still runs on
`localStorage` (see NFR-1 in `REQUIREMENTS.md`). Full setup (PostgreSQL, env vars,
running the server, example `curl` calls) is documented in
`golang-backend/README.md`; the short version:

```bash
cd golang-backend
go mod tidy          # install dependencies
go build ./...        # compile
go vet ./...           # static checks
go test ./... -v       # run the unit tests (no database needed)
```

The unit tests (`internal/model/mutex_test.go`,
`internal/service/price_engine_service_test.go`) cover the same booking
conflict and pricing logic as the frontend tests, as pure functions with no
DB dependency - they're the fastest way to check a change to that logic
before touching a real database.

Running the server itself (`go run main.go`) additionally requires a local
PostgreSQL database. Quickest path on macOS with Homebrew:
```bash
brew install postgresql@16
brew services start postgresql@16
psql postgres -c "CREATE ROLE arena_user WITH LOGIN PASSWORD 'ArenaSecurePass99';"
psql postgres -c "CREATE DATABASE arena_db OWNER arena_user;"
```
No manual schema step needed - `go run main.go` creates every table via
GORM's `AutoMigrate` and seeds the pricing config + courts on first run. See
`golang-backend/README.md` for Docker/hosted-DB alternatives, env vars, and
example `curl` requests.

---

## Project Layout
```
├── REQUIREMENTS.md        # Functional requirements spec
├── BACKEND_PLAN.md        # Go + PostgreSQL architecture blueprint (incl. DDL)
├── src/
│   ├── types.ts           # Domain types/enums (Court, Booking, Payment, ...)
│   ├── mockData.ts         # StorageService (localStorage), seed data, business logic
│   ├── mockData.test.ts    # Vitest suite for the business logic above
│   └── components/         # CustomerPanel, StaffPOS, AdminPanel
└── golang-backend/
    ├── README.md            # Go backend-specific setup & API examples
    ├── internal/model/       # Structs + mutex_test.go
    ├── internal/repository/  # DB access (booking conflict resolution, pricing rules)
    └── internal/service/     # Business logic + price_engine_service_test.go
```
