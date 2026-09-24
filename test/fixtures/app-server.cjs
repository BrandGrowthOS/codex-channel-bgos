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
});
let parked;
let bigReverse;
/** Seventeen MiB of text: one line over the client's 16 MiB cap. */
function huge() {
  return "x".repeat(17 * 1024 * 1024);
}
