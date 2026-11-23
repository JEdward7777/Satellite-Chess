/**
 * Getting a remote game's recalibrated field to the server (stage 12.3,
 * decision 0063).
 *
 * The field is walked with the board's socket closed, saved on the phone, and
 * then sent as one `recalibrate` on the board's new socket. One message is not
 * one attempt: a socket that dies between opening and the frame reaching the
 * server would leave the saved field changed and the game on the old one, with
 * nothing on screen to say so (found in review). So it is sent again on every
 * socket that opens, until a snapshot shows this seat playing on the field
 * that was sent, or the server refuses it — whose own sentence the board
 * shows, as it shows any refusal. A duplicate that arrives is harmless: the
 * same field written twice. Until one of those, the board claims no back
 * rank (`pending`).
 *
 * Never on a timer and never more than once a socket, so it costs at most one
 * inbound message per reconnect, and in the ordinary case exactly one.
 */

import type { FieldSpec } from '../shared/field.js';
import type { ErrorMsg, GameSnapshot } from '../shared/protocol.js';
import type { GameConnection, NetState } from './net.js';

/** Whether this snapshot's field — the receiver's own — is the one that was sent. */
export function recalibrationApplied(game: Pick<GameSnapshot, 'field'>, sent: FieldSpec): boolean {
  const field = game.field;
  return (
    field.fieldId === sent.id &&
    field.version === sent.version &&
    field.a1.lat === sent.a1.lat &&
    field.a1.lng === sent.a1.lng &&
    field.h8.lat === sent.h8.lat &&
    field.h8.lng === sent.h8.lng
  );
}

/** The refusals that end the attempt: the field itself, or a game no longer paused. */
function ends(error: ErrorMsg): boolean {
  return error.code === 'bad_field' || error.code === 'not_active';
}

export type RecalibrationOutcome = 'applied' | 'refused' | 'over' | 'superseded';

export interface PendingRecalibration {
  /**
   * True until the field is applied, refused, or the game is no longer
   * suspended. **While it is, nothing on this phone may claim a back rank**
   * (review, round 2): a `ready` or a relay on a reconnected socket is judged
   * on the board the server still has, and an opponent waiting on theirs
   * would resume the game on the old field before the new one arrived.
   */
  pending(): boolean;
  /** Stop, for a board torn down first. */
  stop(): void;
}

/**
 * Send `field` as a recalibration on each socket `connection` opens, until it
 * is applied, refused, or moot.
 *
 * Sent once per socket, and only once that socket's first snapshot has
 * arrived and says the game is still suspended and still on the old field:
 * so it follows the `sync`, is not sent at all when the copy before was
 * applied and only its snapshot was lost, and is never sent into a game that
 * has moved on (which would come back as "Pause the game first").
 */
export function sendRecalibration(
  connection: Pick<GameConnection, 'subscribe' | 'send'>,
  field: FieldSpec,
  opts: { onDone?: (outcome: RecalibrationOutcome) => void } = {},
): PendingRecalibration {
  let done = false;
  let wasOpen = false;
  /** Waiting for this socket's first snapshot: the game object in hand when it opened. */
  let awaiting: { game: GameSnapshot | null } | null = null;
  /** The error showing when the last copy went, so only an answer to it counts. */
  let errorAtSend: ErrorMsg | null | undefined;
  let off: (() => void) | null = null;

  const finish = (outcome: RecalibrationOutcome) => {
    if (done) return;
    done = true;
    off?.();
    opts.onDone?.(outcome);
  };

  const listener = (state: NetState) => {
    if (done) return;
    const game = state.game;
    if (game !== null && recalibrationApplied(game, field)) {
      finish('applied');
      return;
    }
    const error = state.lastError;
    if (errorAtSend !== undefined && error !== null && error !== errorAtSend && ends(error)) {
      finish('refused');
      return;
    }
    const open = state.status === 'open';
    if (open && !wasOpen) awaiting = { game };
    if (!open) awaiting = null;
    wasOpen = open;
    // This socket's first snapshot: a game object other than the one held at the open.
    if (awaiting !== null && game !== null && game !== awaiting.game) {
      awaiting = null;
      if (game.status !== 'suspended' || game.result != null) {
        finish('over');
        return;
      }
      // A newer walk of the same field is already in play (another phone of
      // this account got there first): this older one must not undo it.
      if (game.field.fieldId === field.id && game.field.version > field.version) {
        finish('superseded');
        return;
      }
      errorAtSend = error;
      connection.send({ t: 'recalibrate', field });
    }
  };

  off = connection.subscribe(listener);
  // `subscribe` calls back at once, which may already have finished.
  if (done) off();
  return {
    pending: () => !done,
    stop: () => {
      done = true;
      off?.();
    },
  };
}

