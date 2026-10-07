// graph.mjs — the "where is my order?" agent graph, as a pure domain model.
//
// One run walks eight nodes: classify (model) -> fetchOrder (code) ->
// loadPolicy (code) -> draftReply (model) -> checkReply (code) ->
// routeNext (code router) -> send | retry | escalate (human).
//
// Two architectures share the same nodes:
//   - 'every-node-llm' charges model latency/tokens at EVERY node and lets a
//     seeded model draw choose the route at routeNext.
//   - 'deterministic' charges model cost only at classify + draftReply; every
//     other hop is code, and routeNext is a pure function of typed state.
//
// The module is the single source of truth for the browser lab, the
// /api/run endpoint, the CLI, and the test suite. It has no DOM, clock,
// random-global, network, filesystem, or process access — the seed and
// options supply all variability.

// ---- constants ---------------------------------------------------------

export const GRAPH_NODES = [
  { id: 'classify',   label: 'Classify',    kind: 'model', machine: true,  does: 'Reads free text, returns an intent' },
  { id: 'fetchOrder', label: 'Fetch order', kind: 'code',  machine: true,  does: 'One order-API lookup' },
  { id: 'loadPolicy', label: 'Load policy', kind: 'code',  machine: true,  does: 'Reply rules, from cache' },
  { id: 'draftReply', label: 'Draft reply', kind: 'model', machine: true,  does: 'Writes the customer answer' },
  { id: 'checkReply', label: 'Check reply', kind: 'code',  machine: true,  does: 'Invariant: tracking number present' },
  { id: 'routeNext',  label: 'Router',      kind: 'code',  machine: true,  does: 'Reads booleans, picks the edge' },
  { id: 'send',       label: 'Send',        kind: 'code',  machine: true,  does: 'Delivers the reply' },
  { id: 'escalate',   label: 'Escalate',    kind: 'human', machine: false, does: 'Terminal handoff to a person' },
];

export const ORDER_FIXTURE = {
  orderId: 'ORD-1042',
  status: 'in_transit',
  carrier: 'UPS',
  trackingNumber: '1Z999AA10123456784',
  question: 'where is my order?',
  etaDays: 2,
};

export const MODEL_ASSUMPTIONS = {
  latencyMs: 800,
  tokens: 1200,
  costPerThousandTokensUsd: 0.003,
};
export const MODEL_CALL_COST_USD =
  (MODEL_ASSUMPTIONS.tokens / 1000) * MODEL_ASSUMPTIONS.costPerThousandTokensUsd; // $0.0036

export const CODE_NODE_LATENCY_MS = 8;
export const MAX_RETRIES = 2;
export const MAX_SIMULATION_ATTEMPTS = 25;

export const MODES = {
  EVERY_NODE_LLM: { id: 'every-node-llm', label: 'Every node is an LLM' },
  DETERMINISTIC:  { id: 'deterministic',  label: 'Code where possible' },
};

export const FAILURE_MODES = {
  NONE:          { id: 'none',          label: 'Healthy draft model' },
  OMIT_TRACKING: { id: 'omit-tracking', label: 'Omit tracking number' },
};

export const TERMINALS = { SENT: 'sent', ESCALATED: 'escalated', RUNAWAY: 'runaway' };

// The synthetic node that halts an unbounded draft loop. Bookkeeping, not a
// graph node — always code, never charged model cost.
export const FUSE_NODE = { id: 'runaway-fuse', label: 'Safety fuse', kind: 'code' };

// ---- seeded randomness (supplied, never global) -------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- node work -----------------------------------------------------------

export function classifyIntent(message) {
  const text = String(message ?? '');
  const orderMatch = text.match(/ord-\d{3,}/i);
  const orderId = orderMatch ? orderMatch[0].toUpperCase() : ORDER_FIXTURE.orderId;
  const intent = /where|track|status|order|package|delivery/i.test(text)
    ? 'order-status'
    : 'other';
  return { intent, orderId, confidence: intent === 'order-status' ? 0.98 : 0.42 };
}

export function fetchOrder(orderId) {
  return orderId === ORDER_FIXTURE.orderId ? { ...ORDER_FIXTURE } : null;
}

export function loadPolicy(status) {
  return {
    status,
    // The business promise the reply must keep before it can leave.
    mustIncludeTrackingNumber: status === 'in_transit',
    mustMentionCarrier: true,
    maxRetries: MAX_RETRIES,
    channel: 'email',
  };
}

const DRAFT_OPENERS = ['Good news', 'Quick update', 'Thanks for your patience'];

