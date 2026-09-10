import type { AppServer, RpcObject } from "../app-server.js";
import { friendlyCodexError } from "../codex-host.js";

/** A model listing does not prove the selected model can run with this CLI. */
export async function verifyModel(
  server: AppServer,
  model?: string,
  timeoutMs = 90_000,
): Promise<void> {
  const started = await server.request("thread/start", {
    ephemeral: true,
    cwd: process.env.CODEX_BGOS_WORKDIR,
    approvalPolicy: "never",
    sandbox: "read-only",
    dynamicTools: [],
    ...(model ? { model } : {}),
    developerInstructions:
      "This is an HOAI connectivity check. Reply with OK only. Do not use tools, read files, or perform any other work.",
  });
  const threadId = started.thread.id;
  let timer: ReturnType<typeof setTimeout>;
  let listener: (method: string, params: RpcObject) => void;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "Codex did not answer the connection check. Check your connection and retry.",
            ),
          ),
        timeoutMs,
      );
      listener = (method, params) => {
        if (method !== "turn/completed" || params.threadId !== threadId) return;
        if (params.turn.status === "completed") resolve();
        else
          reject(
            new Error(
              friendlyCodexError(
                params.turn.error?.message ??
                  "Codex could not answer the connection check.",
              ),
            ),
          );
      };
      server.on("notification", listener);
      void server
        .request("turn/start", {
          threadId,
          input: [{ type: "text", text: "Reply only OK.", text_elements: [] }],
        })
        .catch(reject);
    });
  } finally {
    clearTimeout(timer!);
    server.off("notification", listener!);
    await server.request("thread/unsubscribe", { threadId }).catch(() => {});
  }
}
