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
});