export function draftReply(state, options = {}) {
  const { order, draftAttempts = 1 } = state;
  const opener = DRAFT_OPENERS[(draftAttempts - 1) % DRAFT_OPENERS.length];
  const eta = `${order.etaDays} business days`;
  // The injected fault: fluent, apologetic — and missing the one fact the
  // customer asked for. Confidence and tone never override the check.
  if (options.failureMode === FAILURE_MODES.OMIT_TRACKING.id) {
    return `${opener} — your ${order.carrier} package for ${order.orderId} is on the way and should arrive within ${eta}.`;
  }
  return `${opener} — order ${order.orderId} is ${order.status.replace(/_/g, ' ')} via ${order.carrier}; track it at ${order.trackingNumber} (ETA ${eta}).`;
}

export function checkReply(reply, order) {
  const hasTrackingNumber = reply.includes(order.trackingNumber);
  const mentionsCarrier = reply.includes(order.carrier);
  const missing = [];
  if (!hasTrackingNumber) missing.push('trackingNumber');
  if (!mentionsCarrier) missing.push('carrier');
  return { pass: missing.length === 0, hasTrackingNumber, mentionsCarrier, missing };
}

// Pure router. In 'deterministic' mode it reads typed state and nothing else:
// pass -> send; fail -> retry until retryCount hits MAX_RETRIES -> escalate.
// In 'every-node-llm' mode a model "decides what happens next" — the seeded
// draw picks an edge and identical state can choose different routes.
export function routeNext(state, options = {}) {
  if (options.mode === MODES.EVERY_NODE_LLM.id) {
    const r = options.draw ? options.draw() : 0;
    return r < 0.4 ? 'send' : r < 0.8 ? 'retry' : 'escalate';
  }
  if (state.check.pass) return 'send';
  if (options.boundRetries === false) return 'retry';
  return state.retryCount < MAX_RETRIES ? 'retry' : 'escalate';
}

// ---- the run -------------------------------------------------------------

function nodeById(id) {
  return GRAPH_NODES.find(n => n.id === id) ?? null;
}

export function runGraph(options = {}) {
  const {
    mode = MODES.DETERMINISTIC.id,
    failureMode = FAILURE_MODES.NONE.id,
    boundRetries = true,
    seed = 1,
  } = options;
  const draw = mulberry32(seed);
  const events = [];

  // In 'every-node-llm' every box is an agent — even the human handoff is
  // charged as a model call drafting the escalation note.
  const kindOf = id => {
    if (id === FUSE_NODE.id) return FUSE_NODE.kind; // bookkeeping, never a call
    return mode === MODES.EVERY_NODE_LLM.id ? 'model' : nodeById(id).kind;
  };

  function emit(nodeId, { attempt = 0, detail = '' } = {}) {
    const kind = kindOf(nodeId);
    if (events.length) events[events.length - 1].next = nodeId;
    events.push({
      sequence: events.length + 1,
      node: nodeId,
      kind,
      attempt,
      latencyMs: kind === 'model' ? MODEL_ASSUMPTIONS.latencyMs
               : kind === 'code' ? CODE_NODE_LATENCY_MS : 0,
      tokens: kind === 'model' ? MODEL_ASSUMPTIONS.tokens : 0,
      costUsd: kind === 'model' ? MODEL_CALL_COST_USD : 0,
      next: null,
      detail,
    });
  }

  const state = {
    message: ORDER_FIXTURE.question,
    retryCount: 0,
    draftAttempts: 0,
    reply: null,
    check: null,
    routeTrace: [],
  };

  emit('classify');
  state.intent = classifyIntent(state.message);
  emit('fetchOrder');
  state.order = fetchOrder(state.intent.orderId);
  emit('loadPolicy');
  state.policy = loadPolicy(state.order.status);

  let terminal = null;
  while (terminal === null) {
    if (state.draftAttempts >= MAX_SIMULATION_ATTEMPTS) {
      emit(FUSE_NODE.id, {
        attempt: state.draftAttempts,
        detail: `halted at ${MAX_SIMULATION_ATTEMPTS} attempts`,
      });
      terminal = TERMINALS.RUNAWAY;
      break;
    }
    state.draftAttempts += 1;
    state.reply = draftReply(state, { failureMode });
    emit('draftReply', { attempt: state.draftAttempts });
    state.check = checkReply(state.reply, state.order);
    emit('checkReply', {
      attempt: state.draftAttempts,
      detail: state.check.pass ? 'pass' : `missing ${state.check.missing.join('+')}`,
    });
    const next = routeNext(state, { mode, boundRetries, draw });
    state.routeTrace.push(next);
    emit('routeNext', { attempt: state.draftAttempts, detail: `-> ${next}` });
    if (next === 'send') {
      emit('send', { attempt: state.draftAttempts });
      terminal = TERMINALS.SENT;
    } else if (next === 'escalate') {
      emit('escalate', { attempt: state.draftAttempts });
      terminal = TERMINALS.ESCALATED;
    } else {
      state.retryCount += 1;
    }
  }

  const sentFailedValidation =
    terminal === TERMINALS.SENT && state.check !== null && !state.check.pass;
  const finalState = {
    orderId: state.order.orderId,
    intent: state.intent.intent,
    retryCount: state.retryCount,
    draftAttempts: state.draftAttempts,
    lastCheck: state.check,
    lastReply: state.reply,
    routeTrace: state.routeTrace,
    sentFailedValidation,
  };
  return { events, metrics: summarizeRun(events), terminal, finalState };
}

