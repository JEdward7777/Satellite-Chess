import { describe, expect, it } from 'vitest';

import type { GameSnapshot } from '../src/shared/protocol.js';
import type { Color } from '../src/shared/squares.js';
import {
  type AlertLevel,
  type AudioContextLike,
  CRITICAL_TIME_MS,
  LOW_TIME_MS,
  alertLevel,
  clockReadout,
  createClockAlerts,
  estimateServerNow,
  nextAlert,
} from '../src/client/clock.js';

/** Only the parts of a snapshot the clock readout looks at. */
type ClockView = Pick<GameSnapshot, 'clock' | 'serverNow' | 'you'>;

function view(over: Partial<ClockView> = {}): ClockView {
  return {
    clock: { whiteMs: 600_000, blackMs: 600_000, incrementMs: 10_000, active: 'w', startedAt: 1_000 },
    serverNow: 1_000,
    you: 'w',
    ...over,
  };
}

describe('estimateServerNow', () => {
  /**
   * The whole point of the module: the phone's clock is not the server's, and a
   * game must not care by how much.
   */
  it('measures elapsed time locally rather than trusting the phone\'s clock', () => {
    // The server says 1,000. The phone happens to think it is 9,000,000.
    const game = view({ serverNow: 1_000 });
    expect(estimateServerNow(game, 9_000_000, 9_000_000)).toBe(1_000);
    expect(estimateServerNow(game, 9_000_000, 9_002_500)).toBe(3_500);
  });

  it('never runs backwards when the handset\'s clock steps back', () => {
    const game = view({ serverNow: 1_000 });
    // NTP correction between the snapshot arriving and this frame.
    expect(estimateServerNow(game, 5_000, 4_000)).toBe(1_000);
  });
});

describe('clockReadout', () => {
  it('counts the active player down and leaves the other alone', () => {
    const game = view();
    // Twelve seconds of local time since the snapshot arrived at local 50,000.
    const readout = clockReadout(game, 50_000, 62_000);
    expect(readout.mineMs).toBe(588_000);
    expect(readout.theirsMs).toBe(600_000);
    expect(readout.running).toBe(true);
    expect(readout.yourTurn).toBe(true);
  });

  it('resolves mine and theirs from the seat this phone holds', () => {
    const game = view({ you: 'b' });
    const readout = clockReadout(game, 50_000, 62_000);
    // White is active, so it is the *opponent's* clock going down here.
    expect(readout.mineMs).toBe(600_000);
    expect(readout.theirsMs).toBe(588_000);
    expect(readout.yourTurn).toBe(false);
  });

  it('holds both clocks still while the game is not running', () => {
    // What a staging or suspended game looks like: no start instant.
    const game = view({
      clock: { whiteMs: 600_000, blackMs: 480_000, incrementMs: 0, active: 'w', startedAt: null },
    });
    const readout = clockReadout(game, 50_000, 500_000);
    expect(readout.mineMs).toBe(600_000);
    expect(readout.theirsMs).toBe(480_000);
    expect(readout.running).toBe(false);
  });

  it('clamps at zero rather than showing a negative clock', () => {
    const game = view({
      clock: { whiteMs: 5_000, blackMs: 600_000, incrementMs: 0, active: 'w', startedAt: 1_000 },
    });
    const readout = clockReadout(game, 50_000, 100_000);
    expect(readout.mineMs).toBe(0);
    expect(readout.mine).toBe('0.0');
  });

  it('formats tenths under ten seconds and mm:ss above it', () => {
    const game = view({
      clock: { whiteMs: 9_400, blackMs: 65_000, incrementMs: 0, active: 'w', startedAt: 1_000 },
    });
    const readout = clockReadout(game, 50_000, 50_000);
    expect(readout.mine).toBe('9.4');
    expect(readout.theirs).toBe('1:05');
  });
});

