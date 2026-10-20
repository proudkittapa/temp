/// <reference types="vite/client" />

interface ImportMetaEnv {
  // "api" routes bookings/auth through the Go backend; anything else keeps
  // the localStorage-only mode. See src/api.ts.
  readonly VITE_DATA_SOURCE?: 'api' | 'local';
  readonly VITE_API_BASE_URL?: string;
}
