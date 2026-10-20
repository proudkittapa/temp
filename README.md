# Sports Complex Management System

A multi-sport arena management platform: customer booking + PromptPay
checkout, front-desk POS (walk-ins, F&B, equipment rental), and an admin
console (pricing engine, maintenance scheduling, audit log). See
`REQUIREMENTS.md` for the full functional spec and `BACKEND_PLAN.md` for the
production Go/PostgreSQL architecture.

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
Starts the dev server (Vite on port 3000, proxied through `dev-runner.js`,
which also tries to start the Go backend on port 8080 - see below). Open
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

`dev-runner.js` starts the backend with `SEED_DEMO_USERS=true`, which creates
the same demo accounts as `DEFAULT_USERS` (all password `123456`): customers
`0845678901` (member) and `0856789012` (student), staff `0834567890`. The
Staff POS slip tab asks staff to sign in separately from the customer.

Still `localStorage`-only in API mode (no backend endpoints yet): walk-in
bookings and the staff booking grid, POS / F&B / rentals, reward redemption,
password reset, account deletion, and all Admin/Manager settings. So walk-ins
recorded at the counter don't yet block online bookings, and vice versa.

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
