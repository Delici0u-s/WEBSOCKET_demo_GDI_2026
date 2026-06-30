// index.js — unified server
//
// Endpoints:
//   ws://HOST:PORT/chat          WebSocket chat (server-push)
//   GET  /poll?since=<id>        HTTP long-list poll: returns messages after <id>
//   POST /publish  {text}        inject a message into the shared bus (used by bench)
//   GET  /metrics                current byte/request counters as JSON
//   POST /metrics/reset          zero the counters between benchmark runs
//
// The same `bus` feeds both the WS broadcast and the HTTP /poll, so the
// comparison is fair.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer } from "ws";
import { bus } from "./messageBus.js";
import {
  makeMetrics,
  httpRequestBytes,
  httpResponseBytes,
  wsFrameBytes,
} from "./metrics.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const metrics = makeMetrics();

// Path to the browser demo, resolved relative to this file so it works no
// matter the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_HTML = path.resolve(__dirname, "../client/index.html");

// ---------- HTTP server (polling + control) ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Serve the browser demo same-origin, so fetch()/WebSocket hit the same
  // host:port and no CORS rules apply. Open http://localhost:8080/ — NOT the
  // file:// path on disk.
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    readFile(CLIENT_HTML)
      .then((buf) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buf);
      })
      .catch(() => {
        res.writeHead(500);
        res.end("client not found");
      });
    return;
  }

  if (req.method === "GET" && url.pathname === "/poll") {
    const since = Number(url.searchParams.get("since") ?? "-1");
    const fresh = bus.since(since);
    const body = JSON.stringify({ messages: fresh, lastId: bus.lastId });

    // Account bytes BOTH ways. This is the crux of the comparison.
    metrics.http.requests += 1;
    metrics.http.bytesUp += httpRequestBytes(req);
    const respHeaders = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    metrics.http.bytesDown += httpResponseBytes(200, respHeaders, body);
    metrics.http.messagesDelivered += fresh.length;

    res.writeHead(200, respHeaders);
    res.end(body);
    return;
  }

  if (req.method === "POST" && url.pathname === "/publish") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let text = "msg";
      try {
        text = JSON.parse(raw).text ?? text;
      } catch {}
      const msg = bus.publish(text);
      const body = JSON.stringify(msg);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/metrics") {
    const body = JSON.stringify(metrics, null, 2);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }

  if (req.method === "POST" && url.pathname === "/metrics/reset") {
    const m = makeMetrics();
    Object.assign(metrics.http, m.http);
    Object.assign(metrics.ws, m.ws);
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

// ---------- WebSocket server (push) ----------
const wss = new WebSocketServer({ server, path: "/chat" });

wss.on("connection", (socket, req) => {
  // The Opening Handshake (RFC 6455 §1.3) is a one-time HTTP Upgrade request.
  // We record its size once per connection — this is the cost the paper
  // conveniently omits when it advertises "only 4 bytes overhead".
  metrics.ws.handshakeBytes += httpRequestBytes(req);

  const onMessage = (msg) => {
    const payload = JSON.stringify(msg);
    const payloadLen = Buffer.byteLength(payload);
    // Server->client frames are NOT masked.
    metrics.ws.frames += 1;
    metrics.ws.bytesDown += wsFrameBytes(payloadLen, /*masked*/ false);
    metrics.ws.messagesDelivered += 1;
    if (socket.readyState === socket.OPEN) socket.send(payload);
  };

  bus.on("message", onMessage);

  // Client->server frames ARE masked (the +4 mask key). We account them when
  // a client publishes over the socket.
  socket.on("message", (data) => {
    const len = data.length ?? Buffer.byteLength(String(data));
    metrics.ws.frames += 1;
    metrics.ws.bytesUp += wsFrameBytes(len, /*masked*/ true);
    let text = "msg";
    try {
      text = JSON.parse(data.toString()).text ?? text;
    } catch {}
    bus.publish(text);
  });

  socket.on("close", () => bus.off("message", onMessage));
});

server.listen(PORT, () => {
  console.log(`Interactive Demo: http://localhost:${PORT}/`);
  console.log(`HTTP            : http://localhost:${PORT}/poll?since=-1`);
  console.log(`WS              : ws://localhost:${PORT}/chat`);
  console.log(`metrics         : http://localhost:${PORT}/metrics`);
});
