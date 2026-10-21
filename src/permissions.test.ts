import { describe, it, expect, vi, afterEach } from 'vitest';
import { can, canUseCounter, canUseSettings, permissionsOf, PERMISSIONS } from './permissions';
import { UserRole } from './types';
import { migrateLegacySessions, getSession } from './api';

describe('can / screens by permission', () => {
  it('uses the permissions the server sent, over the built-in role', () => {
    const cashier = { role: 'role-abc' as UserRole, permissions: ['sell_rent', 'shifts'] };
    expect(can(cashier, 'sell_rent')).toBe(true);
    expect(can(cashier, 'verify_slips')).toBe(false);
    expect(canUseCounter(cashier)).toBe(true);
    expect(canUseSettings(cashier)).toBe(false);
  });

  it('falls back to the built-in role when no permissions were sent', () => {
    expect(canUseCounter({ role: UserRole.CUSTOMER })).toBe(false);
    expect(canUseCounter({ role: UserRole.STAFF })).toBe(true);
    expect(canUseSettings({ role: UserRole.STAFF })).toBe(false);
    expect(canUseSettings({ role: UserRole.MANAGER })).toBe(true);
    expect(can({ role: UserRole.MANAGER }, 'edit_pricing')).toBe(false);
    expect(permissionsOf({ role: UserRole.ADMIN })).toHaveLength(PERMISSIONS.length);
    expect(can(null, 'book_online')).toBe(false);
  });
});

function stubLocalStorage(seed: Record<string, string>) {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  });
  return store;
}

describe('one login per browser (upgrade from per-screen sessions)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const session = (name: string) => JSON.stringify({ token: `t-${name}`, user: { id: name, name } });

  it('keeps the staff/admin session over a customer one and drops the old keys', () => {
    const store = stubLocalStorage({
      sports_complex_api_session_customer: session('cust'),
      sports_complex_api_session_staff: session('staff'),
    });
    migrateLegacySessions();
    expect(getSession()?.token).toBe('t-staff');
    expect([...store.keys()]).toEqual(['sports_complex_api_session']);
  });

  it('never overwrites a session already stored the new way', () => {
    stubLocalStorage({ sports_complex_api_session: session('new'), sports_complex_api_session_admin: session('old') });
    migrateLegacySessions();
    expect(getSession()?.token).toBe('t-new');
  });
});
