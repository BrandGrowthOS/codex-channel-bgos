/**
 * The model and effort REPORT (P5 stage 7, C-26, the Codex slice): what this
 * daemon tells HOAI a chat is really running, so the app can draw the quiet
 * row under the message box.
 *
 * The builders are pure and read RECORDED shapes only. The fixture is the
 * live 0.154.0 wire: the gate's `thread/start` response, its two
 * `thread/read` responses and its `thread/settings/updated` notification,
 * plus the one `thread/resume` response the Plugin lane recorded before
 * coding the resume reader (test/fixtures/session-report-wire.json says
 * where each came from). A `model/rerouted` has never been seen live, so its
 * params are the schema's own fields (ModelReroutedNotification, 0.154.0:
 * threadId, turnId, fromModel, toModel, reason), never a guess at more.
 *
 * Two words differ on the wire and the builders keep them apart: the
 * notification says `effort`, the responses say `reasoningEffort`. The
 * runtime says `serviceTier: "default"` where the plugin's store says `null`
 * (S13), so the report maps one onto the other and the same state never
 * costs a second write.
 *
 * No em or en dashes anywhere in this file.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SESSION_REPORT_FIELDS,
  SESSION_REPORT_PATTERNS,
  normalizeTier,
  reportRetraction,
  reportBody,
  reportFromReroute,
  reportFromStored,
  reportFromThreadResponse,
  reportFromThreadSettings,
  reportKey,
  sessionReportRetryable,
  type SessionReport,
} from "../src/session-report.js";
import { PairingRevokedError } from "../src/types.js";

const wire = JSON.parse(
  readFileSync(
    new URL("./fixtures/session-report-wire.json", import.meta.url),
    "utf8",
  ),
);
const AT = new Date("2026-09-26T09:30:00.000Z");
const AT_ISO = "2026-09-26T09:30:00.000Z";
/** The schema's three meaningful fields, plus its two identity fields. */
const REROUTE = {
  threadId: "01a0db7f-2284-7062-a185-fc8f8dd51eef",
  turnId: "01a0db7f-257d-7cc2-ae63-7e7d7a71520e",
  fromModel: "gpt-6-astra",
  toModel: "gpt-5.5",
  reason: "highRiskCyberActivity",
};

