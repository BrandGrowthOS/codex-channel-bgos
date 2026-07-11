import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

interface StagedResponse {
  status: number;
  body: unknown;
  delayMs?: number;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Tiny HTTP mock for testing BgosApi + pair-cli without booting Nest.
 * Staged responses are matched first by METHOD + PATH (query string
 * stripped), and shift-consumed as they're used. Unmatched requests
 * return 404.
 */
export class MockBgosServer {
  private server?: HttpServer;
  private readonly staged = new Map<string, StagedResponse[]>();
  readonly requests: RecordedRequest[] = [];

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown = undefined;
      if (rawBody) {
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = rawBody;
        }
      }
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      const key = `${req.method} ${url}`;
      this.requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers as Record<string, string>,
        body: parsed,
      });
      const queue = this.staged.get(key);
      const staged = queue?.shift();
      if (!staged) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not staged", path: key }));
        return;
      }
      if (staged.delayMs) {
        await new Promise((r) => setTimeout(r, staged.delayMs));
      }
      res.writeHead(staged.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(staged.body ?? null));
    });

    await new Promise<void>((resolve) => this.server!.listen(0, resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  stage(method: string, path: string, status: number, body: unknown): this {
    const key = `${method} ${path}`;
    const existing = this.staged.get(key) ?? [];
    existing.push({ status, body });
    this.staged.set(key, existing);
    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    this.requests.length = 0;
    this.staged.clear();
  }
}
