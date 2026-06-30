// runner.js — headless benchmark
//
// Spins up the server in-process, then runs the SAME workload over both
// transports and reports real measured bytes + latency. No browser needed.
//
// Workload (mirrors the paper's assumptions so your numbers are comparable):
//   - test duration:        configurable (default 20 s, scaled down for CI)
//   - poll interval:        1000 ms
//   - new message every:    2000 ms
//   - message payload:      50 bytes of text
//
// We measure THREE things the paper hand-waves:
//   1. real bytes on the wire (reconstructed HTTP headers vs RFC6455 frames)
//   2. delivery latency (publish -> client receives) per transport
//   3. the one-time WS handshake cost, amortised over the run

import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.BENCH_PORT ?? 8099);
const BASE = `http://localhost:${PORT}`;

// Realistic browser request headers. Node's bare fetch sends almost nothing,
// which would understate HTTP's true cost. A real browser attaches User-Agent,
// Accept, Accept-Language, Accept-Encoding, Cookie, Referer etc. — exactly the
// metadata the paper's 871-byte example is made of. We replicate a representative
// set so the byte comparison reflects what actually happens in a browser tab.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  Referer: "http://localhost/chat",
  Cookie:
    "sessionid=8f3b2a1c9d4e5f6a7b8c9d0e1f2a3b4c; theme=dark; consent=1; lang=de",
};

// ---- knobs (override via env) ----
const DURATION_MS = Number(process.env.DURATION_MS ?? 20000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 1000);
const MSG_INTERVAL_MS = Number(process.env.MSG_INTERVAL_MS ?? 2000);
const PAYLOAD = "x".repeat(50); // 50-byte message text

// ---------- boot server ----------
async function startServer() {
  const proc = spawn("node", ["src/server/index.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => {
    proc.stdout.on("data", (d) => {
      if (d.toString().includes("metrics:")) resolve();
    });
  });
  return proc;
}

const getMetrics = async () => (await fetch(`${BASE}/metrics`)).json();
const resetMetrics = () => fetch(`${BASE}/metrics/reset`, { method: "POST" });
const publish = (text) =>
  fetch(`${BASE}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

// A latency tracker: we tag each published message with its publish time and
// look it up when it arrives at the client.
function makeLatencyTracker() {
  const publishTs = new Map(); // id -> publish-issue time
  const receiveTs = new Map(); // id -> first receive time
  return {
    expect(id, t0) {
      publishTs.set(id, t0);
    },
    onReceive(id) {
      // keep earliest receipt only
      if (!receiveTs.has(id)) receiveTs.set(id, performance.now());
    },
    stats() {
      const samples = [];
      for (const [id, t0] of publishTs) {
        const t1 = receiveTs.get(id);
        if (t1 !== undefined) samples.push(t1 - t0);
      }
      if (samples.length === 0) return { count: 0, mean: 0, p95: 0, max: 0 };
      const sorted = samples.sort((a, b) => a - b);
      const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      return {
        count: sorted.length,
        mean: +mean.toFixed(2),
        p95: +p95.toFixed(2),
        max: +sorted.at(-1).toFixed(2),
      };
    },
  };
}

// shared message generator: publishes one message every MSG_INTERVAL_MS.
// We pre-register the expected next id's publish time BEFORE the broadcast can
// fire, otherwise a sub-ms WS push can arrive before onPublish() runs and the
// latency sample is lost.
function startPublisher(onExpect) {
  const timer = setInterval(async () => {
    const t0 = performance.now();
    const res = await publish(PAYLOAD);
    const msg = await res.json();
    onExpect?.(msg.id, t0); // register id -> the moment we issued publish
  }, MSG_INTERVAL_MS);
  return () => clearInterval(timer);
}

// ================= HTTP POLLING SCENARIO =================
async function benchHttp() {
  await resetMetrics();
  const lat = makeLatencyTracker();
  let since = (await (await fetch(`${BASE}/poll?since=-1`)).json()).lastId;

  const stopPub = startPublisher((id, t0) => lat.expect(id, t0));

  const pollTimer = setInterval(async () => {
    const { messages, lastId } = await (
      await fetch(`${BASE}/poll?since=${since}`, { headers: BROWSER_HEADERS })
    ).json();
    since = lastId;
    for (const m of messages) lat.onReceive(m.id);
  }, POLL_INTERVAL_MS);

  await sleep(DURATION_MS);
  clearInterval(pollTimer);
  stopPub();
  await sleep(POLL_INTERVAL_MS + 200); // let last poll land

  const m = await getMetrics();
  return { transport: "HTTP-Polling", metrics: m.http, latency: lat.stats() };
}

// ================= WEBSOCKET SCENARIO =================
async function benchWs() {
  await resetMetrics();
  const lat = makeLatencyTracker();

  const ws = new WebSocket(`ws://localhost:${PORT}/chat`);
  await new Promise((res) => ws.on("open", res));
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    lat.onReceive(m.id);
  });

  const stopPub = startPublisher((id, t0) => lat.expect(id, t0));

  await sleep(DURATION_MS);
  stopPub();
  await sleep(300); // drain
  ws.close();

  const m = await getMetrics();
  return { transport: "WebSocket", metrics: m.ws, latency: lat.stats() };
}