describe('alert thresholds', () => {
  it('escalates as the clock runs down', () => {
    expect(alertLevel(LOW_TIME_MS + 1)).toBe('none');
    expect(alertLevel(LOW_TIME_MS)).toBe('low');
    expect(alertLevel(CRITICAL_TIME_MS + 1)).toBe('low');
    expect(alertLevel(CRITICAL_TIME_MS)).toBe('critical');
    expect(alertLevel(0)).toBe('critical');
  });

  it('fires once per crossing rather than on every frame', () => {
    let level: AlertLevel = 'none';
    const fired: AlertLevel[] = [];
    // Ten frames a second, all of them under a minute.
    for (const remaining of [59_000, 58_900, 58_800, 58_700]) {
      const decision = nextAlert(level, alertLevel(remaining));
      level = decision.level;
      if (decision.fire) fired.push(decision.level);
    }
    expect(fired).toEqual(['low']);
  });

  it('fires again when it gets worse', () => {
    let level: AlertLevel = 'none';
    const fired: AlertLevel[] = [];
    for (const remaining of [59_000, 30_000, 14_000, 3_000]) {
      const decision = nextAlert(level, alertLevel(remaining));
      level = decision.level;
      if (decision.fire) fired.push(decision.level);
    }
    expect(fired).toEqual(['low', 'critical']);
  });

  /**
   * The increment genuinely hands time back (decision 0012 prices it at a move's
   * travel), so a player who climbs back over a minute has to be warned again if
   * they fall under it. Latching would silence the warning for the rest of the
   * game after one brush with it.
   */
  it('re-arms when the increment lifts the clock back over the threshold', () => {
    let level: AlertLevel = 'none';
    const fired: AlertLevel[] = [];
    for (const remaining of [55_000, 75_000, 55_000]) {
      const decision = nextAlert(level, alertLevel(remaining));
      level = decision.level;
      if (decision.fire) fired.push(decision.level);
    }
    expect(fired).toEqual(['low', 'low']);
  });
});

// ---------------------------------------------------------------------------
// The announcement itself
// ---------------------------------------------------------------------------

class FakeAudio implements AudioContextLike {
  currentTime = 0;
  destination = {};
  state = 'suspended';
  resumed = 0;
  closed = 0;
  readonly tones: number[] = [];

  async resume(): Promise<void> {
    this.resumed++;
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.closed++;
  }

  createOscillator() {
    const self = this;
    return {
      type: '',
      frequency: {
        set value(hz: number) {
          self.tones.push(hz);
        },
        get value() {
          return self.tones[self.tones.length - 1] ?? 0;
        },
      },
      connect() {},
      start() {},
      stop() {},
    };
  }

  createGain() {
    return {
      gain: {
        value: 0,
        setValueAtTime() {},
        exponentialRampToValueAtTime() {},
      },
      connect() {},
    };
  }
}