// ---------------------------------------------------------------------------
// Kept on the phone until it lands (review, round 3)
// ---------------------------------------------------------------------------
//
// A recalibration not yet applied must outlive the board that sent it: a
// reload, a tab the phone discarded while its owner walked the corners,
// Home and back. Without this the next board had nothing to wait for, said
// `ready` on the old board, and the game went on on the old field while the
// saved one was new. So it is written down when the field is saved, read back
// by every board for that game, and forgotten at any of the three endings.
//
// Keyed by the account as well as the game, so another account on this phone
// can never send it: the server would take it for whichever seat the sending
// account holds. A storage that throws or refuses (O-28) costs only the
// surviving copy, never the board.

const PENDING_KEY = 'satchess.recalibrations';

/** The slice of `Storage` this uses, so a test can pass a map. */
export interface RecalibrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface PendingRecord {
  /** The account that walked it, or null on a phone that has never known one. */
  sub: string | null;
  field: FieldSpec;
}

function readAll(storage: RecalibrationStorage | null): Record<string, PendingRecord> {
  if (storage === null) return {};
  try {
    const parsed = JSON.parse(storage.getItem(PENDING_KEY) ?? '{}') as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, PendingRecord>)
      : {};
  } catch {
    return {};
  }
}

function writeAll(storage: RecalibrationStorage | null, all: Record<string, PendingRecord>): void {
  if (storage === null) return;
  try {
    storage.setItem(PENDING_KEY, JSON.stringify(all));
  } catch {
    // Full or refused: the board still sends it; only a reload would lose it.
  }
}

/** Write down a recalibration this account has saved for this game and not yet seen applied. */
export function rememberRecalibration(
  storage: RecalibrationStorage | null,
  joinCode: string,
  sub: string | null,
  field: FieldSpec,
): void {
  writeAll(storage, { ...readAll(storage), [joinCode]: { sub, field } });
}

/** The recalibration still on its way for this game and this account, or null. */
export function pendingRecalibration(
  storage: RecalibrationStorage | null,
  joinCode: string,
  sub: string | null,
): FieldSpec | null {
  const record = readAll(storage)[joinCode];
  if (record === undefined || typeof record !== 'object' || record === null) return null;
  if (record.sub !== sub || typeof record.field !== 'object' || record.field === null) return null;
  // A record tampered with, or from a build that wrote another shape, is
  // nothing: the board compares its corners on every snapshot.
  const corner = (p: unknown) =>
    typeof p === 'object' && p !== null && typeof (p as { lat?: unknown }).lat === 'number' && typeof (p as { lng?: unknown }).lng === 'number';
  if (!corner(record.field.a1) || !corner(record.field.h8)) return null;
  return record.field;
}

/**
 * Forget it, once it has landed, been refused, or the game has moved on —
 * only if it is still this field: a later recalibration of the same game
 * replaces the record and must not be forgotten by the earlier one's ending.
 */
export function forgetRecalibration(storage: RecalibrationStorage | null, joinCode: string, field: FieldSpec): void {
  const all = readAll(storage);
  const record = all[joinCode];
  if (record === undefined || record === null) return;
  if (record.field?.id !== field.id || record.field?.version !== field.version) return;
  delete all[joinCode];
  writeAll(storage, all);
}
