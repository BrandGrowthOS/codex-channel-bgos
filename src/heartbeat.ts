/**
 * Daemon liveness + error telemetry for the BGOS channel (contract C1).
 *
 * Two sinks:
 *   1. Network: POST /api/v1/integrations/heartbeat every
 *      CODEX_BGOS_HEARTBEAT_INTERVAL seconds (default 60, 0 disables) PLUS
 *      once on start and on every error transition. Backend touches
 *      last_seen_at + records daemon_version / last_error_*.
 *   2. Local file: `$CODEX_BGOS_HOME/bgos_heartbeat.json` written every 30s and on
 *      state change, atomic tmp+rename mode 0600. Read by the fork watchdog.
 *
 * During a fatal latch (revoked / rotated token) the network sink is disabled
 * but the local file keeps writing so the watchdog can see the lastError.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HeartbeatLastError {
  code: string;
  message: string;
  at: string;
}

/** Wire shape POSTed to the backend heartbeat endpoint. */
export interface HeartbeatDto {
  daemonVersion?: string;
  uptimeS?: number;
  wsConnected?: boolean;
  lastError?: HeartbeatLastError | null;
  /** Active Codex auth mode ("chatgpt" | "apikey"), D7 surfacing. */
  authMode?: string;
}

/** Local heartbeat file shape (contract C1). */
export interface HeartbeatFileState {
  ts: string;
  pid: number;
  version: string;
  wsConnected: boolean;
  wsConnectedSince: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastError: HeartbeatLastError | null;
  pairingId: number | null;
  authMode: string | null;
}

export interface HeartbeatDeps {
  version: string;
  /** Best-effort POST to the backend heartbeat endpoint. */
  postHeartbeat: (body: HeartbeatDto) => Promise<void>;
  /** Active Codex auth mode, surfaced in the payload + local file (D7). */
  authMode?: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

const FILE_INTERVAL_MS = 30_000;

function heartbeatPath(): string {
  const root = process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos");
  return join(root, "bgos_heartbeat.json");
}

function resolveNetworkIntervalMs(): number {
  const raw = process.env.CODEX_BGOS_HEARTBEAT_INTERVAL;
  if (raw === undefined || raw === "") return 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 60_000;
  return n * 1000;
}

export class HeartbeatController {
  private wsConnected = false;
  private wsConnectedSince: string | null = null;
  private lastInboundAt: string | null = null;
  private lastOutboundAt: string | null = null;
  private lastError: HeartbeatLastError | null = null;
  private pairingId: number | null = null;

  private readonly startedAtMs: number;
  private readonly now: () => number;
  private fileTimer: NodeJS.Timeout | null = null;
  private netTimer: NodeJS.Timeout | null = null;
  private netEnabled = true;
  private started = false;

  constructor(private readonly deps: HeartbeatDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.startedAtMs = this.now();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.writeFile();
    void this.postNetwork();
    this.fileTimer = setInterval(() => this.writeFile(), FILE_INTERVAL_MS);
    this.fileTimer.unref?.();
    this.armNetworkTimer();
  }

  stop(): void {
    this.started = false;
    if (this.fileTimer !== null) {
      clearInterval(this.fileTimer);
      this.fileTimer = null;
    }
    this.clearNetworkTimer();
  }

  private armNetworkTimer(): void {
    this.clearNetworkTimer();
    const intervalMs = resolveNetworkIntervalMs();
    if (intervalMs <= 0) return; // 0 disables periodic network heartbeat
    this.netTimer = setInterval(() => void this.postNetwork(), intervalMs);
    this.netTimer.unref?.();
  }

  private clearNetworkTimer(): void {
    if (this.netTimer !== null) {
      clearInterval(this.netTimer);
      this.netTimer = null;
    }
  }

  /** Enable/disable the NETWORK sink (fatal latch disables it; recovery
   *  re-enables). The local file keeps writing regardless. */
  setNetEnabled(enabled: boolean): void {
    if (this.netEnabled === enabled) return;
    this.netEnabled = enabled;
    if (!this.started) return;
    if (enabled) {
      this.armNetworkTimer();
      void this.postNetwork();
    } else {
      this.clearNetworkTimer();
    }
  }

  setWsConnected(connected: boolean, since: string | null): void {
    if (this.wsConnected === connected && this.wsConnectedSince === since) {
      return;
    }
    this.wsConnected = connected;
    this.wsConnectedSince = since;
    this.writeFile(); // state change
  }

  setPairingId(id: number | null): void {
    this.pairingId = id;
  }

  recordInbound(): void {
    this.lastInboundAt = new Date(this.now()).toISOString();
  }

  recordOutbound(): void {
    this.lastOutboundAt = new Date(this.now()).toISOString();
  }

  /**
   * Record (or clear) the last error. A change of error CODE (including to
   * null) is an "error transition": it writes the file AND posts a network
   * heartbeat immediately.
   */
  setLastError(err: HeartbeatLastError | null): void {
    const prevCode = this.lastError?.code ?? null;
    const nextCode = err?.code ?? null;
    const transition = prevCode !== nextCode;
    this.lastError = err;
    if (transition) {
      this.writeFile();
      void this.postNetwork();
    }
  }

  /** Current error code (used by callers to decide whether to clear). */
  getLastErrorCode(): string | null {
    return this.lastError?.code ?? null;
  }

  snapshotFile(): HeartbeatFileState {
    return {
      ts: new Date(this.now()).toISOString(),
      pid: process.pid,
      version: this.deps.version,
      wsConnected: this.wsConnected,
      wsConnectedSince: this.wsConnectedSince,
      lastInboundAt: this.lastInboundAt,
      lastOutboundAt: this.lastOutboundAt,
      lastError: this.lastError,
      pairingId: this.pairingId,
      authMode: this.deps.authMode ?? null,
    };
  }

  private writeFile(): void {
    try {
      const target = heartbeatPath();
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshotFile(), null, 2), {
        mode: 0o600,
      });
      renameSync(tmp, target);
    } catch {
      /* best-effort */
    }
  }

  private async postNetwork(): Promise<void> {
    if (!this.netEnabled) return;
    if (resolveNetworkIntervalMs() <= 0) {
      // interval 0 disables periodic posts; still allow start()'s single
      // post? No: 0 means "disabled", so skip entirely.
      return;
    }
    const uptimeS = Math.max(
      0,
      Math.floor((this.now() - this.startedAtMs) / 1000),
    );
    try {
      await this.deps.postHeartbeat({
        daemonVersion: this.deps.version,
        uptimeS,
        wsConnected: this.wsConnected,
        lastError: this.lastError,
        authMode: this.deps.authMode,
      });
    } catch {
      /* best-effort: a heartbeat failure must never break the daemon */
    }
  }
}
