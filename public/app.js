import {
  GRAPH_NODES, ORDER_FIXTURE, MODEL_ASSUMPTIONS, CODE_NODE_LATENCY_MS,
  MAX_RETRIES, MAX_SIMULATION_ATTEMPTS, MODES, FAILURE_MODES, FUSE_NODE,
  runGraph, replaySeed, compareModes,
} from './graph.mjs';

const $ = sel => document.querySelector(sel);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STEP_MS = reduceMotion ? 0 : 420;

const track = $('#graph-track');
const ledgerBody = $('#ledger-body');
const statusLine = $('#run-status');
const terminalBadge = $('#terminal-badge');
const metricsList = $('#run-metrics');
const replyOut = $('#last-reply');
const replayOut = $('#replay-result');
const compareOut = $('#compare-result');

const usd = n => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
const ms = n => `${n.toLocaleString('en-US')} ms`;
const num = n => n.toLocaleString('en-US');

// ---- graph track -----------------------------------------------------------

function buildTrack() {
  track.innerHTML = '';
  for (const node of [...GRAPH_NODES, FUSE_NODE]) {
    const li = document.createElement('li');
    li.className = `node kind-${node.kind}`;
    li.id = `node-${node.id}`;
    li.dataset.node = node.id;
    li.innerHTML = `<span class="node-kind">${node.kind}</span><strong>${node.label}</strong><span class="node-does">${node.does ?? 'Runaway halt'}</span>`;
    if (node.id === FUSE_NODE.id) li.classList.add('node-fuse');
    track.appendChild(li);
  }
}

function paintNode(nodeId, state) {
  const el = $(`#node-${nodeId}`);
  if (!el) return;
  el.classList.remove('active', 'done', 'failed');
  if (state) el.classList.add(state);
}

function clearTrack() {
  for (const el of track.querySelectorAll('.node')) {
    el.classList.remove('active', 'done', 'failed');
  }
}

// ---- controls ----------------------------------------------------------------

function currentOptions() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const failureMode = $('#omit-tracking').checked
    ? FAILURE_MODES.OMIT_TRACKING.id : FAILURE_MODES.NONE.id;
  const boundRetries = $('#bound-retries').checked;
  const seed = Math.max(0, Math.floor(Number($('#seed').value) || 1));
  return { mode, failureMode, boundRetries, seed };
}

// ---- one run ------------------------------------------------------------------

let runToken = 0;

function describeEvent(e) {
  const cost = e.kind === 'model' ? `${ms(e.latencyMs)} · ${num(e.tokens)} tok · ${usd(e.costUsd)}`
    : e.kind === 'code' ? `${ms(e.latencyMs)} · 0 tok · ${usd(0)}`
    : 'handoff';
  const detail = e.detail ? ` — ${e.detail}` : '';
  return { cost, detail };
}

function paintSummary(result) {
  const m = result.metrics;
  terminalBadge.textContent = result.terminal.toUpperCase();
  terminalBadge.className = `badge term-${result.terminal}`;
  const invalid = result.finalState.sentFailedValidation
    ? '<dt>Note</dt><dd>router sent a reply that <strong>failed validation</strong> — a model-chosen edge shipped the bad draft.</dd>' : '';
  metricsList.innerHTML = `
    <dt>Model calls</dt><dd>${m.modelCalls}</dd>
    <dt>Latency</dt><dd>${ms(m.latencyMs)}</dd>
    <dt>Tokens</dt><dd>${num(m.tokens)}</dd>
    <dt>Cost</dt><dd>${usd(m.costUsd)}</dd>
    <dt>Draft attempts</dt><dd>${m.draftAttempts}</dd>
    <dt>Retries</dt><dd>${result.finalState.retryCount}</dd>${invalid}`;
  replyOut.textContent = result.finalState.lastReply ?? '—';
}

