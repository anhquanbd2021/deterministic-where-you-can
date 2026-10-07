import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaticServer } from '../app/server.js';
import { once } from 'node:events';

async function withServer(fn) {
  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('/health and /version respond; Lab and Guide serve the nav', async () => {
  await withServer(async base => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    const version = await fetch(`${base}/version`);
    assert.equal(version.status, 200);
    assert.equal((await version.json()).name, 'deterministic-where-you-can-demo');

    const lab = await fetch(`${base}/`);
    assert.equal(lab.status, 200);
    const labHtml = await lab.text();
    assert.match(labHtml, /Orchestration Tax Lab/);
    assert.match(labHtml, /aria-label="Primary"/);
    for (const tab of ['Lab', 'Guide', 'Source']) assert.ok(labHtml.includes(`>${tab}<`), tab);

    const guide = await fetch(`${base}/guide.html`);
    assert.equal(guide.status, 200);
    assert.match(await guide.text(), /aria-current="page" href="\/guide\.html"/);

    for (const path of ['/app.js', '/graph.mjs', '/styles.css', '/pb-shell.css', '/pb-back.css']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
    }
  });
});

test('POST /api/run replays the graph; GET /api/graph describes it', async () => {
  await withServer(async base => {
    const graph = await fetch(`${base}/api/graph`);
    assert.equal(graph.status, 200);
    const spec = await graph.json();
    assert.equal(spec.nodes.length, 8);
    assert.equal(spec.fixture.orderId, 'ORD-1042');

    const res = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'deterministic', failureMode: 'omit-tracking', boundRetries: true }),
    });
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.terminal, 'escalated');
    assert.equal(run.metrics.draftAttempts, 3);

    const bad = await fetch(`${base}/api/run`, { method: 'POST', body: '{' });
    assert.equal(bad.status, 400);
  });
});

test('unknown paths and traversal return 404; HEAD works', async () => {
  await withServer(async base => {
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/app/server.js`)).status, 404);
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });
});
