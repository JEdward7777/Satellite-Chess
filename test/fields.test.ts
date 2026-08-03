import { describe, expect, it } from 'vitest';

import { type FieldSpec, makeFieldSpec, snapshotField } from '../src/shared/field.js';
import { type FieldLink, fieldKey, originKeyFor } from '../src/shared/fieldlink.js';
import { fromLocal } from '../src/shared/geo.js';
import { adoptField, keepGameField, offerFor } from '../src/client/fields.js';
import { createMemoryFieldStore } from '../src/client/store.js';

/**
 * What a phone does with a field somebody else calibrated.
 *
 * The copying is trivial; the policy is not. A player who joins six games on the
 * same common must end with one field, a friend who re-calibrates and shares
 * again must improve the copy rather than sit beside it, and none of that may
 * ever reach back and change the sender's. Those three are the whole of stage
 * 6.4 and decision 0027, and none of them is visible in a screenshot.
 */

const A1 = { lat: 51.4779, lng: -0.0015 };

function local(name = 'The common', opts: Partial<FieldSpec> = {}): FieldSpec {
  return {
    ...makeFieldSpec(name, { a1: A1, h8: fromLocal(A1, { e: 56, n: 56 }) }, { id: 'local-1', now: 1000 }),
    ...opts,
  };
}

function incoming(over: Partial<FieldLink> = {}): FieldLink {
  return {
    name: 'The common',
    a1: A1,
    h8: fromLocal(A1, { e: 56, n: 56 }),
    origin: { key: originKeyFor('theirs'), version: 1 },
    ...over,
  };
}

describe('deciding whether to copy at all', () => {
  it('adds a field nothing here matches', () => {
    expect(offerFor(incoming(), [local()]).kind).toBe('new');
  });

  it('recognises a copy it already holds', () => {
    const held = local('The common', {
      origin: { key: originKeyFor('theirs'), version: 1, via: 'link' },
    });
    expect(offerFor(incoming(), [held]).kind).toBe('have');
  });

  it('offers an update when the sender has re-calibrated since', () => {
    const held = local('The common', {
      origin: { key: originKeyFor('theirs'), version: 1, via: 'link' },
    });
    const offer = offerFor(incoming({ origin: { key: originKeyFor('theirs'), version: 2 } }), [
      held,
    ]);
    expect(offer.kind).toBe('update');
  });

  it('does not offer to downgrade to an older calibration', () => {
    // Links are forwarded, saved and re-sent. An old one arriving after a new
    // one must not quietly move a board back to corners its owner has replaced.
    const held = local('The common', {
      origin: { key: originKeyFor('theirs'), version: 5, via: 'link' },
    });
    expect(offerFor(incoming(), [held]).kind).toBe('have');
  });

  it('recognises the sender\'s own field coming back to them', () => {
    // A field walked out here has no `origin`, so its lineage key is derived
    // from its own id. Without that, someone who opened their own link would be
    // offered a second copy of ground they calibrated themselves.
    const mine = local();
    const back = incoming({ origin: { key: fieldKey(mine), version: mine.version } });
    expect(offerFor(back, [mine]).kind).toBe('have');
  });

  it('does not merge two fields that merely sit on the same grass', () => {
    // Two people tapping corners on the same park produce genuinely different
    // boards — different corners, different square sizes. Merging them by
    // proximity would move somebody's game.
    const mine = local();
    expect(offerFor(incoming(), [mine]).kind).toBe('new');
  });
});

