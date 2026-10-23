/// <reference types="vite/client" />

interface ImportMetaEnv {
  // "api" routes bookings/auth through the Go backend; anything else keeps
  // the localStorage-only mode. See src/api.ts.
  readonly VITE_DATA_SOURCE?: 'api' | 'local';
  readonly VITE_API_BASE_URL?: string;
}

// Court counts for the browser-only seed, read by vite.config.ts from
// BASKETBALL_COURT_COUNT etc. (see parseCourtCounts in mockData.ts).
declare const __COURT_COUNTS__: { basketball?: string; badminton?: string; pickleball?: string; meetingRoom?: string };
declare const __MAX_HOURS_PER_BOOKING__: string;
