import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPH_NODES, ORDER_FIXTURE, MODEL_ASSUMPTIONS, CODE_NODE_LATENCY_MS,
  MAX_RETRIES, MAX_SIMULATION_ATTEMPTS, MODES, FAILURE_MODES, FUSE_NODE,
  classifyIntent, fetchOrder, loadPolicy, draftReply, checkReply,
  routeNext, runGraph, summarizeRun, compareModes, replaySeed,
} from '../public/graph.mjs';

const det = o => runGraph({ mode: MODES.DETERMINISTIC.id, ...o });
const llm = o => runGraph({ mode: MODES.EVERY_NODE_LLM.id, ...o });
const omit = { failureMode: FAILURE_MODES.OMIT_TRACKING.id };

test('the graph models all eight nodes in order', () => {
  assert.deepEqual(GRAPH_NODES.map(n => n.id), [
    'classify', 'fetchOrder', 'loadPolicy', 'draftReply',
    'checkReply', 'routeNext', 'send', 'escalate',
  ]);
  assert.equal(GRAPH_NODES.filter(n => n.kind === 'model').length, 2);
  assert.equal(GRAPH_NODES.filter(n => n.kind === 'human').length, 1);
});

test('node work: classify, fetch, policy, draft, check', () => {
  assert.equal(classifyIntent('where is my order?').intent, 'order-status');
  assert.equal(fetchOrder('ORD-1042').trackingNumber, '1Z999AA10123456784');
  assert.equal(fetchOrder('ORD-9999'), null);
  assert.equal(loadPolicy('in_transit').mustIncludeTrackingNumber, true);

  const good = draftReply({ order: ORDER_FIXTURE, draftAttempts: 1 });
  assert.equal(checkReply(good, ORDER_FIXTURE).pass, true);
  const bad = draftReply({ order: ORDER_FIXTURE, draftAttempts: 1 }, omit);
  const check = checkReply(bad, ORDER_FIXTURE);
  assert.equal(check.pass, false);
  assert.deepEqual(check.missing, ['trackingNumber']);
});

test('routeNext is pure: typed state in, one edge out', () => {
  const fail = { pass: false, hasTrackingNumber: false };
  const ok = { pass: true, hasTrackingNumber: true };
  assert.equal(routeNext({ check: ok, retryCount: 0 }), 'send');
  assert.equal(routeNext({ check: fail, retryCount: 0 }), 'retry');
  assert.equal(routeNext({ check: fail, retryCount: MAX_RETRIES }), 'escalate');
  assert.equal(routeNext({ check: fail, retryCount: 0 }, { boundRetries: false }), 'retry');
  // same inputs, same output — no draw, no globals
  assert.equal(routeNext({ check: fail, retryCount: 1 }), routeNext({ check: fail, retryCount: 1 }));
});

test('healthy deterministic run: 2 model calls, exact event-derived metrics', () => {
  const r = det();
  assert.equal(r.terminal, 'sent');
  assert.equal(r.metrics.modelCalls, 2);
  assert.equal(r.metrics.latencyMs, 2 * MODEL_ASSUMPTIONS.latencyMs + 5 * CODE_NODE_LATENCY_MS);
  assert.equal(r.metrics.tokens, 2 * MODEL_ASSUMPTIONS.tokens);
  assert.equal(r.metrics.costUsd, 0.0072);
  assert.deepEqual(r.events.map(e => e.node),
    ['classify', 'fetchOrder', 'loadPolicy', 'draftReply', 'checkReply', 'routeNext', 'send']);
  // every metric on the result is a reduction of the event rows
  assert.equal(r.metrics.latencyMs, r.events.reduce((s, e) => s + e.latencyMs, 0));
  assert.equal(r.metrics.tokens, r.events.reduce((s, e) => s + e.tokens, 0));
  assert.equal(r.metrics.modelCalls, r.events.filter(e => e.kind === 'model').length);
  assert.deepEqual(r.metrics, summarizeRun(r.events));
});

test('same seed replays identically in deterministic mode', () => {
  const a = det({ seed: 42 });
  const b = det({ seed: 42 });
  assert.deepEqual(a.events, b.events);
  const c = det({ seed: 7 });
  assert.equal(c.metrics.routeKey, a.metrics.routeKey); // seed cannot move a pure router
});

test('fault + bound retries: exactly three drafts then escalated', () => {
  const r = det({ ...omit, boundRetries: true });
  assert.equal(r.terminal, 'escalated');
  assert.equal(r.metrics.draftAttempts, 3); // initial + MAX_RETRIES
  assert.equal(r.finalState.retryCount, MAX_RETRIES);
  assert.equal(r.events.at(-1).node, 'escalate');
  assert.equal(r.metrics.modelCalls, 4); // classify + 3 drafts
});

test('fault + no bound: the fuse halts a runaway at exactly 25 drafts', () => {
  const r = det({ ...omit, boundRetries: false });
  assert.equal(r.terminal, 'runaway');
  assert.equal(r.metrics.draftAttempts, MAX_SIMULATION_ATTEMPTS); // exactly 25, no more
  assert.equal(r.events.at(-1).node, FUSE_NODE.id);
  // the loop burned real simulated money before the halt
  assert.equal(r.metrics.tokens, (25 + 1) * MODEL_ASSUMPTIONS.tokens);
  assert.ok(r.metrics.costUsd > 0.09);
});

test('every-node-llm charges the model tax at every machine node', () => {
  const r = llm({ seed: 3 });
  const real = r.events.filter(e => e.node !== FUSE_NODE.id);
  assert.ok(real.every(e => e.kind === 'model'));
  assert.ok(real.every(e => e.latencyMs === 800 && e.tokens === 1200));
  const happy = det();
  assert.ok(r.metrics.costUsd > happy.metrics.costUsd);
});

test('replay: one route in deterministic mode, many in every-node-llm', () => {
  const seeds = Array.from({ length: 100 }, (_, i) => i + 1);
  const d = replaySeed({ mode: MODES.DETERMINISTIC.id, seeds });
  const l = replaySeed({ mode: MODES.EVERY_NODE_LLM.id, seeds });
  assert.equal(d.uniqueRoutes, 1);
  assert.ok(l.uniqueRoutes > 1, `expected scatter, got ${l.uniqueRoutes}`);
});

test('compareModes prices identical work in both architectures', () => {
  const c = compareModes();
  const llmS = c[MODES.EVERY_NODE_LLM.id];
  const detS = c[MODES.DETERMINISTIC.id];
  assert.equal(llmS.runs, 100);
  assert.equal(detS.runs, 100);
  assert.equal(detS.uniqueRoutes, 1);
  assert.ok(llmS.medianModelCalls > detS.medianModelCalls);
  assert.ok(llmS.totalTokens > detS.totalTokens * 3);
  assert.equal(detS.terminals.sent, 100);
});

test('model routing can send a reply that failed validation', () => {
  // In every-node-llm the model router ignores the check — some seed sends
  // the bad draft. That is the failure mode, on demand.
  const seeds = Array.from({ length: 40 }, (_, i) => i + 1);
  const bad = seeds.some(seed => llm({ ...omit, seed }).finalState.sentFailedValidation);
  assert.ok(bad, 'expected at least one seed to ship the invalid reply');
});
