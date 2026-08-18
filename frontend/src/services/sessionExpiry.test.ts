import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armSessionExpiry,
  currentSessionEpoch,
  isSessionExpiryNotified,
  notifySessionExpired,
  onSessionExpired,
  resetSessionExpiry,
} from './sessionExpiry';

describe('sessionExpiry', () => {
  beforeEach(() => {
    resetSessionExpiry();
  });

  it('notifies every subscriber once per expiry', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = onSessionExpired(first);
    const unregisterSecond = onSessionExpired(second);

    notifySessionExpired();
    notifySessionExpired();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(isSessionExpiryNotified()).toBe(true);

    armSessionExpiry();
    expect(isSessionExpiryNotified()).toBe(false);
    notifySessionExpired();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);

    unregisterFirst();
    unregisterSecond();
    armSessionExpiry();
    notifySessionExpired();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('ignores an expiry reported for a superseded session', () => {
    const handler = vi.fn();
    const unregister = onSessionExpired(handler);
    const epoch = currentSessionEpoch();

    resetSessionExpiry(); // a new sign-in happened while the request was in flight
    notifySessionExpired(epoch);

    expect(handler).not.toHaveBeenCalled();
    unregister();
  });

  it('replays a pending expiry to every later subscriber', () => {
    notifySessionExpired();

    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = onSessionExpired(first);
    const unregisterSecond = onSessionExpired(second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unregisterFirst();
    unregisterSecond();
  });
});
