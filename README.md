# WebSocket vs. HTTP-Polling — API-Demo & Benchmark

Begleitcode für den Bericht (Teil: API / Implementierung / Beispiele / Performance).
Demonstriert die WebSocket-Client-API aus der W3C-Spezifikation und misst **real**
den Byte- und Latenzunterschied zu HTTP-Polling — statt der im Paper
hand-gerechneten Schätzwerte.

## Setup

```bash
npm install
```

Benötigt Node ≥ 18 (nutzt natives `fetch`). OS-unabhängig.

## Komponenten

| Datei | Zweck |
|---|---|
| `src/server/index.js` | Unified Server: `ws://…/chat` **und** `GET /poll` aus derselben Quelle (`bus`) |
| `src/server/messageBus.js` | In-Memory Pub/Sub, simuliert ein Chat-Backend |
| `src/server/metrics.js` | Byte-Buchhaltung: HTTP-Header rekonstruiert, WS-Frames nach RFC 6455 §5.2 |
| `src/client/index.html` | Browser-Demo: zeigt die **vollständige** WebSocket-API live |
| `src/bench/runner.js` | Headless-Benchmark, ein Lauf, gibt Tabelle + JSON aus |
| `src/bench/sweep.js` | Variiert das Poll-Intervall, gibt CSV für Tabelle/Diagramm aus |

## Ausführen

**Interaktive Demo** (Browser):

```bash
npm run server
# dann src/client/index.html im Browser öffnen (http://localhost:8080/)
# DevTools → Network zeigt: links 1 Request/s, rechts nur Push-Frames
```

**Benchmark** (ein Lauf):

```bash
npm run bench
# Knöpfe via env: DURATION_MS, POLL_INTERVAL_MS, MSG_INTERVAL_MS
DURATION_MS=20000 POLL_INTERVAL_MS=1000 npm run bench
```

**Sweep** (CSV für den Bericht):

```bash
node src/bench/sweep.js > results.csv
```

## Was hier gegenüber dem Paper korrigiert / ergänzt wurde

1. **API-Bug im Paper.** Quelltext 4 verwendet `wsChat.ondata` — diesen Callback
   gibt es nicht. Korrekt ist `onmessage`, Nutzdaten in `event.data`.
   `src/client/index.html` zeigt die korrekte, vollständige API (Constructor mit
   Subprotokollen, alle vier Events, `send`/`close`, `readyState`-Konstanten,
   `bufferedAmount`, `binaryType`, `protocol`, `extensions`).

2. **Echte Bytes statt Schätzung.** Das Paper rechnet mit einem festen
   871-Byte-Header und kommt auf 99,77 %. Hier werden HTTP-Header tatsächlich
   rekonstruiert und WS-Frames exakt nach RFC 6455 berechnet
   (2–14 B Header je nach Länge/Maskierung).

3. **Handshake wird mitgezählt.** Der einmalige WebSocket-Opening-Handshake
   kostet einen vollen HTTP-Upgrade-Request (~227 B im Test). Das Paper
   unterschlägt diese Anlauf­kosten — relevant bei kurzlebigen Verbindungen.

4. **Latenz wird gemessen, nicht nur behauptet.** Publish→Empfang pro Transport.

## Beispiel-Ergebnis (20 s, Poll 1 s, Nachricht alle 2 s, 50-B-Payload)

```
metric                        HTTP-Polling           WebSocket
requests / frames                       20                   9
bytes up                              8145                   0
bytes down                            3714                 809
handshake bytes                          0                 227
TOTAL bytes                          11859                1036
bytes / delivered msg                 1318                 115
latency mean (ms)                     7.15                1.87
→ WebSocket spart 91.26 % Bytes
```

## Sweep-Ergebnis (Kernaussage für den Bericht)

| Poll-Intervall | HTTP Requests | HTTP Bytes | WS Frames | WS Bytes | Ersparnis |
|---|---|---|---|---|---|
| 2000 ms | 6  | 3595  | 5 | 672 | 81.3 % |
| 1000 ms | 12 | 6987  | 5 | 672 | 90.4 % |
| 500 ms  | 24 | 13771 | 5 | 672 | 95.1 % |
| 250 ms  | 48 | 27339 | 5 | 672 | 97.5 % |

**Interpretation:** WebSocket-Traffic ist *konstant* (nur echte Nachrichten +
einmaliger Handshake), HTTP-Polling skaliert *linear* mit der Poll-Frequenz.
Je niedriger die akzeptable Latenz (= häufigeres Polling), desto größer der
Vorteil von WebSockets.

## Wichtige Caveats (im Bericht erwähnen, für Fairness)

- **Localhost-Latenz** ist hier sub-ms. Im echten Netz addiert Polling im
  Mittel ~½ Poll-Intervall (bei 1 s also ~500 ms) Verzögerung, weil eine
  Nachricht bis zum nächsten Poll wartet. WebSocket-Push hat diese Wartezeit
  nicht.
- **HTTP/2 + HPACK** würde die Header-Wiederholung stark komprimieren und die
  Ersparnis verringern — der Paper-Vergleich gilt strikt nur für HTTP/1.1 ohne
  Header-Kompression.
- **TCP/IP/TLS-Overhead** wird bewusst nicht gezählt (pro Paket für beide
  gleich, von außen nicht messbar). Gemessen werden Anwendungsbytes.
- Die Zahlen schwanken pro Lauf leicht (Anzahl gelieferter Nachrichten hängt
  vom Timing ab). Für den Bericht mehrere Läufe mitteln.
