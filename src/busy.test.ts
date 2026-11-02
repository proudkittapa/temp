import { describe, it, expect } from 'vitest';
import { beginAction, dismissRunningActions, blockingActions, busySnapshot } from './busy';

const blocking = () => blockingActions(busySnapshot()).length;

describe('busy actions', () => {
  it('blocks while any action runs, until every one has ended', () => {
    const endA = beginAction();
    const endB = beginAction();
    expect(blocking()).toBe(2);
    endA();
    endA(); // ending twice changes nothing
    expect(blocking()).toBe(1);
    endB();
    expect(blocking()).toBe(0);
    expect(busySnapshot().actions).toEqual([]);
  });

  it('closing the box frees the page from the running actions only; a new action blocks again', () => {
    const endSlow = beginAction();
    dismissRunningActions();
    expect(blocking()).toBe(0);
    const endNext = beginAction();
    expect(blocking()).toBe(1);
    endNext();
    endSlow();
    expect(busySnapshot()).toEqual({ actions: [], dismissed: [] });
  });
});
