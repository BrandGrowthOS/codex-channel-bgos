/**
 * Outbound media-path guard.
 *
 * SECURITY (defense-in-depth): every outbound file send - `sendFile`,
 * `sendImage`, `sendVideo`, and the structured `uploadFile` - ultimately
 * hands an agent-supplied `filePath` to `publishMediaPath`, which reads it
 * off disk and ships its bytes to BGOS. Without a guard, a compromised /
 * misbehaving agent could exfiltrate ANY file the host process can read
 * (`/etc/passwd`, `~/.ssh/id_rsa`, app secrets, etc.).
 *
 * The BGOS backend is now the sole authority for chat/session resolution,
 * but it can't see the host filesystem, so the path allowlist has to live
 * here, at the boundary, before a single byte is read.
 *
 * Policy
 * ------
 *   - Resolve the requested path to an absolute, symlink-free real path.
 *   - Reject anything that isn't inside the allowed media root.
 *   - The allowed root is `CODEX_BGOS_MEDIA_ROOT` (resolved + symlink-free);
 *     when unset it defaults to `<cwd>/media`, falling back to `<cwd>`
 *     if `<cwd>/media` doesn't exist - so an out-of-the-box install can
 *     still send files the agent wrote under the working dir, while a
 *     hardened deployment can pin a narrow root.
 *   - Reject obviously-sensitive locations outright even on the off chance
 *     the root is mis-configured to a parent of them (belt + suspenders).
 *   - Reject symlinks whose real target escapes the root (handled by
 *     realpath-ing both sides before the containment check).
 *
 * On rejection we throw a clear `MediaPathError`; callers must NOT publish.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

/** Thrown when an outbound file path fails the allowlist. */
export class MediaPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaPathError";
  }
}

/**
 * Absolute prefixes that are never sendable regardless of the configured
 * root - a second line of defense in case `CODEX_BGOS_MEDIA_ROOT` is pointed
 * (mis-configured) at `/` or a home dir. Compared against the resolved
 * real path, case-sensitively (matches POSIX; the dominant deploy target).
 */
const SENSITIVE_PREFIXES: readonly string[] = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/root",
  "/var/run",
  "/run/secrets",
  // Common secret-bearing dot-dirs under the host user's home.
  resolve(homedir(), ".ssh"),
  resolve(homedir(), ".aws"),
  resolve(homedir(), ".gnupg"),
  resolve(homedir(), ".config", "gcloud"),
  resolve(homedir(), ".kube"),
  // The plugin's own pairing-token store.
  resolve(homedir(), ".codex-bgos", "secrets"),
];

/**
 * Resolve the allowed media root.
 *
 * `CODEX_BGOS_MEDIA_ROOT` wins when set. Otherwise we prefer `<cwd>/media`
 * (the conventional drop dir) and fall back to `<cwd>` when that folder
 * doesn't exist. The returned path is realpath-resolved so symlinked
 * roots are compared by their true location.
 */
function resolveMediaRoot(): string {
  const raw = process.env.CODEX_BGOS_MEDIA_ROOT?.trim();
  if (raw) {
    return realpathOrResolve(raw);
  }
  const cwd = process.cwd();
  const mediaDir = resolve(cwd, "media");
  try {
    // If `<cwd>/media` exists, pin to it (narrower = safer).
    return realpathSync(mediaDir);
  } catch {
    // No media dir - fall back to the working directory itself.
    return realpathOrResolve(cwd);
  }
}

/** realpath a path if it exists; otherwise return its absolute resolution.
 *  Used for the ROOT (which may legitimately not exist yet) - the target
 *  file is realpath'd separately and must exist. */
function realpathOrResolve(p: string): string {
  const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** True when `child` is the same as, or nested under, `parent`. Both must
 *  already be absolute + normalized. Uses a separator-terminated compare
 *  so `/a/media` does not match `/a/media-evil`. */
function isContained(parent: string, child: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(withSep);
}

/**
 * Validate an agent-supplied outbound file path against the allowlist and
 * return its resolved, symlink-free real path. Throws `MediaPathError` on
 * any rejection - the caller MUST NOT publish when this throws.
 *
 * @param filePath agent-supplied path (absolute or relative to cwd)
 */
export function resolveAllowedMediaPath(filePath: string): string {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new MediaPathError("outbound file path is empty");
  }

  // Cheap pre-check: reject NUL bytes (path-truncation tricks) and any
  // explicit parent-traversal segment before we touch the filesystem.
  if (filePath.includes("\0")) {
    throw new MediaPathError("outbound file path contains a NUL byte");
  }
  const requested = isAbsolute(filePath)
    ? filePath
    : resolve(process.cwd(), filePath);

  // realpath the target - this both proves the file exists AND collapses
  // any `..` segments and symlink hops to the true on-disk location, so a
  // symlink under the root that points outside it is caught by the
  // containment check below.
  let real: string;
  try {
    real = realpathSync(requested);
  } catch {
    throw new MediaPathError(
      `outbound file not found or unreadable: ${filePath}`,
    );
  }

  // Hard-deny sensitive locations regardless of root configuration. We
  // check BOTH the pre-resolution absolute path AND the realpath, because:
  //   - the realpath catches a symlink that points INTO a sensitive dir;
  //   - the requested path catches the literal request on platforms where
  //     the sensitive dir is itself a symlink (e.g. macOS `/etc` ->
  //     `/private/etc`), which realpath would otherwise rewrite past our
  //     prefix list.
  for (const prefix of SENSITIVE_PREFIXES) {
    if (isContained(prefix, real) || isContained(prefix, requested)) {
      throw new MediaPathError(
        `refusing to send file from a sensitive location: ${real}`,
      );
    }
  }

  // Must live under the allowed media root.
  const root = resolveMediaRoot();
  if (!isContained(root, real)) {
    throw new MediaPathError(
      `outbound file path ${real} is outside the allowed media root ${root} ` +
        `(set CODEX_BGOS_MEDIA_ROOT to widen it)`,
    );
  }

  return real;
}
