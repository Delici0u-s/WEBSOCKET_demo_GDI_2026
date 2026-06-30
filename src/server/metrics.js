// metrics.js
// Central byte/request accounting. Every transport increments these counters
// so the benchmark can report REAL bytes-on-the-wire rather than the paper's
// hand-calculated estimates.
//
// Note on "bytes": we count application-visible bytes — the HTTP request line +
// headers + body, and the WebSocket frame header + payload. We deliberately do
// NOT count TCP/IP/TLS overhead, because (a) it's the same for both transports
// per packet and (b) it depends on MTU/segmentation we can't see from userland.
// This keeps the comparison honest and reproducible.

export function makeMetrics() {
  return {
    http: { requests: 0, bytesUp: 0, bytesDown: 0, messagesDelivered: 0 },
    ws: { frames: 0, bytesUp: 0, bytesDown: 0, messagesDelivered: 0, handshakeBytes: 0 },
  };
}

// Estimate the byte length of an HTTP message (start line + headers + body).
// We reconstruct it from Node's parsed objects because Node doesn't hand us the
// raw request buffer cheaply. This is a faithful reconstruction, not a guess.
export function httpRequestBytes(req, bodyStr = "") {
  const startLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  let headerStr = "";
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headerStr += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
  }
  headerStr += "\r\n";
  return Buffer.byteLength(startLine + headerStr + bodyStr, "utf8");
}

export function httpResponseBytes(statusCode, headers, bodyStr = "") {
  const statusLine = `HTTP/1.1 ${statusCode} OK\r\n`;
  let headerStr = "";
  for (const [k, v] of Object.entries(headers)) {
    headerStr += `${k}: ${v}\r\n`;
  }
  headerStr += "\r\n";
  return Buffer.byteLength(statusLine + headerStr + bodyStr, "utf8");
}

// WebSocket frame overhead per RFC 6455 §5.2:
//   2 bytes base header, +2 if payload 126..65535, +8 if larger,
//   +4 if masked (client->server frames MUST be masked).
export function wsFrameBytes(payloadByteLen, masked) {
  let header = 2;
  if (payloadByteLen >= 126 && payloadByteLen <= 65535) header += 2;
  else if (payloadByteLen > 65535) header += 8;
  if (masked) header += 4;
  return header + payloadByteLen;
}
