# Sports Complex Management System

A multi-sport arena management platform: customer booking + PromptPay
checkout, front-desk POS (walk-ins, F&B, equipment rental), and an admin
console (pricing engine, maintenance scheduling, audit log). See
`REQUIREMENTS.md` for the full functional spec and `BACKEND_PLAN.md` for the
production Go/PostgreSQL architecture.

- **Frontend** (`src/`): React 19 + TypeScript + Tailwind, Vite-bundled. This
  is what actually runs today - it persists all state to the browser's
  `localStorage` (see `StorageService` in `src/mockData.ts`), so it needs no
  backend or database to use.
- **Backend** (`golang-backend/`): a Go + PostgreSQL service implementing the
  same data model, mirrored for a future migration off `localStorage`. It is
  not wired up to the frontend yet.

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

Not wired up to the frontend - the frontend runs entirely on `localStorage`
today (see NFR-1 in `REQUIREMENTS.md`). This is the reference implementation
for a future migration to a real database. Full setup (PostgreSQL, env vars,
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

Running the server itself (`go run main.go`) additionally requires a
PostgreSQL database - see `golang-backend/README.md` for the DDL, env vars,
and example requests.

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
