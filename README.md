# Orchestration Tax Lab — companion demo

Interactive lab for the article *Your Agent Graph Is Paying an LLM to Flip a
Boolean*. One `where is my order?` request replays through an eight-node agent
graph in two architectures — **Every node is an LLM** vs **Code where
possible** — while the event ledger prices both.

Zero dependencies — Node 24+ only. The graph model is a plain ES module shared
by the browser UI, the HTTP API, the CLI, and the test suite.

## What it proves

- **The tax is per-node.** The deterministic run makes 2 model calls; the
  every-node-LLM run pays 800 ms + 1,200 tokens at every box it touches —
  including the router and the human handoff.
- **Routers read state; they do not interpret it.** The pure router maps
  `hasTrackingNumber` + `retryCount` to one edge: 100 seeded replays collapse
  to a single route. The model router scatters them.
- **Validate facts, not fluency.** The `Omit tracking number` fault produces
  fluent drafts that all fail `checkReply` — the reply must contain
  `1Z999AA10123456784` literally.
- **Bound every retry.** With the bound on, three drafts then `escalated`.
  Off, the loop only stops at the simulation fuse: exactly 25 attempts,
  terminal `runaway`, and a projected bill.
- **Every metric is derived.** Model calls, latency, tokens, cost, terminal —
  all reduced from the emitted event trace, so ledger and summary cannot
  disagree.

## Run it

```text
npm start        # serve the lab on http://localhost:3000
npm test         # domain model + server + end-to-end suites
npm run lab      # CLI trace: node scripts/lab.mjs [--llm] [--omit] [--unbounded] [--compare]
npm run check    # all of it
```

## API

- `GET /api/graph` — nodes, fixture, assumptions, limits, modes
- `POST /api/run` — body `{mode, failureMode, boundRetries, seed}` returns the
  full `{events, metrics, terminal, finalState}` trace; `"compare": true`
  returns the 100-seed comparison for both architectures
- `GET /health` → `ok` · `GET /version` → `{name, version, commit}`

## Layout

- `public/graph.mjs` — the domain model: eight nodes, node work, pure router,
  seeded replay, event-derived metrics. No DOM, no I/O, no globals.
- `public/app.js` — lab wiring: track, animated ledger, replay + compare
- `app/server.js` — zero-dependency static host + `/api/*`
- `examples/scenarios.mjs` — the four named runs as importable fixtures
- `scripts/lab.mjs` — terminal tracer
- `test/` — `node --test "test/*.test.mjs"`

## Honest limits

- Latency and token figures are fixed assumptions (800 ms / 1,200 tokens per
  model call, 8 ms per code node), not provider measurements — the ratio is
  the lesson.
- The seeded model router stands in for an LLM choosing edges; a real one
  fails less predictably, which is worse.
- One invariant stands in for a validation suite; escalation is a terminal
  event, not a queue.
- The fuse caps a simulation — production needs timeouts, budgets, and kill
  switches.

This is an educational demo, not production infrastructure.

Repo: [github.com/anhquanbd2021/deterministic-where-you-can](https://github.com/anhquanbd2021/deterministic-where-you-can)
