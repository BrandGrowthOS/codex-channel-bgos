/**
 * The secrets a COMMAND LINE carries, masked, for the one place a command
 * leaves the app: the approval card's title, which is also the push body and
 * the chat list preview.
 *
 * `redactOutput` is a port of the platform's pack scanner and was built for
 * OUTPUT. It knows the shapes a key takes once printed (an `sk-...`, a JWT, a
 * key block, a `password=` of sixteen characters or more). It does not know
 * the ways a command line passes a credential, and the stage 5 whole diff
 * review listed them: `curl -u admin:hunter2`, `git clone
 * https://user:pass@host/...` (the scanner's connection string rule names only
 * five database schemes), `PGPASSWORD=hunter2 psql` and `API_KEY=abc123 ./run`
 * (the scanner's assignment rule wants sixteen characters), and `mysql
 * -pSecret1` or `--password Secret1` (no `:` or `=` after the key word). Each
 * of those went verbatim into the title and so onto a lock screen.
 *
 * These rules run AFTER `redactOutput`, never instead of it, and mask only the
 * VALUE, with the same `maskValue` the output mask uses (the first four
 * characters and an ellipsis, or `[hidden]` whole for eight characters or
 * fewer, because four characters of a short password is the password), so the
 * line still reads as the command it is.
 *
 * They over mask on purpose. A title that hides a harmless `--token-file
 * path` value costs a word; one that shows a password costs the password.
 */
import { isPlaceholderValue, maskValue } from "./redact-output.js";

interface CommandRule {
  id: string;
  /** Global regex. Capture group `value` is the secret. */
  pattern: RegExp;
}

/**
 * A value: a double or single quoted string, or a run of anything that is not
 * whitespace or a quote. Named `value` so every rule masks the same group.
 */
const VALUE = `(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'|(?<value>[^\\s'"]+))`;

const COMMAND_RULES: readonly CommandRule[] = [
  // `scheme://user:pass@host`, for ANY scheme (https, ssh, ftp, git ...), not
  // only the five database schemes the output scanner names.
  {
    id: "url_userinfo_password",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:(?<value>[^\s@/'"]+)@/gi,
  },
  // curl and wget style `-u user:pass`, `--user user:pass`, `--user=user:pass`.
  // Only the part after the first colon is the secret.
  {
    id: "user_colon_password",
    pattern:
      /(?:^|\s)(?:-u|--user|--proxy-user)(?:\s+|=)['"]?[^\s:'"]+:(?<value>[^\s'"]+)/g,
  },
  // `Authorization: Basic <base64>`; the output scanner knows only Bearer.
  {
    id: "basic_auth_header",
    pattern: /\bBasic\s+(?<value>[A-Za-z0-9+/=]{8,})/g,
  },
  // An environment assignment whose NAME says it is a credential, at any
  // length: `PGPASSWORD=x`, `API_KEY=abc123`, `export GITHUB_TOKEN="..."`.
  {
    id: "env_secret_assignment",
    pattern: new RegExp(
      `(?:^|[\\s;&|(])[A-Za-z0-9_]*(?:PASS|PASSWD|PASSWORD|PWD|TOKEN|SECRET|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_]*=${VALUE}`,
      "gi",
    ),
  },
  // A flag whose name says it carries a credential, with `=` or a space:
  // `--password Secret1`, `--token=abc`, `--client-secret x`, `--api-key x`.
  {
    id: "secret_flag",
    pattern: new RegExp(
      `(?:^|\\s)--?(?:[a-z0-9]+-)*(?:password|passwd|pass|token|secret|api-?key|auth)(?:=|\\s+)${VALUE}`,
      "gi",
    ),
  },
  // The MySQL family's glued `-pSecret1`. Scoped to those programs, because
  // `-p` alone is `mkdir -p`, `ssh -p 22` and `docker run -p 80:80`.
  {
    id: "mysql_glued_password",
    pattern:
      /\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mariadb(?:-dump|-admin)?)\b[^\n|;&]*?\s-p(?<value>[^\s'"]+)/g,
  },
  // `sshpass -p secret`.
  {
    id: "sshpass_password",
    pattern: /\bsshpass\s+-p\s*(?<value>[^\s'"]+)/g,
  },
];

/** The rule ids, in evaluation order. Pinned by the test beside this file. */
export const COMMAND_REDACT_RULE_IDS: readonly string[] = COMMAND_RULES.map(
  (rule) => rule.id,
);

/**
 * The command with every credential these rules recognise masked. Run it on
 * the output of `redactOutput`: this adds shapes, it does not replace them.
 */
export function redactCommandLine(command: string): string {
  let text = command;
  for (const rule of COMMAND_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    text = text.replace(pattern, (...args: unknown[]) => {
      const whole = args[0] as string;
      const groups = args[args.length - 1] as Record<string, string | undefined>;
      const secret = groups.value ?? groups.dq ?? groups.sq;
      if (typeof secret !== "string" || secret.length === 0) return whole;
      if (isPlaceholderValue(secret)) return whole;
      // Already masked by the output pass (`sk-p...`, `[hidden]`): leave it.
      if (secret === "[hidden]" || /^.{0,4}\.\.\.$/.test(secret)) return whole;
      const at = whole.lastIndexOf(secret);
      if (at < 0) return whole;
      return whole.slice(0, at) + maskValue(secret) + whole.slice(at + secret.length);
    });
  }
  return text;
}
