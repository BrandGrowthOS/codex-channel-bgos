const readline = require("node:readline");
let reverse;
const send = (x) => process.stdout.write(JSON.stringify(x) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === "reverse") {
    send({ id: reverse, result: m });
    return;
  }
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "echo") send({ id: m.id, result: m.params });
  if (m.method === "requestTool") {
    reverse = m.id;
    send({ id: "reverse", method: "item/tool/call", params: m.params });
  }
  if (m.method === "crash") process.exit(3);
  // "never" intentionally leaves the request unanswered.

  // Round 7: lines longer than the client's 16 MiB line cap. `park` is
  // answered only after the next oversized reply, so a case can prove the
  // oversized line failed nothing but its own request.
  if (m.method === "park") parked = m.id;
  if (m.method === "big") {
    send({ id: m.id, result: { blob: huge() } });
    if (parked !== undefined) send({ id: parked, result: { parked: true } });
    parked = undefined;
  }
  if (m.method === "bigNotify") {
    send({ method: "item/completed", params: { item: { blob: huge() } } });
    send({ method: "tick", params: { n: 1 } });
    send({ id: m.id, result: { ok: true } });
  }
  if (m.method === "bigRequest") {
    bigReverse = m.id;
    send({ id: "huge-1", method: "item/tool/call", params: { blob: huge() } });
  }
  if (m.id === "huge-1") send({ id: bigReverse, result: m });
  // Round 8: a picture's item/completed line over the cap, then a line after
  // it, then the reply. `shape` picks where the ids sit: "tail" is the real
  // runtime's order (the probe's raw.jsonl: item first, then threadId,
  // turnId and completedAtMs, and emittedAtMs outside params), so the ids are
  // only in the line's last characters; "head" puts them first; "none" leaves
  // them out; "notImage" is the real order around a huge command output.
  if (m.method === "bigImage") {
    send(bigItemLine(m.params.shape));
    send({ method: "tick", params: { n: 1 } });
    send({ id: m.id, result: { ok: true } });
  }
});
const THREAD = "01a0d1b7-8827-74c2-8882-b5d8555d38e5";
const TURN = "01a0d1b7-88b9-7411-a15b-26c69d8782f0";
function bigItemLine(shape) {
  const item =
    shape === "notImage"
      ? {
          type: "commandExecution",
          id: "call_big_1",
          command: "type big.log",
          aggregatedOutput: huge(),
          exitCode: 0,
        }
      : {
          type: "imageGeneration",
          id: "ig_big_1",
          status: "completed",
          revisedPrompt: "A plain gold circle centred on a dark charcoal background",
          result: huge(),
          transparentBackground: false,
          failure: null,
          savedPath:
            "C:\\Users\\owner\\.codex\\generated_images\\" + THREAD + "\\ig_big_1.png",
        };
  const params =
    shape === "head"
      ? { threadId: THREAD, turnId: TURN, item, completedAtMs: 1790224861752 }
      : shape === "none"
        ? { item, completedAtMs: 1790224861752 }
        : { item, threadId: THREAD, turnId: TURN, completedAtMs: 1790224861752 };
  return { method: "item/completed", params, emittedAtMs: 1790224861757 };
}
let parked;
let bigReverse;
/** Seventeen MiB of text: one line over the client's 16 MiB cap. */
function huge() {
  return "x".repeat(17 * 1024 * 1024);
}
