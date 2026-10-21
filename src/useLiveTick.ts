import { DependencyList, useEffect, useRef, useState } from 'react';

// A counter that goes up every intervalMs while the page is visible, and at
// once when the user comes back to it (tab switched back, phone unlocked,
// window focused). Screens add it to their data-loading effects so what they
// show follows the server - new slips, another counter's bookings, a
// payment approved - without anyone clicking. In browser-only mode another
// tab's change (a storage event) bumps it too. Hidden tabs don't poll.
export function useLiveTick(intervalMs: number, enabled = true): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    const bump = () => {
      last = Date.now();
      setTick(t => t + 1);
    };
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') bump();
    }, intervalMs);
    // Coming back: refresh unless we just did.
    const onReturn = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > 3000) bump();
    };
    // Hidden tabs ignore it too (they reload when shown). At most one per
    // 3 s: every reload rewrites cached keys, and two open tabs must not
    // keep waking each other.
    const onStorage = (e: StorageEvent) => {
      if (e.key && document.visibilityState === 'visible' && Date.now() - last > 3000) bump();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    window.addEventListener('storage', onStorage);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('storage', onStorage);
    };
  }, [intervalMs, enabled]);
  return tick;
}

// Runs load at once and whenever deps change - a run that deps overtook (an
// older date, a signed-out user) has its result dropped: isCurrent() turns
// false - and again on every tick of useLiveTick. A tick never drops the
// run in progress and is skipped while one is still going: when a load took
// longer than the interval, each tick used to cancel the one before it, so
// the screen froze on old data while looking live, load errors never
// showed, and the unaborted requests piled up behind a stalled backend.
export function useLiveLoad(
  load: (isCurrent: () => boolean) => Promise<unknown> | void,
  deps: DependencyList,
  tick: number
): void {
  const gen = useRef(0);
  const running = useRef(false);
  const latest = useRef(load);
  latest.current = load;
  const run = useRef(() => {
    const mine = ++gen.current;
    running.current = true;
    Promise.resolve()
      .then(() => latest.current(() => gen.current === mine))
      .catch(() => undefined) // load reports its own errors
      .finally(() => {
        if (gen.current === mine) running.current = false;
      });
  });
  useEffect(() => {
    run.current();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tick > 0 && !running.current) run.current();
  }, [tick]);
  useEffect(() => () => {
    gen.current++; // unmounted: drop what is still in flight
  }, []);
}
