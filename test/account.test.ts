import { describe, expect, it } from 'vitest';

import {
  type IdentityStorage,
  type KnownIdentity,
  PREFLIGHT_WINDOW_MS,
  accountChanged,
  clearCachedIdentity,
  forgetAccount,
  identityFromSession,
  readCachedIdentity,
  resolveLaunch,
  sessionNotice,
  timeSince,
  timeUntil,
  whoLabel,
  writeCachedIdentity,
} from '../src/client/account.js';
import { signOutFailureWords } from '../src/client/views/account.js';
import { createMemoryJournal } from '../src/client/field-sync.js';

/**
 * Who the phone remembers being, and what home says about it (stages 2.2.3–2.2.5).
 *
 * The case that matters most is in `resolveLaunch`: the cache must never become
 * a second way to close the gate. Decision 0035's rule 2 is that only a real 401
 * does, and a remembered identity that has visibly run out is the tempting
 * exception — a phone with no signal would then be shown a sign-in screen it
 * cannot complete, which is the failure the three states exist to prevent.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

function memoryStorage(initial: Record<string, string> = {}): IdentityStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

function known(overrides: Partial<KnownIdentity> = {}): KnownIdentity {
  return {
    sub: 'alice-sub',
    via: 'google',
    email: 'alice@example.com',
    expiresAt: NOW + 29 * DAY,
    confirmedAt: NOW - 2 * DAY,
    ...overrides,
  };
}

describe('remembering who the phone is (2.2.4)', () => {
  it('puts the server’s duration on this phone’s clock', () => {
    const identity = identityFromSession(
      { kind: 'signed_in', sub: 'alice', via: 'google', email: null, expiresInMs: 10 * DAY },
      NOW,
    );
    expect(identity).toEqual({
      sub: 'alice',
      via: 'google',
      email: null,
      expiresAt: NOW + 10 * DAY,
      confirmedAt: NOW,
    });
  });

  it('keeps no expiry when the server gave none, rather than inventing one', () => {
    const identity = identityFromSession(
      { kind: 'signed_in', sub: 'alice', via: 'dev', email: null, expiresInMs: null },
      NOW,
    );
    expect(identity.expiresAt).toBeNull();
  });

  it('round-trips through storage, and forgets on request', () => {
    const storage = memoryStorage();
    writeCachedIdentity(storage, known());
    expect(readCachedIdentity(storage)).toEqual(known());
    clearCachedIdentity(storage);
    expect(readCachedIdentity(storage)).toBeNull();
  });

  it('reads anything malformed as never having known', () => {
    for (const raw of [
      'not json',
      'null',
      '"a string"',
      JSON.stringify({ via: 'google', confirmedAt: NOW }),
      JSON.stringify({ sub: 'a', via: 'facebook', confirmedAt: NOW }),
      JSON.stringify({ sub: 'a', via: 'google' }),
      JSON.stringify({ sub: '', via: 'google', confirmedAt: NOW }),
    ]) {
      expect(readCachedIdentity(memoryStorage({ 'satchess.identity': raw }))).toBeNull();
    }
  });

  it('drops a bad optional field without dropping the identity', () => {
    const raw = JSON.stringify({ sub: 'a', via: 'dev', confirmedAt: NOW, email: 7, expiresAt: 'x' });
    expect(readCachedIdentity(memoryStorage({ 'satchess.identity': raw }))).toEqual({
      sub: 'a',
      via: 'dev',
      email: null,
      expiresAt: null,
      confirmedAt: NOW,
    });
  });

  it('survives a storage that throws, as some private modes do', () => {
    const hostile: IdentityStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(readCachedIdentity(hostile)).toBeNull();
    expect(() => writeCachedIdentity(hostile, known())).not.toThrow();
    expect(() => clearCachedIdentity(hostile)).not.toThrow();
    expect(readCachedIdentity(null)).toBeNull();
  });
});

describe('the launch, with a memory (decision 0035 rule 2, strengthened by 2.2.4)', () => {
  it('closes the gate on a 401 whatever the phone remembers', () => {
    expect(resolveLaunch({ kind: 'signed_out', devSeam: true }, known(), NOW)).toEqual({
      kind: 'gate',
      devSeam: true,
    });
  });

  it('opens with the server’s answer, not the memory, when the server answers', () => {
    const launch = resolveLaunch(
      {
        kind: 'signed_in',
        sub: 'bob-sub',
        via: 'google',
        email: 'bob@example.com',
        expiresInMs: 30 * DAY,
      },
      known(),
      NOW,
    );
    expect(launch).toEqual({
      kind: 'open',
      confirmed: true,
      identity: {
        sub: 'bob-sub',
        via: 'google',
        email: 'bob@example.com',
        expiresAt: NOW + 30 * DAY,
        confirmedAt: NOW,
      },
    });
  });

  it('opens knowing who it is when the server cannot be asked', () => {
    expect(resolveLaunch({ kind: 'unknown' }, known(), NOW)).toEqual({
      kind: 'open',
      identity: known(),
      confirmed: false,
    });
  });

  it('still opens with no memory at all — the cache adds words, never a door', () => {
    expect(resolveLaunch({ kind: 'unknown' }, null, NOW)).toEqual({
      kind: 'open',
      identity: null,
      confirmed: false,
    });
  });

  it('still opens when what it remembers has run out', () => {
    // The tempting "tightening": the phone *knows* its session is over, so why
    // not show the gate? Because it cannot be completed without signal, and
    // calibrating a field needs neither (decision 0013).
    const lapsed = known({ expiresAt: NOW - DAY });
    expect(resolveLaunch({ kind: 'unknown' }, lapsed, NOW)).toMatchObject({ kind: 'open' });
  });
});

describe('the pre-flight warning (2.2.3)', () => {
  it('says nothing about a session with most of its month left', () => {
    expect(sessionNotice(known(), true, NOW)).toBeNull();
    expect(sessionNotice(known(), false, NOW)).toBeNull();
  });

  it('says nothing when there is nothing to go on', () => {
    expect(sessionNotice(null, false, NOW)).toBeNull();
    expect(sessionNotice(known({ expiresAt: null }), true, NOW)).toBeNull();
  });

  it('says nothing for a dev session, which is always inside the window', () => {
    expect(sessionNotice(known({ via: 'dev', expiresAt: NOW + HOUR }), true, NOW)).toBeNull();
  });

  it('warns at the edge of the window and not before', () => {
    expect(sessionNotice(known({ expiresAt: NOW + PREFLIGHT_WINDOW_MS }), true, NOW)).toBeNull();
    expect(
      sessionNotice(known({ expiresAt: NOW + PREFLIGHT_WINDOW_MS - 1 }), true, NOW),
    ).not.toBeNull();
  });

  it('with a connection, warns and offers a fresh sign-in', () => {
    const notice = sessionNotice(known({ expiresAt: NOW + 2 * DAY + HOUR }), true, NOW);
    expect(notice).toMatchObject({ tone: 'warning', offerSignIn: true });
    expect(notice?.text).toContain('runs out in 2 days');
    expect(notice?.text).toContain('while you have a connection');
  });

  it('without one, warns but offers nothing that needs a connection', () => {
    const notice = sessionNotice(known({ expiresAt: NOW + 5 * HOUR }), false, NOW);
    expect(notice).toMatchObject({ tone: 'warning', offerSignIn: false });
    expect(notice?.text).toContain('in 5 hours');
  });

  it('says a remembered session has probably run out, and hedges', () => {
    const notice = sessionNotice(known({ expiresAt: NOW - HOUR }), false, NOW);
    expect(notice).toMatchObject({ tone: 'notice', offerSignIn: false });
    // Only this phone's clock says so, and the server cannot be asked.
    expect(notice?.text).toContain('probably');
    expect(notice?.text).toContain('Calibrating a field still works');
  });

  it('is American English, like everything a player reads (decision 0036)', () => {
    const texts = [
      sessionNotice(known({ expiresAt: NOW + DAY }), true, NOW)?.text,
      sessionNotice(known({ expiresAt: NOW + DAY }), false, NOW)?.text,
      sessionNotice(known({ expiresAt: NOW - DAY }), false, NOW)?.text,
      signOutFailureWords('offline'),
      signOutFailureWords('failed'),
    ].join(' ');
    expect(texts).not.toMatch(/metre|colour|recognis|organis|behaviour|centre|travell/i);
  });
});

describe('words for time and for people', () => {
  it('counts down coarsely', () => {
    expect(timeUntil(30 * 60 * 1000)).toBe('within the hour');
    expect(timeUntil(HOUR)).toBe('in 1 hour');
    expect(timeUntil(47 * HOUR)).toBe('in 47 hours');
    expect(timeUntil(3 * DAY + HOUR)).toBe('in 3 days');
  });

  it('counts up coarsely', () => {
    expect(timeSince(0)).toBe('just now');
    expect(timeSince(-5000)).toBe('just now');
    expect(timeSince(10 * 60 * 1000)).toBe('10 minutes ago');
    expect(timeSince(HOUR)).toBe('1 hour ago');
    expect(timeSince(4 * DAY)).toBe('4 days ago');
  });

  it('names a player by address, a test account by its name, and never by a Google sub', () => {
    expect(whoLabel(known())).toBe('alice@example.com');
    expect(whoLabel(known({ via: 'dev', email: null, sub: 'white-player' }))).toBe(
      'test account “white-player”',
    );
    const label = whoLabel(known({ email: null, sub: '117554968855954827048' }));
    expect(label).toBe('your Google account');
    expect(label).not.toContain('117554968855954827048');
  });
});

describe('forgetting an account (decision 0039, rule 4)', () => {
  it('drops the identity and empties the field journal, whichever route got here', () => {
    const storage = memoryStorage();
    writeCachedIdentity(storage, known());
    const journal = createMemoryJournal({ acked: { f1: 1, f2: 2 }, removed: { f3: 3 } });
    forgetAccount(storage, journal);
    expect(readCachedIdentity(storage)).toBeNull();
    // Kept, `acked` would let the next account's first sync delete f1 and f2
    // off this phone as "deleted elsewhere".
    expect(journal.read()).toEqual({ acked: {}, removed: {} });
  });

  it('survives a journal that refuses to be written', () => {
    const journal = {
      write: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => forgetAccount(null, journal)).not.toThrow();
  });
});

describe('noticing a switched account (decision 0039, rule 4, the third route)', () => {
  const confirmedAs = (sub: string) =>
    resolveLaunch(
      { kind: 'signed_in', sub, via: 'google', email: null, expiresInMs: 30 * DAY },
      null,
      NOW,
    );

  it('forgets when the server confirms a different account than the phone remembers', () => {
    // "Sign in again", and Google's chooser came back as somebody else.
    expect(accountChanged(known({ sub: 'alice-sub' }), confirmedAs('bob-sub'))).toBe(true);
  });

  it('keeps everything when it is the same account', () => {
    expect(accountChanged(known({ sub: 'alice-sub' }), confirmedAs('alice-sub'))).toBe(false);
  });

  it('keeps everything with no memory to compare against', () => {
    expect(accountChanged(null, confirmedAs('bob-sub'))).toBe(false);
  });

  it('never decides from a launch the server did not confirm', () => {
    expect(accountChanged(known(), resolveLaunch({ kind: 'unknown' }, known(), NOW))).toBe(false);
    expect(
      accountChanged(known(), resolveLaunch({ kind: 'signed_out', devSeam: false }, known(), NOW)),
    ).toBe(false);
  });
});