describe("the report builders read the runtime's own recorded words", () => {
  it("thread/start (request 4): the config default this chat will run", () => {
    expect(reportFromThreadResponse(wire.threadStartResponse, AT)).toEqual({
      model: "gpt-6-astra",
      effort: "ultra",
      serviceTier: null,
      rerouted: false,
      reportedAt: AT_ISO,
    });
  });

  it("thread/resume (the lane's recorded resume): the thread's own persisted pair, not the config default", () => {
    // Resumed with NO model given, exactly as ensureThread resumes a chat
    // with nothing stored. The runtime answered with the model the thread was
    // last set to (gpt-5.6-sol, medium), not the config's gpt-6-astra, ultra.
    expect(reportFromThreadResponse(wire.threadResumeResponse, AT)).toEqual({
      model: "gpt-5.6-sol",
      effort: "medium",
      serviceTier: null,
      rerouted: false,
      reportedAt: AT_ISO,
    });
  });

  it("thread/read (requests 5 and 7): the pair lives on result.thread only", () => {
    expect(wire.threadReadBeforeUpdate).not.toHaveProperty("model");
    expect(reportFromThreadResponse(wire.threadReadBeforeUpdate, AT)).toEqual({
      model: "gpt-6-astra",
      effort: "ultra",
      serviceTier: null,
      rerouted: false,
      reportedAt: AT_ISO,
    });
    expect(reportFromThreadResponse(wire.threadReadAfterUpdate, AT)).toEqual({
      model: "gpt-5.6-sol",
      effort: "medium",
      serviceTier: null,
      rerouted: false,
      reportedAt: AT_ISO,
    });
  });

  it("reads the top level first and result.thread second", () => {
    const start = structuredClone(wire.threadStartResponse);
    start.thread.model = "gpt-5.5";
    start.thread.reasoningEffort = "low";
    expect(reportFromThreadResponse(start, AT)).toMatchObject({
      model: "gpt-6-astra",
      effort: "ultra",
    });
    const resume = structuredClone(wire.threadResumeResponse);
    delete resume.model;
    delete resume.reasoningEffort;
    expect(reportFromThreadResponse(resume, AT)).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "medium",
    });
  });

  it("thread/settings/updated: the notification says effort, not reasoningEffort", () => {
    expect(wire.threadSettingsUpdated.threadSettings).toHaveProperty("effort");
    expect(wire.threadSettingsUpdated.threadSettings).not.toHaveProperty(
      "reasoningEffort",
    );
    expect(
      reportFromThreadSettings(wire.threadSettingsUpdated.threadSettings, AT),
    ).toEqual({
      model: "gpt-5.6-sol",
      effort: "medium",
      serviceTier: null,
      rerouted: false,
      reportedAt: AT_ISO,
    });
  });

  it("an effort the runtime reports as none is sent as null", () => {
    const settings = {
      ...wire.threadSettingsUpdated.threadSettings,
      effort: null,
    };
    expect(reportFromThreadSettings(settings, AT)).toMatchObject({
      model: "gpt-5.6-sol",
      effort: null,
    });
  });

  it("nothing that is not an object is read at all", () => {
    // The positive first, so a builder that answers null to everything
    // cannot pass this case.
    expect(reportFromThreadResponse(wire.threadStartResponse, AT)).not.toBeNull();
    expect(
      reportFromThreadSettings(wire.threadSettingsUpdated.threadSettings, AT),
    ).not.toBeNull();
    expect(reportFromReroute(REROUTE, null, AT)).not.toBeNull();
    for (const value of [null, undefined, "gpt-5.6-sol", 7, []]) {
      expect(reportFromThreadResponse(value, AT)).toBeNull();
      expect(reportFromThreadSettings(value, AT)).toBeNull();
      expect(reportFromReroute(value, null, AT)).toBeNull();
    }
  });
});

describe("S3: a runtime value passes the route's own patterns or is not sent", () => {
  const base = () => structuredClone(wire.threadSettingsUpdated.threadSettings);

  it("a model that fails sends NOTHING, never a rewritten id", () => {
    for (const model of ["gpt 5.6", "", "x".repeat(161), "gpt-5.6-sol\n", 42]) {
      expect(reportFromThreadSettings({ ...base(), model }, AT)).toBeNull();
      expect(
        reportFromThreadResponse(
          { ...structuredClone(wire.threadStartResponse), model, thread: {} },
          AT,
        ),
      ).toBeNull();
    }
    expect(
      reportFromThreadSettings({ ...base(), model: "x".repeat(160) }, AT),
    ).not.toBeNull();
  });

  it("an effort that fails is sent as null, and the model still goes", () => {
    for (const effort of ["Medium", "very high", "x".repeat(21), 3]) {
      expect(reportFromThreadSettings({ ...base(), effort }, AT)).toMatchObject(
        { model: "gpt-5.6-sol", effort: null },
      );
    }
  });

  it("a service tier that fails is sent as null", () => {
    expect(
      reportFromThreadSettings({ ...base(), serviceTier: "fast tier" }, AT),
    ).toMatchObject({ serviceTier: null });
    expect(
      reportFromThreadSettings({ ...base(), serviceTier: "priority" }, AT),
    ).toMatchObject({ serviceTier: "priority" });
  });
});

describe("S13: the runtime's default tier is the store's null", () => {
  it("maps default to null and keeps a real tier", () => {
    expect(normalizeTier("default")).toBeNull();
    expect(normalizeTier(null)).toBeNull();
    expect(normalizeTier(undefined)).toBeNull();
    expect(normalizeTier("priority")).toBe("priority");
    expect(normalizeTier("fa st")).toBeNull();
    expect(normalizeTier("x".repeat(51))).toBeNull();
  });

  it("so the runtime's echo of a stored pair is the SAME report", () => {
    // updateSettings stores serviceTier null (a /model resets the tier) and
    // the runtime echoes "default" 12 ms later. One state, one key.
    const stored = reportFromStored(
      { model: "gpt-5.6-sol", effort: "medium", serviceTier: null },
      AT,
    )!;
    const echoed = reportFromThreadSettings(
      wire.threadSettingsUpdated.threadSettings,
      new Date("2026-09-26T09:30:00.012Z"),
    )!;
    expect(stored).not.toBeNull();
    expect(echoed).not.toBeNull();
    expect(stored.reportedAt).not.toBe(echoed.reportedAt);
    expect(reportKey(echoed)).toBe(reportKey(stored));
  });
});