function runOnce() {
  const token = ++runToken;
  const options = currentOptions();
  const result = runGraph(options);
  clearTrack();
  ledgerBody.innerHTML = '';
  statusLine.textContent = `Running ${MODES[options.mode === 'every-node-llm' ? 'EVERY_NODE_LLM' : 'DETERMINISTIC'].label}…`;

  const paint = i => {
    if (token !== runToken) return;
    if (i >= result.events.length) {
      paintSummary(result);
      statusLine.textContent = `Terminal: ${result.terminal} — ${result.metrics.modelCalls} model calls, ${ms(result.metrics.latencyMs)}, ${usd(result.metrics.costUsd)}.`;
      return;
    }
    const e = result.events[i];
    if (i > 0) paintNode(result.events[i - 1].node, 'done');
    paintNode(e.node, e.node === 'checkReply' && /missing/.test(e.detail) ? 'failed' : 'active');
    const { cost, detail } = describeEvent(e);
    const tr = document.createElement('tr');
    tr.className = `ev-${e.kind}`;
    tr.innerHTML = `<td>${e.sequence}</td><td>${e.node}</td><td>${e.kind}</td><td>${e.attempt || '—'}</td><td>${cost}</td><td>${e.next ?? '■'}${detail}</td>`;
    ledgerBody.appendChild(tr);
    if (STEP_MS === 0) {
      paint(i + 1);
    } else {
      setTimeout(() => paint(i + 1), STEP_MS);
    }
  };
  paint(0);
}

// ---- replay --------------------------------------------------------------------

function runReplay() {
  const options = currentOptions();
  const replay = replaySeed({ ...options, seeds: Array.from({ length: 100 }, (_, i) => i + 1) });
  const terminals = {};
  for (const r of replay.runs) terminals[r.terminal] = (terminals[r.terminal] ?? 0) + 1;
  const termText = Object.entries(terminals).map(([t, n]) => `${t} ×${n}`).join(', ');
  const sample = replay.routes.slice(0, 3).map(r => `<code>${r}</code>`).join('<br>');
  replayOut.innerHTML = replay.uniqueRoutes === 1
    ? `<p><strong>1 unique route</strong> across 100 replays — the pure router always picks the same edge. ${termText}.</p><p>Route: ${sample}</p>`
    : `<p><strong>${replay.uniqueRoutes} unique routes</strong> across 100 replays — identical state, different seeded model edges. ${termText}.</p><p>Sample routes:<br>${sample}${replay.uniqueRoutes > 3 ? '<br>…' : ''}</p>`;
}

// ---- compare ---------------------------------------------------------------------

function modeColumn(label, s) {
  const terms = Object.entries(s.terminals).map(([t, n]) => `${t} ×${n}`).join(' · ');
  return `<article class="panel compare-col">
    <h3>${label}</h3>
    <dl>
      <dt>Median model calls</dt><dd>${s.medianModelCalls}</dd>
      <dt>Median latency</dt><dd>${ms(s.medianLatencyMs)}</dd>
      <dt>p99 latency</dt><dd>${ms(s.p99LatencyMs)}</dd>
      <dt>Total tokens (100 runs)</dt><dd>${num(s.totalTokens)}</dd>
      <dt>Total cost (100 runs)</dt><dd>${usd(s.totalCostUsd)}</dd>
      <dt>Unique routes</dt><dd>${s.uniqueRoutes}</dd>
      <dt>Terminals</dt><dd>${terms}</dd>
    </dl>
  </article>`;
}

function runCompare() {
  const { boundRetries, failureMode } = currentOptions();
  const c = compareModes({ boundRetries, failureMode });
  compareOut.innerHTML =
    modeColumn(MODES.EVERY_NODE_LLM.label, c[MODES.EVERY_NODE_LLM.id]) +
    modeColumn(MODES.DETERMINISTIC.label, c[MODES.DETERMINISTIC.id]);
}

// ---- wiring ---------------------------------------------------------------------

buildTrack();
$('#run-once').addEventListener('click', runOnce);
$('#replay-seed').addEventListener('click', runReplay);
$('#compare-100').addEventListener('click', runCompare);
for (const input of document.querySelectorAll('#run-controls input')) {
  input.addEventListener('change', () => {
    runToken += 1;
    clearTrack();
    ledgerBody.innerHTML = '';
    terminalBadge.textContent = '—';
    terminalBadge.className = 'badge';
    metricsList.innerHTML = '';
    replyOut.textContent = '—';
    statusLine.textContent = 'Controls changed — run again.';
  });
}
