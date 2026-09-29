/**
 * The credentials a COMMAND LINE carries, masked for the approval card's
 * title, which is also the push body and the chat list preview.
 *
 * `redactOutput` was built for output and passes every shape below through
 * verbatim; the stage 5 whole diff review listed them. These rules add to it
 * and never replace it, mask only the value, and leave a command that carries
 * no credential exactly as it was.
 *
 * MUTATION PROOFS, run by hand against this tree:
 *  - drop the `mysql_glued_password` rule's program scope (match `\s-p<value>`
 *    anywhere) -> "leaves ordinary flags alone" goes red on `mkdir -pv out`
 *    and `ssh -p 22 host`.
 */
import { describe, expect, it } from "vitest";

import {
  COMMAND_REDACT_RULE_IDS,
  redactCommandLine,
} from "../src/redact-command.js";
import { redactOutput } from "../src/redact-output.js";

describe("redactCommandLine", () => {
  it("names its rules, in order", () => {
    expect(COMMAND_REDACT_RULE_IDS).toEqual([
      "url_userinfo_password",
      "user_colon_password",
      "basic_auth_header",
      "env_secret_assignment",
      "secret_flag",
      "mysql_glued_password",
      "sshpass_password",
    ]);
  });

  it("masks every shape the output mask misses, value only", () => {
    const cases: Array<[string, string]> = [
      ["curl -u admin:hunter2 https://api.example.com", "curl -u admin:[hidden] https://api.example.com"],
      ["curl --user=admin:hunter2 x", "curl --user=admin:[hidden] x"],
      ["git clone https://kc:S3cretPass@github.com/o/r.git", "git clone https://kc:S3cr...@github.com/o/r.git"],
      ["ftp://u:pw@host/file", "ftp://u:[hidden]@host/file"],
      ["curl -H 'Authorization: Basic YWRtaW46aHVudGVyMg==' x", "curl -H 'Authorization: Basic YWRt...' x"],
      ["PGPASSWORD=hunter2 psql -h db", "PGPASSWORD=[hidden] psql -h db"],
      ["API_KEY=abc123 ./run", "API_KEY=[hidden] ./run"],
      ["export GITHUB_TOKEN=\"ghp_short\" && x", "export GITHUB_TOKEN=\"ghp_...\" && x"],
      ["MYSQL_PWD='a b c' mysql", "MYSQL_PWD='[hidden]' mysql"],
      ["mysqldump --password Secret1 app", "mysqldump --password [hidden] app"],
      ["deploy --token=ghx_short1 prod", "deploy --token=ghx_... prod"],
      ["az login --client-secret s3cr3tvalue", "az login --client-secret s3cr..."],
      ["tool --api-key k1", "tool --api-key [hidden]"],
      ["mysql -u root -pSecret1 app", "mysql -u root -p[hidden] app"],
      ["sshpass -p hunter2 ssh host", "sshpass -p [hidden] ssh host"],
    ];
    for (const [raw, masked] of cases) {
      expect(redactCommandLine(raw)).toBe(masked);
    }
  });

  it("leaves ordinary flags alone", () => {
    for (const clean of [
      "mkdir -pv out",
      "ssh -p 22 host",
      "docker run -p 8080:80 img",
      "cp -p a b",
      "rm -rf build",
      "curl https://api.example.com/v1?a=1",
      "echo exec-probe > probe.txt",
      "git push origin main",
    ]) {
      expect(redactCommandLine(clean)).toBe(clean);
    }
  });

  it("leaves a template, and what the output mask already masked, as it was", () => {
    expect(redactCommandLine("API_KEY=${API_KEY} ./run")).toBe("API_KEY=${API_KEY} ./run");
    expect(redactCommandLine("deploy --token <your-token>")).toBe("deploy --token <your-token>");
    const once = redactOutput("PASSWORD=abcdefghijklmnopqrstuv ./run");
    expect(once).toBe("PASSWORD=abcd... ./run");
    expect(redactCommandLine(once)).toBe(once);
  });
});