describe("the stored pair (S12: store first)", () => {
  it("reports the stored model and effort", () => {
    expect(
      reportFromStored(
        { model: "gpt-5.6-sol", effort: "medium", mode: "plan", serviceTier: null },
        AT,
      ),
    ).toEqual({
      model: "gpt-5.6-sol",
      effort: "medium",
      serviceTier: null,
      rerouted: false,
      reportedAt: AT_ISO,
    });
  });

  it("reports nothing for a chat with no stored model", () => {
    expect(reportFromStored({ model: "gpt-5.5", mode: "plan" }, AT)).not.toBeNull();
    expect(reportFromStored({ mode: "plan", permission: "read-only" }, AT)).toBeNull();
    expect(reportFromStored({}, AT)).toBeNull();
  });

  it("an unset effort or tier reads as null", () => {
    expect(reportFromStored({ model: "gpt-5.5" }, AT)).toMatchObject({
      effort: null,
      serviceTier: null,
    });
    expect(
      reportFromStored({ model: "gpt-5.5", serviceTier: "priority" }, AT),
    ).toMatchObject({ serviceTier: "priority" });
  });
});

describe("S14: a reroute is the model that ran, flagged", () => {
  const last: SessionReport = {
    model: "gpt-6-astra",
    effort: "ultra",
    serviceTier: null,
    rerouted: false,
    reportedAt: "2026-09-26T09:00:00.000Z",
  };

  it("reports toModel with the last effort, flagged", () => {
    expect(reportFromReroute(REROUTE, last, AT)).toEqual({
      model: "gpt-5.5",
      effort: "ultra",
      serviceTier: null,
      rerouted: true,
      reportedAt: AT_ISO,
    });
  });

  it("with nothing reported before, the effort is null", () => {
    expect(reportFromReroute(REROUTE, null, AT)).toMatchObject({
      model: "gpt-5.5",
      effort: null,
      rerouted: true,
    });
  });

  it("a toModel that fails the pattern, or none, sends nothing", () => {
    expect(reportFromReroute(REROUTE, last, AT)).not.toBeNull();
    expect(reportFromReroute({ ...REROUTE, toModel: "gpt 5" }, last, AT)).toBeNull();
    const { toModel: _gone, ...noTarget } = REROUTE;
    expect(reportFromReroute(noTarget, last, AT)).toBeNull();
  });
});

