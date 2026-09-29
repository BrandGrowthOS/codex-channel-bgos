/**
 * The session controls contract: the tokens, ops, words and limits that the
 * BGOS backend and two channel plugins must agree on for Stop, Resume and the
 * Sessions library (P6 stage 3, C-32).
 *
 * THIS FILE IS COPIED BYTE FOR BYTE between
 *   github.com/BrandGrowthOS/BGOS
 *     backend/src/integrations/session-controls-contract.ts
 *   github.com/BrandGrowthOS/codex-channel-bgos
 *     src/session-controls-contract.ts
 *   github.com/BrandGrowthOS/bgos-claude-plugin
 *     lib/session-controls-contract.ts
 * and each repo pins the sha256 of its own copy, as a literal, in a test
 * (BGOS: backend/src/integrations/session-controls-contract.pin.spec.ts;
 * codex-channel-bgos: test/session-controls-contract.pin.spec.ts;
 * bgos-claude-plugin: test/session-controls-contract.pin.test.ts). The three
 * literals are the same digest. Changing this file means changing ALL THREE
 * copies and ALL THREE pinned digests in one set of PRs; a change that lands
 * in one repo only turns that repo's pin red, and that is the point.
 *
 * Rules, so every toolchain reads the same bytes unchanged:
 *  - no imports, LF line endings, and the BGOS backend's prettier style;
 *  - ERASABLE TypeScript only: exported const, interface and type, never an
 *    enum, a namespace, a decorator or a class, because the Claude plugin
 *    runs its copy through node's type stripping, which refuses anything
 *    that would emit code of its own.
 *
 * The app is another workspace and does not import this file. It keeps its
 * own copy of the words it shows and sends in
 * frontend/expo-app/src/components/chat/sessionControlsContract.ts, and a
 * cross tree guard beside it (sessionControlsContract.guard.test.ts) holds
 * each of them equal to this file.
 */

/**
 * Declared by a daemon that answers the three Sessions ops below. The backend
 * shows the Sessions circle, and forwards a Sessions request, only for a
 * pairing that declares it.
 */
export const SESSIONS_LIBRARY = 'sessions_library';

/**
 * Declared only by a daemon whose owner Stop PAUSES the chat's open mission
 * with STOP_PAUSE_REASON instead of failing it. The canon's Stop sentences
 * for that channel are gated on it, so the token ships in the same release
 * as the code that keeps it.
 */
export const STOP_PAUSES_MISSION = 'stop_pauses_mission';

/** Every token this file names, in the order above. */
export const SESSION_CONTROL_TOKENS: readonly string[] = Object.freeze([
  SESSIONS_LIBRARY,
  STOP_PAUSES_MISSION,
]);

/** The voice_rpc op that lists this chat's runtime sessions. */
export const LIST_SESSIONS = 'list_sessions';

/** The voice_rpc op that binds one of those sessions to the chat. */
export const RESUME_SESSION = 'resume_session';

/** The voice_rpc op that gives one of those sessions a new name. */
export const RENAME_SESSION = 'rename_session';

export type SessionOp =
  | typeof LIST_SESSIONS
  | typeof RESUME_SESSION
  | typeof RENAME_SESSION;

/** Every Sessions op, in the order above. */
export const SESSION_OPS: readonly SessionOp[] = Object.freeze([
  LIST_SESSIONS,
  RESUME_SESSION,
  RENAME_SESSION,
]);

/**
 * The reason a daemon writes when an owner Stop pauses a mission. The app
 * shows it localised; the daemon resumes, on the owner's next message, ONLY a
 * mission paused with exactly this reason, so an owner's own Pause from the
 * Mission view is never undone by a message.
 */
export const STOP_PAUSE_REASON = 'Stopped by you';

/** The chat line a daemon posts after it really cancelled the turn (Codex). */
export const STOP_CONFIRMATION_HARD = 'Stopped.';

/**
 * The chat line a daemon posts when its stop is a request to a live model
 * (Claude Code). It is posted when the notice is delivered, before the model
 * has stood down, so it claims the asking and nothing more.
 */
export const STOP_CONFIRMATION_COOPERATIVE = 'Asked to stop.';

/**
 * What the app's Resume button sends, as an ordinary plain text message: no
 * slash, no options, no new wire field, never localised. The canon tells every
 * agent what this exact sentence means. Read by BGOS only; the plugins carry
 * it so that the three copies stay one file.
 */
export const RESUME_TURN_TEXT = 'Continue from where you stopped.';

/** At most this many rows in one list answer. */
export const SESSIONS_LIST_MAX = 50;

/** A row's title, in characters after trimming. */
export const SESSION_TITLE_MAX = 120;

/** A row's one line preview, in characters after trimming. */
export const SESSION_PREVIEW_MAX = 200;

/** A row's branch name, in characters after trimming. */
export const SESSION_BRANCH_MAX = 60;

/** A new name from the app: 1 to this many characters, no line breaks. */
export const SESSION_RENAME_MAX = 80;

/** A search query from the app, in characters. */
export const SESSION_QUERY_MAX = 80;

/** A session id, as a daemon lists it and the app sends it back. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Why a daemon refused a Sessions op (`ok:false`, `error.code`). */
export type SessionErrorCode =
  | 'busy'
  | 'not_found'
  | 'unsupported'
  | 'invalid'
  | 'failed';

/** Every refusal code, in the order above. */
export const SESSION_ERROR_CODES: readonly SessionErrorCode[] = Object.freeze([
  'busy',
  'not_found',
  'unsupported',
  'invalid',
  'failed',
]);

/** The runtime a list answer came from. */
export type SessionRuntime = 'codex' | 'claude-code';

/** What this runtime can do to a listed session from the app. */
export interface SessionAbilities {
  resume: boolean;
  rename: boolean;
}

/** One runtime session, as a daemon lists it. */
export interface SessionRow {
  id: string;
  /** Empty when `withheld` is set. */
  title: string;
  /**
   * Set when the daemon withheld the title because it looked like it held a
   * secret. The whole field is withheld, never partly masked; a withheld
   * preview is simply left out.
   */
  withheld?: 'secret';
  preview?: string | null;
  /** ISO 8601, or null when the runtime did not record it. */
  lastActivityAt?: string | null;
  branch?: string | null;
  /** The session this chat is bound to right now. At most one per list. */
  current?: boolean;
}

/** `list_sessions` payload, backend to daemon. */
export interface ListSessionsPayload {
  query?: string;
  limit: number;
}

/** `resume_session` payload, backend to daemon. */
export interface ResumeSessionPayload {
  sessionId: string;
}

/** `rename_session` payload, backend to daemon. */
export interface RenameSessionPayload {
  sessionId: string;
  title: string;
}

/** `list_sessions` answer on `ok:true`, daemon to backend. */
export interface ListSessionsAnswer {
  sessions: SessionRow[];
  abilities: SessionAbilities;
  truncated: boolean;
  runtime: SessionRuntime;
}

/** `resume_session` answer on `ok:true`, daemon to backend. */
export interface ResumeSessionAnswer {
  resumed: true;
  sessionId: string;
  title: string;
}

/** `rename_session` answer on `ok:true`, daemon to backend. */
export interface RenameSessionAnswer {
  renamed: true;
  sessionId: string;
  title: string;
}