// ---- metrics: everything reduced from the event trace -------------------

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function routeKeyOf(events) {
  // The deterministic shape of a run: node ids in visit order. Retries make
  // the key longer, so distinct looping paths still count as distinct routes.
  return events.map(e => e.node).join('>');
}

export function summarizeRun(events) {
  const sum = key => events.reduce((s, e) => s + e[key], 0);
  const last = events[events.length - 1];
  const terminal = last.node === 'send' ? TERMINALS.SENT
                 : last.node === 'escalate' ? TERMINALS.ESCALATED
                 : last.node === FUSE_NODE.id ? TERMINALS.RUNAWAY
                 : 'unknown';
  return {
    steps: events.length,
    modelCalls: events.filter(e => e.kind === 'model').length,
    codeCalls: events.filter(e => e.kind === 'code').length,
    humanSteps: events.filter(e => e.kind === 'human').length,
    draftAttempts: events.filter(e => e.node === 'draftReply').length,
    latencyMs: sum('latencyMs'),
    tokens: sum('tokens'),
    costUsd: Math.round(sum('costUsd') * 1e6) / 1e6,
    terminal,
    routeKey: routeKeyOf(events),
  };
}

// ---- replay + comparison --------------------------------------------------

const DEFAULT_SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);

// Replay the same configuration across a seed set. 'deterministic' always
// lands on one route; 'every-node-llm' scatters across seeded outcomes.
export function replaySeed(options = {}) {
  const { seeds = DEFAULT_SEEDS, ...runOptions } = options;
  const runs = seeds.map(seed => {
    const r = runGraph({ ...runOptions, seed });
    return { seed, terminal: r.terminal, routeKey: r.metrics.routeKey, metrics: r.metrics };
  });
  const routeKeys = runs.map(r => r.routeKey);
  return {
    runs,
    uniqueRoutes: new Set(routeKeys).size,
    routes: [...new Set(routeKeys)],
  };
}

// One fixture, one failure seed, identical assumptions — the honest A/B.
export function compareModes(options = {}) {
  const { seeds = DEFAULT_SEEDS, ...runOptions } = options;
  const summarizeMode = modeId => {
    const replay = replaySeed({ ...runOptions, mode: modeId, seeds });
    const latencies = replay.runs.map(r => r.metrics.latencyMs).sort((a, b) => a - b);
    const modelCalls = replay.runs.map(r => r.metrics.modelCalls).sort((a, b) => a - b);
    const terminals = {};
    for (const r of replay.runs) terminals[r.terminal] = (terminals[r.terminal] ?? 0) + 1;
    return {
      mode: modeId,
      runs: replay.runs.length,
      medianLatencyMs: percentile(latencies, 0.5),
      p99LatencyMs: percentile(latencies, 0.99),
      medianModelCalls: percentile(modelCalls, 0.5),
      totalTokens: replay.runs.reduce((s, r) => s + r.metrics.tokens, 0),
      totalCostUsd: Math.round(replay.runs.reduce((s, r) => s + r.metrics.costUsd, 0) * 1e4) / 1e4,
      uniqueRoutes: replay.uniqueRoutes,
      terminals,
    };
  };
  return {
    [MODES.EVERY_NODE_LLM.id]: summarizeMode(MODES.EVERY_NODE_LLM.id),
    [MODES.DETERMINISTIC.id]: summarizeMode(MODES.DETERMINISTIC.id),
  };
}