describe('clock alerts', () => {
  it('vibrates and sounds, because neither is reliable outdoors on its own', () => {
    const patterns: (number | number[])[] = [];
    const audio = new FakeAudio();
    const alerts = createClockAlerts({
      vibrate: (pattern) => {
        patterns.push(pattern);
        return true;
      },
      createAudio: () => audio,
    });

    alerts.arm();
    alerts.fire('low');

    expect(patterns).toHaveLength(1);
    expect(audio.tones).toEqual([660]);
    // Safari hands back a suspended context even inside a gesture.
    expect(audio.resumed).toBe(1);
  });

  it('is louder and higher when it is critical', () => {
    const audio = new FakeAudio();
    const alerts = createClockAlerts({ vibrate: null, createAudio: () => audio });
    alerts.arm();
    alerts.fire('critical');
    expect(audio.tones).toEqual([990]);
  });

  /**
   * A phone with no vibration, or one that has refused audio, must still play a
   * game. Every capability here is optional and none of them may throw.
   */
  it('survives a browser with neither vibration nor audio', () => {
    const alerts = createClockAlerts({ vibrate: null, createAudio: null });
    expect(() => {
      alerts.arm();
      alerts.fire('low');
      alerts.fire('critical');
      alerts.dispose();
    }).not.toThrow();
  });

  it('survives an audio context that refuses to be created', () => {
    const alerts = createClockAlerts({
      vibrate: null,
      createAudio: () => {
        throw new Error('blocked');
      },
    });
    expect(() => {
      alerts.arm();
      alerts.fire('low');
    }).not.toThrow();
  });

  it('does not sound before it has been armed inside a gesture', () => {
    const audio = new FakeAudio();
    const alerts = createClockAlerts({ vibrate: null, createAudio: () => audio });
    alerts.fire('low');
    expect(audio.tones).toEqual([]);
  });

  it('builds one context however many times it is armed', () => {
    let built = 0;
    const alerts = createClockAlerts({
      vibrate: null,
      createAudio: () => {
        built++;
        return new FakeAudio();
      },
    });
    alerts.arm();
    alerts.arm();
    alerts.arm();
    expect(built).toBe(1);
  });

  it('closes its context on teardown, so a finished game frees the audio hardware', () => {
    const audio = new FakeAudio();
    const alerts = createClockAlerts({ vibrate: null, createAudio: () => audio });
    alerts.arm();
    alerts.dispose();
    expect(audio.closed).toBe(1);
  });

  it('keeps going when vibration throws rather than returning false', () => {
    const audio = new FakeAudio();
    const alerts = createClockAlerts({
      vibrate: () => {
        throw new Error('not allowed outside a user gesture');
      },
      createAudio: () => audio,
    });
    alerts.arm();
    expect(() => alerts.fire('low')).not.toThrow();
    // The sound still happened, which is the point of catching.
    expect(audio.tones).toEqual([660]);
  });
});

describe('the clock a player actually sees during a move', () => {
  /**
   * Guards the reason `predict` nulls `startedAt` when it flips the active
   * colour (`client/optimistic.ts`). Flipping alone would have the opponent's
   * clock ticking from the instant the *mover's* turn began, so it would appear
   * to lose their whole think time in one jump the moment a piece went down.
   */
  it('does not charge the opponent for the mover\'s thinking', () => {
    const serverNow = 200_000;
    // White has been thinking for three minutes: their clock started at 20,000.
    const optimistic = view({
      clock: { whiteMs: 600_000, blackMs: 600_000, incrementMs: 10_000, active: 'b', startedAt: null },
      serverNow,
    });
    const readout = clockReadout(optimistic, 0, 500);
    expect(readout.theirsMs).toBe(600_000);
    expect(readout.mineMs).toBe(600_000);
    expect(readout.running).toBe(false);
  });

  it('would have been badly wrong without it', () => {
    // The same snapshot with the stale start instant left in place, to show what
    // the guarded bug looks like: black loses three minutes it never spent.
    const broken = view({
      clock: { whiteMs: 600_000, blackMs: 600_000, incrementMs: 10_000, active: 'b', startedAt: 20_000 },
      serverNow: 200_000,
      you: 'w',
    });
    expect(clockReadout(broken, 0, 0).theirsMs).toBe(420_000);
  });
});

describe('both seats agree about the same clock', () => {
  it('reads the same regardless of which phone is asking', () => {
    const clock = {
      whiteMs: 300_000,
      blackMs: 250_000,
      incrementMs: 0,
      active: 'b' as Color,
      startedAt: 1_000,
    };
    const white = clockReadout({ clock, serverNow: 5_000, you: 'w' }, 0, 2_000);
    // The black phone's own clock is an hour out and its snapshot arrived later.
    const black = clockReadout({ clock, serverNow: 5_000, you: 'b' }, 3_600_000, 3_602_000);
    expect(white.mineMs).toBe(black.theirsMs);
    expect(white.theirsMs).toBe(black.mineMs);
  });
});
