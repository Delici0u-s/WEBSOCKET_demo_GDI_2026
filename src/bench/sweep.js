// sweep.js — runs the benchmark across several poll intervals and emits CSV.
// Useful for a table/chart in the report: "as polling gets more aggressive,
// HTTP cost explodes linearly while WebSocket stays flat".
//
//   node src/bench/sweep.js > results.csv
//
// We re-exec runner.js as a child per interval (clean state each run) and parse
// its JSON line.

import { spawnSync } from "node:child_process";

const intervals = [2000, 1000, 500, 250]; // ms
const DURATION_MS = process.env.DURATION_MS ?? "20000";

console.log(
  "poll_interval_ms,http_requests,http_total_bytes,ws_frames,ws_total_bytes,saving_percent,http_lat_mean_ms,ws_lat_mean_ms"
);

let port = 8100;
for (const interval of intervals) {
  port += 1;
  const out = spawnSync(
    "node",
    ["src/bench/runner.js"],
    {
      env: {
        ...process.env,
        DURATION_MS,
        POLL_INTERVAL_MS: String(interval),
        BENCH_PORT: String(port),
      },
      encoding: "utf8",
    }
  );
  const line = out.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) {
    console.error(`no JSON for interval ${interval}`);
    continue;
  }
  const r = JSON.parse(line);
  console.log(
    [
      interval,
      r.http.requests,
      r.http.totalBytes,
      r.ws.frames,
      r.ws.totalBytes,
      r.savingPercent,
      r.http.latency.mean,
      r.ws.latency.mean,
    ].join(",")
  );
}