describe("the key and the body", () => {
  const one: SessionReport = {
    model: "gpt-5.6-sol",
    effort: "medium",
    serviceTier: null,
    rerouted: false,
    reportedAt: "2026-09-26T09:00:00.000Z",
  };

  it("the key ignores reportedAt and nothing else", () => {
    expect(reportKey({ ...one, reportedAt: AT_ISO })).toBe(reportKey(one));
    expect(reportKey({ ...one, rerouted: true })).not.toBe(reportKey(one));
    expect(reportKey({ ...one, effort: "high" })).not.toBe(reportKey(one));
    expect(reportKey({ ...one, effort: null })).not.toBe(reportKey(one));
    expect(reportKey({ ...one, serviceTier: "priority" })).not.toBe(
      reportKey(one),
    );
    expect(reportKey({ ...one, model: "gpt-5.5" })).not.toBe(reportKey(one));
  });

  it("the body carries all five fields, in the rail's canonical order", () => {
    expect(SESSION_REPORT_FIELDS).toEqual([
      "model",
      "effort",
      "serviceTier",
      "rerouted",
      "reportedAt",
    ]);
    const body = reportBody({ ...one, effort: null });
    expect(Object.keys(body)).toEqual([...SESSION_REPORT_FIELDS]);
    expect(body).toEqual({ ...one, effort: null });
  });

  it("a builder with no time given stamps now, as strict ISO 8601", () => {
    const report = reportFromStored({ model: "gpt-5.5" })!;
    expect(report.reportedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(Math.abs(Date.parse(report.reportedAt) - Date.now())).toBeLessThan(
      5_000,
    );
  });
});

/**
 * P5 stage 7, Phase B, decision 4: THE RAIL CAN RETRACT. A report whose model
 * is null tells BGOS this daemon holds nothing for the chat, so the backend
 * clears the stored value instead of drawing the last host's forever. It is
 * sent on /new with nothing stored, and when the daemon first binds a chat it
 * holds nothing for.
 */
describe("Phase B: the retraction", () => {
  it("is the five keys with a null model, never a guess", () => {
    expect(reportRetraction(AT)).toEqual({
      model: null,
      effort: null,
      serviceTier: null,
      rerouted: false,
      reportedAt: AT_ISO,
    });
  });

  it("has its own key, distinct from every real report", () => {
    const retraction = reportRetraction(AT);
    const real = reportFromStored({ model: "gpt-5.5" }, AT)!;
    expect(reportKey(retraction)).not.toBe(reportKey(real));
    expect(reportKey({ ...retraction, reportedAt: "2026-09-26T10:00:00.000Z" })).toBe(
      reportKey(retraction),
    );
  });

  it("goes out as the same five fields in the rail's order, model null", () => {
    const body = reportBody(reportRetraction(AT));
    expect(Object.keys(body)).toEqual([...SESSION_REPORT_FIELDS]);
    expect(body.model).toBeNull();
  });
});

/**
 * P5 stage 7, Phase B, decision 9: the value patterns are part of the cross
 * repo pin, so the builders must use ONE exported set of them, the set the
 * pin rebuilds its string from.
 */
describe("Phase B: the patterns the builders use are the ones the pin hashes", () => {
  it("exports the three patterns, in the rail's field order", () => {
    expect(Object.keys(SESSION_REPORT_PATTERNS)).toEqual([
      "model",
      "effort",
      "serviceTier",
    ]);
    expect(SESSION_REPORT_PATTERNS.model.source).toBe("^[\\w./:-]{1,160}$");
    expect(SESSION_REPORT_PATTERNS.effort.source).toBe("^[a-z]{1,20}$");
    expect(SESSION_REPORT_PATTERNS.serviceTier.source).toBe("^[\\w-]{1,50}$");
  });

  it("the builders obey exactly those patterns at their edges", () => {
    const model160 = "m".repeat(160);
    expect(reportFromThreadSettings({ model: model160 }, AT)?.model).toBe(model160);
    expect(reportFromThreadSettings({ model: `${model160}m` }, AT)).toBeNull();
    expect(
      reportFromThreadSettings({ model: "gpt-5.5", effort: "a".repeat(21) }, AT)?.effort,
    ).toBeNull();
    expect(
      reportFromThreadSettings({ model: "gpt-5.5", serviceTier: "t".repeat(51) }, AT)
        ?.serviceTier,
    ).toBeNull();
  });
});

/**
 * P5 stage 7, round C, decision 3: which failed sends are worth repeating.
 * BgosApi's interceptor turns a 401 into a PairingRevokedError with no
 * `response`, and "no status" had read as "no answer", so a revoked pairing
 * was retried with the dead token. It is a refusal, and never retried.
 */
describe("Round C: sessionReportRetryable", () => {
  it("a revoked pairing is never retryable", () => {
    expect(sessionReportRetryable(new PairingRevokedError("revoked"))).toBe(false);
  });

  it("CONTROL: no answer, a timeout, a 5xx, a 408 and a 429 still are; any other 4xx is not", () => {
    expect(sessionReportRetryable(new Error("ECONNREFUSED"))).toBe(true);
    expect(
      sessionReportRetryable(Object.assign(new Error("t"), { code: "ECONNABORTED" })),
    ).toBe(true);
    for (const status of [500, 503, 408, 429])
      expect(sessionReportRetryable({ response: { status } })).toBe(true);
    for (const status of [400, 401, 403, 404])
      expect(sessionReportRetryable({ response: { status } })).toBe(false);
  });
});
