import { useSyncExternalStore } from 'react';

// Server actions in progress - every write api.request sends (bookings,
// payments, sales, settings, sign-in, slip upload); reads (the live refresh)
// don't count. While one is out the whole app is blocked - `inert` on #root:
// no clicks, no typing, no focus - so nothing can be pressed twice or
// changed under it; BusyOverlay (outside #root) shows the loading box.
// The block is set here, synchronously, so even a double-click within the
// same frame lands on the blocked page.
//
// Writes have no time limit (their outcome matters; a retry reuses the
// Idempotency-Key), so the box offers to be closed after a while: the
// actions then carry on unseen and the page is usable again.

interface Action { id: number; at: number }
export interface BusyState { actions: Action[]; dismissed: number[] }

let nextId = 1;
let state: BusyState = { actions: [], dismissed: [] };
const listeners = new Set<() => void>();

// Actions still running that the user hasn't closed the box on.
export const blockingActions = (s: BusyState) => s.actions.filter(a => !s.dismissed.includes(a.id));

function set(next: BusyState) {
  state = next;
  const root = typeof document !== 'undefined' ? document.getElementById('root') : null;
  if (root) root.inert = blockingActions(state).length > 0;
  listeners.forEach(l => l());
}

// Starts an action; call the returned function once it has finished.
export function beginAction(): () => void {
  const id = nextId++;
  set({ ...state, actions: [...state.actions, { id, at: Date.now() }] });
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    set({ actions: state.actions.filter(a => a.id !== id), dismissed: state.dismissed.filter(d => d !== id) });
  };
}

// "Close this box": the actions running now continue in the background.
export function dismissRunningActions() {
  set({ ...state, dismissed: state.actions.map(a => a.id) });
}

export const busySnapshot = (): BusyState => state;

export function useBusyState(): BusyState {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l); }; },
    busySnapshot
  );
}