describe('taking the copy', () => {
  it('writes a field of the recipient\'s own, with the sender\'s ground', async () => {
    const store = createMemoryFieldStore();
    const link = incoming({ name: 'Hackney Marshes' });
    const saved = await adoptField(store, offerFor(link, []), 'link', 2000);

    expect(saved.name).toBe('Hackney Marshes');
    expect(saved.a1).toEqual(link.a1);
    expect(saved.origin).toEqual({ key: link.origin.key, version: 1, via: 'link' });
    // A fresh local id: two phones sharing one would collide the moment either
    // of them shared it onwards.
    expect(saved.id).not.toBe('theirs');
    expect(await store.list()).toHaveLength(1);
  });

  it('updates in place, keeping the local id', async () => {
    // Anything already pointing at this field — the screen in front of the
    // player — goes on pointing at it.
    const store = createMemoryFieldStore();
    const held = local('The common', {
      origin: { key: originKeyFor('theirs'), version: 1, via: 'link' },
      a1Accuracy: 4,
      h8Accuracy: 4,
    });
    await store.save(held);

    const better = incoming({
      a1: { lat: 51.478, lng: -0.0016 },
      origin: { key: originKeyFor('theirs'), version: 2 },
    });
    const saved = await adoptField(store, offerFor(better, [held]), 'link', 3000);

    expect(saved.id).toBe('local-1');
    expect(saved.a1).toEqual(better.a1);
    // The lineage's counter, not one more than ours: the version belongs to the
    // field, not to a phone.
    expect(saved.version).toBe(2);
    // The sender's accuracy readings are not in the link, and keeping ours would
    // attach the old corners' diagnostics to new corners.
    expect(saved.a1Accuracy).toBeUndefined();
    expect(await store.list()).toHaveLength(1);
  });

  it('writes nothing when the field is already held', async () => {
    const store = createMemoryFieldStore();
    const held = local('The common', {
      origin: { key: originKeyFor('theirs'), version: 1, via: 'link' },
    });
    await store.save(held);
    const saved = await adoptField(store, offerFor(incoming(), [held]), 'link');
    expect(saved).toBe(held);
    expect(await store.list()).toEqual([held]);
  });

  it('records how the copy arrived', async () => {
    const store = createMemoryFieldStore();
    const saved = await adoptField(store, offerFor(incoming(), []), 'game');
    expect(saved.origin?.via).toBe('game');
  });
});

describe('keeping the field a game was played on (decision 0027)', () => {
  const theirs = makeFieldSpec('The common', { a1: A1, h8: fromLocal(A1, { e: 56, n: 56 }) }, {
    id: 'creator-field',
    now: 500,
  });

  it('saves it the first time, on a phone that has calibrated nothing', async () => {
    const store = createMemoryFieldStore();
    const kept = await keepGameField(store, snapshotField(theirs));
    expect(kept?.name).toBe('The common');
    expect(kept?.origin).toEqual({ key: originKeyFor('creator-field'), version: 1, via: 'game' });
  });

  it('does not accumulate a field per game on the same ground', async () => {
    // The one that would be noticed: a regular fixture on the same common, once
    // a week, leaving a list of identical entries nobody can tell apart.
    const store = createMemoryFieldStore();
    for (let i = 0; i < 6; i++) await keepGameField(store, snapshotField(theirs, 1000 + i));
    expect(await store.list()).toHaveLength(1);
  });

  it('says nothing happened when nothing happened', async () => {
    const store = createMemoryFieldStore();
    await keepGameField(store, snapshotField(theirs));
    expect(await keepGameField(store, snapshotField(theirs))).toBeNull();
  });

  it('improves the copy when the creator has re-calibrated since', async () => {
    const store = createMemoryFieldStore();
    await keepGameField(store, snapshotField(theirs));
    const moved = { ...theirs, a1: { lat: 51.478, lng: -0.0016 }, version: 2 };
    const kept = await keepGameField(store, snapshotField(moved));
    expect(kept?.a1).toEqual(moved.a1);
    expect(await store.list()).toHaveLength(1);
  });

  it('leaves the creator\'s own field alone when they rejoin their own game', async () => {
    // The join is idempotent, so a creator reloading their own link comes back
    // through exactly this path. Their field is already theirs.
    const store = createMemoryFieldStore();
    await store.save(theirs);
    expect(await keepGameField(store, snapshotField(theirs))).toBeNull();
    expect((await store.list())[0].origin).toBeUndefined();
  });

  it('recognises a link for ground it kept from a game', async () => {
    // The two ways a field arrives have to agree, or a player who has played on
    // a common would be offered it again as a stranger's field when a friend
    // sends the link.
    const store = createMemoryFieldStore();
    await keepGameField(store, snapshotField(theirs));
    const link = incoming({ origin: { key: originKeyFor('creator-field'), version: 1 } });
    expect(offerFor(link, await store.list()).kind).toBe('have');
  });
});
