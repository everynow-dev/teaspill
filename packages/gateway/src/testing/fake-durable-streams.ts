/**
 * Faithful in-memory fake of the durable-streams server's HTTP contract,
 * for testing 0001:R5 (streaming resumability THROUGH the gateway) without
 * docker. Ported line-for-line-in-spirit from the pinned Rust server
 * (`electric-sql/electric` @ `packages/durable-streams-rust/src/handlers.rs`
 * + `store.rs`, the source behind image
 * `electricax/durable-streams-server-rust:0.1.4`):
 *
 * - Stream name = the HTTP path, verbatim (C1).
 * - PUT create: 201 (+`Location`, `Content-Type`, `Stream-Next-Offset`);
 *   re-PUT of an existing stream: 200 + `Stream-Next-Offset` (idempotent).
 * - POST append: 404 if the stream doesn't exist (C3); 409 if closed;
 *   204 + `Stream-Next-Offset` on success (200 when producer headers are
 *   present, echoing `Producer-Epoch`/`Producer-Seq`).
 * - GET catch-up: 200 body = bytes[start..tail], headers `Stream-Next-Offset`
 *   (`%016d_%016d` — seq 0 prefix + byte offset, `format_offset`),
 *   `Stream-Up-To-Date: true`, strong `ETag` = `"<id>:<start>:<end>[:c]"`,
 *   `Cache-Control: public, max-age=60, stale-while-revalidate=300`
 *   (`no-store` for `offset=now` / beyond-tail sentinel reads);
 *   `If-None-Match` match → 304 with the same ETag + offset headers.
 * - GET `live=long-poll`: data past the offset → immediate 200 (+`Stream-Cursor`,
 *   ETag, cacheable); caught up → park until append/close/timeout; timeout →
 *   204 + `Stream-Next-Offset`/`Stream-Cursor`/`Stream-Up-To-Date`, `no-store`;
 *   closed → 204 + `Stream-Closed: true`.
 * - Offsets: `-1`/absent → start; `now` → tail sentinel; `<16 digits>_<16 digits>`
 *   → byte position (beyond-tail = caught-up at the requested offset, per
 *   `resolve_start`). Malformed → 400. Duplicate `offset` param → 400.
 *
 * Deliberately NOT implemented (out of scope for 0001:R5): JSON wire flattening
 * (use a non-JSON content type in tests so byte math is exact), producer
 * seq validation, TTL/expiry, forks, SSE.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const CACHEABLE = "public, max-age=60, stale-while-revalidate=300";
const CURSOR_EPOCH_UNIX = 1_728_432_000; // protocol epoch (store.rs)
const CURSOR_INTERVAL_SECS = 20;

export function formatOffset(bytes: number): string {
  return `${"0".repeat(16)}_${String(bytes).padStart(16, "0")}`;
}

type ParsedOffset = { kind: "start" } | { kind: "now" } | { kind: "at"; bytes: number };

function parseOffset(raw: string | undefined): ParsedOffset | null {
  if (raw === undefined || raw === "-1") return { kind: "start" };
  if (raw === "now") return { kind: "now" };
  const m = /^(\d{16})_(\d{16})$/.exec(raw);
  if (!m) return null;
  return { kind: "at", bytes: Number(m[2]) };
}

function computeCursor(clientCursor: number | undefined): number {
  const now = Math.floor(Date.now() / 1000);
  const interval = Math.floor(Math.max(0, now - CURSOR_EPOCH_UNIX) / CURSOR_INTERVAL_SECS);
  if (clientCursor !== undefined && clientCursor >= interval) {
    return clientCursor + 1 + (Date.now() % 180);
  }
  return interval;
}

interface FakeStream {
  id: number;
  contentType: string;
  data: Buffer;
  closed: boolean;
  waiters: Set<() => void>;
}

export interface LoggedRequest {
  method: string;
  /** Raw path+query exactly as received — asserts byte-exact pass-through. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export class FakeDurableStreams {
  readonly streams = new Map<string, FakeStream>();
  readonly requests: LoggedRequest[] = [];
  private server: Server | null = null;
  private nextId = 1;

  constructor(private readonly longPollTimeoutMs: number = 30_000) {}

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    for (const s of this.streams.values()) for (const w of s.waiters) w();
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        this.server!.close((e) => (e ? reject(e) : resolve())),
      );
    }
  }

  /** Server-side append (bypasses HTTP) — for simulating other producers. */
  append(path: string, chunk: string | Buffer): void {
    const st = this.streams.get(path);
    if (!st) throw new Error(`no such stream: ${path}`);
    st.data = Buffer.concat([st.data, Buffer.from(chunk)]);
    this.wake(st);
  }

  closeStream(path: string): void {
    const st = this.streams.get(path);
    if (!st) throw new Error(`no such stream: ${path}`);
    st.closed = true;
    this.wake(st);
  }

  private wake(st: FakeStream): void {
    const waiters = [...st.waiters];
    st.waiters.clear();
    for (const w of waiters) w();
  }

  private etag(st: FakeStream, start: number, end: number): string {
    return st.closed ? `"${st.id}:${start}:${end}:c"` : `"${st.id}:${start}:${end}"`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "/";
    this.requests.push({ method: req.method ?? "", url: rawUrl, headers: { ...req.headers } });
    const qIdx = rawUrl.indexOf("?");
    const path = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    const query = qIdx === -1 ? "" : rawUrl.slice(qIdx + 1);

    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }

    const body = await readBody(req);
    switch (req.method) {
      case "PUT":
        return this.handleCreate(req, res, path, body);
      case "POST":
        return this.handleAppend(req, res, path, body);
      case "GET":
        return this.handleRead(req, res, path, query);
      case "HEAD":
        return this.handleHead(res, path);
      case "DELETE": {
        if (!this.streams.delete(path)) return text(res, 404, "stream not found");
        res.writeHead(204).end();
        return;
      }
      case "OPTIONS":
        res.writeHead(204).end();
        return;
      default:
        return text(res, 405, "method not allowed");
    }
  }

  private handleCreate(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    body: Buffer,
  ): void {
    const contentType =
      (req.headers["content-type"] as string | undefined) ?? "application/octet-stream";
    const existing = this.streams.get(path);
    if (existing) {
      // CreateResult::Exists → 200 + next-offset (idempotent no-op create).
      res
        .writeHead(200, {
          "content-type": existing.contentType,
          "stream-next-offset": formatOffset(existing.data.length),
        })
        .end();
      return;
    }
    const st: FakeStream = {
      id: this.nextId++,
      contentType,
      data: Buffer.from(body),
      closed: req.headers["stream-closed"] === "true",
      waiters: new Set(),
    };
    this.streams.set(path, st);
    res
      .writeHead(201, {
        location: `http://${req.headers.host ?? "localhost"}${path}`,
        "content-type": st.contentType,
        "stream-next-offset": formatOffset(st.data.length),
      })
      .end();
  }

  private handleAppend(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    body: Buffer,
  ): void {
    const st = this.streams.get(path);
    if (!st) return text(res, 404, "stream not found");
    const closeReq = req.headers["stream-closed"] === "true";
    if (st.closed && !closeReq) {
      res
        .writeHead(409, {
          "stream-closed": "true",
          "stream-next-offset": formatOffset(st.data.length),
        })
        .end("stream is closed");
      return;
    }
    if (body.length === 0 && !closeReq) return text(res, 400, "empty append body");
    if (body.length > 0) {
      const ct = req.headers["content-type"] as string | undefined;
      if (!ct) return text(res, 400, "missing Content-Type");
      if (mediaType(ct) !== mediaType(st.contentType)) {
        return text(res, 409, "content-type mismatch");
      }
      st.data = Buffer.concat([st.data, body]);
    }
    if (closeReq) st.closed = true;
    this.wake(st);

    const producerId = req.headers["producer-id"] as string | undefined;
    const headers: Record<string, string> = {
      "stream-next-offset": formatOffset(st.data.length),
    };
    if (producerId !== undefined) {
      headers["producer-epoch"] = (req.headers["producer-epoch"] as string | undefined) ?? "0";
      headers["producer-seq"] = (req.headers["producer-seq"] as string | undefined) ?? "0";
    }
    if (st.closed) headers["stream-closed"] = "true";
    // Producer append with a body → 200; plain/bodyless append → 204.
    res.writeHead(producerId !== undefined && body.length > 0 ? 200 : 204, headers).end();
  }

  private handleHead(res: ServerResponse, path: string): void {
    const st = this.streams.get(path);
    if (!st) return text(res, 404, "stream not found");
    const headers: Record<string, string> = {
      "content-type": st.contentType,
      "stream-next-offset": formatOffset(st.data.length),
    };
    if (st.closed) headers["stream-closed"] = "true";
    res.writeHead(200, headers).end();
  }

  private handleRead(req: IncomingMessage, res: ServerResponse, path: string, query: string): void {
    const st = this.streams.get(path);
    if (!st) return text(res, 404, "stream not found");

    // parse_query: duplicate `offset` → 400; live/cursor last-wins.
    let offsetRaw: string | undefined;
    let live: string | undefined;
    let cursor: number | undefined;
    if (query.length > 0) {
      for (const pair of query.split("&")) {
        const eq = pair.indexOf("=");
        const k = eq === -1 ? pair : pair.slice(0, eq);
        const v = decodeURIComponent(eq === -1 ? "" : pair.slice(eq + 1));
        if (k === "offset") {
          if (offsetRaw !== undefined) {
            return text(res, 400, "multiple offset parameters not allowed");
          }
          offsetRaw = v;
        } else if (k === "live") live = v;
        else if (k === "cursor") {
          const n = Number(v);
          if (Number.isInteger(n)) cursor = n;
        }
      }
    }
    const offset = parseOffset(offsetRaw);
    if (offset === null) return text(res, 400, "malformed offset");
    if (live !== undefined && offsetRaw === undefined) {
      return text(res, 400, "offset is required for live modes");
    }

    if (live === undefined) return this.catchup(req, res, st, offset);
    if (live === "long-poll") return this.longPoll(res, st, offset, cursor);
    return text(res, 400, "invalid live mode"); // SSE not implemented in the fake
  }

  private catchup(
    req: IncomingMessage,
    res: ServerResponse,
    st: FakeStream,
    offset: ParsedOffset,
  ): void {
    const tail = st.data.length;
    const { start, nowMode, nextOffset } = resolveStart(offset, tail);
    const end = tail;
    const reported = nowMode ? nextOffset : end;
    const etag = nowMode ? null : this.etag(st, start, end);

    if (etag !== null && req.headers["if-none-match"] === etag) {
      const headers: Record<string, string> = {
        etag,
        "stream-next-offset": formatOffset(reported),
        "stream-up-to-date": "true",
      };
      if (st.closed) headers["stream-closed"] = "true";
      res.writeHead(304, headers).end();
      return;
    }
    const headers: Record<string, string> = {
      "content-type": st.contentType,
      "stream-next-offset": formatOffset(reported),
      "stream-up-to-date": "true",
      "cache-control": nowMode ? "no-store" : CACHEABLE,
    };
    if (etag !== null) headers["etag"] = etag;
    if (st.closed) headers["stream-closed"] = "true";
    res.writeHead(200, headers).end(st.data.subarray(start, end));
  }

  private longPoll(
    res: ServerResponse,
    st: FakeStream,
    offset: ParsedOffset,
    clientCursor: number | undefined,
  ): void {
    const from = resolveStart(offset, st.data.length).start;
    const cursor = computeCursor(clientCursor);

    const data = (): void => {
      const tail = st.data.length;
      const headers: Record<string, string> = {
        "content-type": st.contentType,
        "stream-next-offset": formatOffset(tail),
        "stream-cursor": String(cursor),
        etag: this.etag(st, from, tail),
        "stream-up-to-date": "true",
        "cache-control": CACHEABLE,
      };
      if (st.closed) headers["stream-closed"] = "true";
      res.writeHead(200, headers).end(st.data.subarray(from, tail));
    };
    const empty204 = (closed: boolean): void => {
      const headers: Record<string, string> = {
        "stream-next-offset": formatOffset(st.data.length),
        "stream-cursor": String(cursor),
        "stream-up-to-date": "true",
        "cache-control": "no-store",
      };
      if (closed) headers["stream-closed"] = "true";
      res.writeHead(204, headers).end();
    };

    if (from < st.data.length) return data();
    if (st.closed) return empty204(true);

    // Park until append / close / timeout — the invariant from handlers.rs:
    // a long-poll response never advances the client's offset beyond bytes
    // it actually delivered (re-check the tail on every wake path).
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      st.waiters.delete(wake);
      if (st.data.length > from) return data();
      empty204(st.closed);
    }, this.longPollTimeoutMs);
    const wake = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (st.data.length > from) return data();
      empty204(st.closed);
    };
    st.waiters.add(wake);
    res.on("close", () => {
      settled = true;
      clearTimeout(timer);
      st.waiters.delete(wake);
    });
  }
}

function resolveStart(
  offset: ParsedOffset,
  tail: number,
): { start: number; nowMode: boolean; nextOffset: number } {
  switch (offset.kind) {
    case "start":
      return { start: 0, nowMode: false, nextOffset: tail };
    case "now":
      return { start: tail, nowMode: true, nextOffset: tail };
    case "at":
      if (offset.bytes > tail) {
        // Beyond-tail: caught up at the tail, report the REQUESTED offset.
        return { start: tail, nowMode: true, nextOffset: offset.bytes };
      }
      return { start: offset.bytes, nowMode: false, nextOffset: offset.bytes };
  }
}

function mediaType(ct: string): string {
  return (ct.split(";")[0] ?? "").trim().toLowerCase();
}

function text(res: ServerResponse, status: number, msg: string): void {
  res.writeHead(status, { "content-type": "text/plain" }).end(msg);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
