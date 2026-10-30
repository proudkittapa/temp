import { lazy, type ComponentType } from 'react';
import { UserRole } from './types';

// The counter and settings screens (and the dashboard's charts) load on
// demand: customers' phones don't download them. React 19 keeps a Suspense
// fallback ("กำลังโหลด...") on screen for ~300 ms before revealing what it
// waited for, even when the file arrives in 10 ms - so each lazy screen
// cost ~0.3 s for nothing (the admin page two of them in a row). A screen
// fetched before it is drawn renders at once: its loader then hands
// React.lazy a thenable that resolves synchronously, which never suspends.
type Loaded<P> = { default: ComponentType<P> };

function preloadable<P>(load: () => Promise<Loaded<P>>) {
  let loaded: Loaded<P> | undefined;
  let pending: Promise<Loaded<P>> | undefined;
  const preload = () => (pending ??= load().then(
    m => (loaded = m),
    err => { pending = undefined; throw err; } // offline: try again next time
  ));
  const Component = lazy(() => loaded
    ? ({ then: (resolve: (m: Loaded<P>) => void) => resolve(loaded!) } as unknown as Promise<Loaded<P>>)
    : preload());
  return { Component, preload };
}

const staff = preloadable(() => import('./components/StaffPOS'));
const admin = preloadable(() => import('./components/AdminPanel'));
const dashboard = preloadable(() => import('./components/admin/DashboardTab'));
export const StaffPOS = staff.Component;
export const AdminPanel = admin.Component;
export const DashboardTab = dashboard.Component;

// Fetches the code of the screen a role opens, resolved once it is in;
// never rejects - a failed fetch is retried by React.lazy when the screen
// is drawn. The settings screen opens on its dashboard: the charts (~125 KB)
// are fetched alongside but not waited for, so the sign-in box doesn't wait
// for them on a slow phone - they are in by the time someone has signed in.
export function preloadScreen(role: UserRole): Promise<unknown> {
  if (role === UserRole.ADMIN) dashboard.preload().catch(() => undefined);
  const load = role === UserRole.STAFF || role === UserRole.MANAGER ? staff.preload()
    : role === UserRole.ADMIN ? admin.preload() : Promise.resolve();
  return load.catch(() => undefined);
}

// Each panel has its own address: the customer site is "/", the counter
// "#/staff" (managers sign in there too), settings "#/admin". Hash routes
// work on any static host without server rewrites.
const ROUTES: Record<string, UserRole> = { '#/staff': UserRole.STAFF, '#/manager': UserRole.MANAGER, '#/admin': UserRole.ADMIN };
export const roleFromHash = () => ROUTES[window.location.hash] ?? UserRole.CUSTOMER;
export const hashForRole = (role: UserRole) => Object.keys(ROUTES).find(h => ROUTES[h] === role) ?? '#/';
