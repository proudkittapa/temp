import { useEffect, useState } from 'react';

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
    const onStorage = (e: StorageEvent) => {
      if (e.key) bump();
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
