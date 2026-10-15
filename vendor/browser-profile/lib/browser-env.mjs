/**
 * browser-env: the environment the browser host, and the Chrome it starts,
 * are given. An ALLOW-LIST, on purpose.
 *
 * WHY NOT A DENY-LIST BY NAME. The first version dropped BGOS_ and HOAI_
 * names and anything that said TOKEN, SECRET, PASSWORD or KEY. Measured on a
 * real daemon's environment, it kept SSH_AUTH_SOCK, GH_PAT, ANTHROPIC_KEY and
 * CLAUDE_CODE_SESSION_ID. SSH_AUTH_SOCK is the serious one: it is not a
 * secret string but a live handle to the user's ssh-agent, which signs for
 * whoever reaches the socket, and on the owner's machines that agent holds
 * the key to production. Chrome is the one process in this design that loads
 * untrusted pages, so it is the last process that should inherit it, and no
 * rule about names can see it, because its name is accurate and harmless.
 *
 * So both environments are built from what the process NEEDS, and nothing
 * else passes unless the owner names it in HOAI_BROWSER_CHROME_ENV. The old
 * name rule stays as a second pass over the allowed set, so even an opted-in
 * name that says TOKEN or KEY is dropped.
 *
 * Plain JavaScript, no dependencies: bin/hoai-browser-host.mjs (node) and
 * lib/browser-host-supervisor.ts (the daemon, under bun) both import it, so
 * there is one list.
 */

/** Names that look like a credential: the second pass, never the first. */
export const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY)/i

/** Every platform: where things are, who the user is, the locale, the clock. */
export const BASE_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'TZ']

/** LC_ALL, LC_CTYPE and the rest of the locale family. */
const LOCALE_NAME = /^LC_[A-Z]+$/

/**
 * Linux and the other X11 or Wayland systems, and ONLY for a browser that is
 * shown: the display and the desktop session. A headless browser needs none
 * of it, and the session bus address is itself a handle (the keyring answers
 * on it), so it is not given to one that does not need it.
 */
export const DISPLAY_ENV = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']

/** Windows: the system folders and facts a process cannot start without. */
export const WINDOWS_ENV = [
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
]

/** The owner's opt-in: more names for Chrome (and so for the host). */
export const OPT_IN_ENV = 'HOAI_BROWSER_CHROME_ENV'

/**
 * What the HOST needs beyond the base: its own settings, the one node
 * setting its TLS to the backend may depend on (a path, not a secret), and
 * where OneDrive is, so its kept downloads guard can refuse a synced folder
 * (lib/browser-downloads.mjs syncedRoots). The Node host also needs the exact
 * session bus and runtime directory for its privileged OS key-store helpers,
 * including with a headless browser. Headless Chrome gets none of these.
 */
export const HOST_ONLY_ENV = ['HOAI_BROWSER_EXECUTABLE', 'HOAI_BROWSER_HEADED', 'HOAI_BROWSER_HOST_AGENTS', OPT_IN_ENV, 'NODE_EXTRA_CA_CERTS', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'ONEDRIVE', 'ONEDRIVECONSUMER', 'ONEDRIVECOMMERCIAL']

/** The names in HOAI_BROWSER_CHROME_ENV, upper cased. */
export function optedInNames(env) {
  return String(env?.[OPT_IN_ENV] ?? '')
    .split(/[\s,]+/)
    .map((n) => n.trim().toUpperCase())
    .filter((n) => /^[A-Z_][A-Z0-9_()]*$/.test(n))
}

function allowedNames({ platform, headed, env, extra = [] }) {
  const names = new Set(BASE_ENV)
  if (platform === 'win32') for (const n of WINDOWS_ENV) names.add(n)
  if (headed && platform !== 'win32' && platform !== 'darwin') for (const n of DISPLAY_ENV) names.add(n)
  for (const n of extra) names.add(n)
  for (const n of optedInNames(env)) names.add(n)
  return names
}

/** Keeps the allowed names (case-insensitively, as Windows spells `Path`), then drops credential-looking ones. */
function pick(env, allowed) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (!allowed.has(upper) && !LOCALE_NAME.test(upper)) continue
    if (SECRET_ENV_NAME.test(name)) continue
    out[name] = value
  }
  return out
}

/**
 * The environment Chrome is started with.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ platform?: string, headed?: boolean }} [opts]
 * @returns {Record<string, string>}
 */
export function chromeEnv(env = process.env, { platform = process.platform, headed = false } = {}) {
  return pick(env, allowedNames({ platform, headed, env }))
}

/**
 * The environment the daemon starts the host with, before it adds the
 * host's own pairing variables. It carries what Chrome may get (the host
 * passes it on through chromeEnv) plus the host's own settings.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ platform?: string }} [opts]
 * @returns {Record<string, string>}
 */
export function hostEnv(env = process.env, { platform = process.platform } = {}) {
  const headed = String(env?.HOAI_BROWSER_HEADED ?? '').trim() === '1'
  return pick(env, allowedNames({ platform, headed, env, extra: HOST_ONLY_ENV }))
}