// ---------- pretty printer ----------
function report(http, ws) {
  const httpTotal = http.metrics.bytesUp + http.metrics.bytesDown;
  const wsTotal =
    ws.metrics.bytesUp + ws.metrics.bytesDown + ws.metrics.handshakeBytes;
  const seconds = DURATION_MS / 1000;

  const line = "─".repeat(64);
  console.log("\n" + line);
  console.log(
    `BENCHMARK  duration=${seconds}s  poll=${POLL_INTERVAL_MS}ms  ` +
      `msg-every=${MSG_INTERVAL_MS}ms  payload=${PAYLOAD.length}B`
  );
  console.log(line);

  const row = (label, a, b) =>
    console.log(label.padEnd(26) + String(a).padStart(16) + String(b).padStart(20));

  row("metric", "HTTP-Polling", "WebSocket");
  console.log(line);
  row("requests / frames", http.metrics.requests, ws.metrics.frames);
  row("bytes up", http.metrics.bytesUp, ws.metrics.bytesUp);
  row("bytes down", http.metrics.bytesDown, ws.metrics.bytesDown);
  row("handshake bytes", 0, ws.metrics.handshakeBytes);
  row("TOTAL bytes", httpTotal, wsTotal);
  row(
    "bytes / delivered msg",
    http.metrics.messagesDelivered
      ? Math.round(httpTotal / http.metrics.messagesDelivered)
      : "—",
    ws.metrics.messagesDelivered
      ? Math.round(wsTotal / ws.metrics.messagesDelivered)
      : "—"
  );
  row("messages delivered", http.metrics.messagesDelivered, ws.metrics.messagesDelivered);
  console.log(line);
  row("latency mean (ms)", http.latency.mean, ws.latency.mean);
  row("latency p95 (ms)", http.latency.p95, ws.latency.p95);
  row("latency max (ms)", http.latency.max, ws.latency.max);
  console.log(line);

  const saving = (1 - wsTotal / httpTotal) * 100;
  console.log(
    `\nWebSocket spart ${saving.toFixed(2)} % Bytes gegenüber Polling ` +
      `(inkl. einmaligem Handshake von ${ws.metrics.handshakeBytes} B).`
  );

  // machine-readable for charting / Word import
  return {
    config: { DURATION_MS, POLL_INTERVAL_MS, MSG_INTERVAL_MS, payload: PAYLOAD.length },
    http: { ...http.metrics, totalBytes: httpTotal, latency: http.latency },
    ws: { ...ws.metrics, totalBytes: wsTotal, latency: ws.latency },
    savingPercent: +saving.toFixed(2),
  };
}

// ---------- main ----------
const server = await startServer();
try {
  const http = await benchHttp();
  const ws = await benchWs();
  const json = report(http, ws);
  console.log("\nJSON:\n" + JSON.stringify(json));
} finally {
  server.kill();
}
