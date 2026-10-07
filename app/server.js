import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRAPH_NODES, ORDER_FIXTURE, MODEL_ASSUMPTIONS, CODE_NODE_LATENCY_MS,
  MAX_RETRIES, MAX_SIMULATION_ATTEMPTS, MODES, FAILURE_MODES,
  runGraph, compareModes,
} from '../public/graph.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const STATIC_FILES = new Map([
  ['/', ['text/html; charset=utf-8', 'index.html']],
  ['/guide.html', ['text/html; charset=utf-8', 'guide.html']],
  ['/styles.css', ['text/css; charset=utf-8', 'styles.css']],
  ['/app.js', ['text/javascript; charset=utf-8', 'app.js']],
  ['/graph.mjs', ['text/javascript; charset=utf-8', 'graph.mjs']],
  ['/pb-shell.css', ['text/css; charset=utf-8', 'pb-shell.css']],
  ['/pb-back.css', ['text/css; charset=utf-8', 'pb-back.css']],
  ['/deterministic-where-you-can-cover.svg', ['image/svg+xml', 'deterministic-where-you-can-cover.svg']],
].map(([path, [type, file]]) => [path, [type, readFileSync(join(PUBLIC, file))]]));
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

function sendJson(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(body));
}

async function readBody(req, limit = 16_384) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('payload too large');
  }
  return body;
}

function cleanRunOptions(raw) {
  const mode = raw.mode === MODES.EVERY_NODE_LLM.id ? MODES.EVERY_NODE_LLM.id : MODES.DETERMINISTIC.id;
  const failureMode = raw.failureMode === FAILURE_MODES.OMIT_TRACKING.id
    ? FAILURE_MODES.OMIT_TRACKING.id : FAILURE_MODES.NONE.id;
  const seed = Number.isInteger(raw.seed) && raw.seed >= 0 && raw.seed < 2 ** 31 ? raw.seed : 1;
  return { mode, failureMode, boundRetries: raw.boundRetries !== false, seed };
}

export function createStaticServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('ok');
      return;
    }
    if (url.pathname === '/version') {
      sendJson(res, 200, {
        name: PACKAGE.name,
        version: PACKAGE.version,
        commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local',
      });
      return;
    }
    if (url.pathname === '/api/graph' && req.method === 'GET') {
      sendJson(res, 200, {
        nodes: GRAPH_NODES,
        fixture: ORDER_FIXTURE,
        assumptions: { model: MODEL_ASSUMPTIONS, codeNodeLatencyMs: CODE_NODE_LATENCY_MS },
        maxRetries: MAX_RETRIES,
        maxSimulationAttempts: MAX_SIMULATION_ATTEMPTS,
        modes: Object.values(MODES),
        failureModes: Object.values(FAILURE_MODES),
      });
      return;
    }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      try {
        const raw = JSON.parse(await readBody(req) || '{}');
        const options = cleanRunOptions(raw);
        if (raw.compare === true) {
          sendJson(res, 200, compareModes(options));
        } else {
          sendJson(res, 200, runGraph(options));
        }
      } catch (err) {
        sendJson(res, 400, { error: 'bad request', detail: String(err.message ?? err) });
      }
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const asset = STATIC_FILES.get(url.pathname);
      if (asset) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'cache-control': 'public, max-age=300',
          'content-type': asset[0],
        }).end(req.method === 'HEAD' ? undefined : asset[1]);
        return;
      }
    }
    res.writeHead(404, SECURITY_HEADERS).end('not found');
  });
}

export async function startProduction({ port = Number(process.env.PORT) || 3000 } = {}) {
  const server = createStaticServer();
  server.listen(port, '0.0.0.0');
  await once(server, 'listening');
  const close = () => new Promise(resolve => server.close(resolve));
  return { server, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server, close } = await startProduction();
  console.log(`Orchestration Tax Lab listening on ${server.address().port}`);
  const shutdown = async () => { await close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
