#!/usr/bin/env node
/**
 * Tests for HOUTINI_LM_DISABLE_THINKING=1.
 *
 * Spins up a minimal mock HTTP server that captures request bodies, then
 * verifies the server adds/omits `enable_thinking: false` correctly.
 * Does not require a live LLM endpoint.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// ── Mock HTTP server ──────────────────────────────────────────────────────────

const SSE_RESPONSE = [
  'data: {"id":"c1","object":"chat.completion.chunk","model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","object":"chat.completion.chunk","model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
  'data: [DONE]\n\n',
].join('');

const MODELS_RESPONSE = JSON.stringify({
  object: 'list',
  data: [{ id: 'test-model', object: 'model', state: 'loaded' }],
});

function startMockServer() {
  let lastChatBody = null;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(MODELS_RESPONSE);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        try { lastChatBody = JSON.parse(raw); } catch { lastChatBody = raw; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.end(SSE_RESPONSE);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        getLastBody: () => lastChatBody,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ── MCP client helper ─────────────────────────────────────────────────────────

function makeClient(extraEnv = {}) {
  const s = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  s.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch { /* ignore */ }
    }
  });
  s.stderr.on('data', () => {});
  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      s.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`RPC ${method} timed out`)); } }, 15_000);
    });
  }
  return {
    server: s,
    callTool: (name, args) => rpc('tools/call', { name, arguments: args }),
    rpc,
  };
}

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n=== HOUTINI_LM_DISABLE_THINKING Tests ===\n');

const mock = await startMockServer();
const baseUrl = `http://127.0.0.1:${mock.port}`;

// Server WITHOUT env var — baseline
const { server: s1, callTool: ct1, rpc: rpc1 } = makeClient({
  HOUTINI_LM_ENDPOINT_URL: baseUrl,
  HOUTINI_LM_MODEL: 'test-model',
});

// Server WITH env var
const { server: s2, callTool: ct2, rpc: rpc2 } = makeClient({
  HOUTINI_LM_ENDPOINT_URL: baseUrl,
  HOUTINI_LM_MODEL: 'test-model',
  HOUTINI_LM_DISABLE_THINKING: '1',
});

try {
  await Promise.all([
    rpc1('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't1', version: '0' } }),
    rpc2('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't2', version: '0' } }),
  ]);
  await sleep(300);

  await test('without HOUTINI_LM_DISABLE_THINKING: enable_thinking not sent', async () => {
    await ct1('chat', { message: 'Say OK.', max_tokens: 16 });
    const body = mock.getLastBody();
    if (body == null) throw new Error('No request body captured');
    if ('enable_thinking' in body) {
      throw new Error(`enable_thinking present in body without env var: ${JSON.stringify(body.enable_thinking)}`);
    }
  });

  await test('HOUTINI_LM_DISABLE_THINKING=1: enable_thinking:false sent at top level (Alibaba Cloud / direct)', async () => {
    await ct2('chat', { message: 'Say OK.', max_tokens: 16 });
    const body = mock.getLastBody();
    if (body == null) throw new Error('No request body captured');
    if (body.enable_thinking !== false) {
      throw new Error(`Expected enable_thinking:false at top level, got: ${JSON.stringify(body.enable_thinking)}`);
    }
  });

  await test('HOUTINI_LM_DISABLE_THINKING=1: chat_template_kwargs.enable_thinking:false sent (LM Studio / vLLM)', async () => {
    await ct2('chat', { message: 'Say OK.', max_tokens: 16 });
    const body = mock.getLastBody();
    if (body == null) throw new Error('No request body captured');
    const ctk = body.chat_template_kwargs;
    if (!ctk || ctk.enable_thinking !== false) {
      throw new Error(`Expected chat_template_kwargs.enable_thinking:false, got: ${JSON.stringify(ctk)}`);
    }
  });

  await test('HOUTINI_LM_DISABLE_THINKING=1: enable_thinking:false sent in code_task', async () => {
    await ct2('code_task', { code: 'const x = 1;', task: 'explain', language: 'typescript' });
    const body = mock.getLastBody();
    if (body == null) throw new Error('No request body captured');
    if (body.enable_thinking !== false) {
      throw new Error(`Expected enable_thinking:false in code_task, got: ${JSON.stringify(body.enable_thinking)}`);
    }
    const ctk = body.chat_template_kwargs;
    if (!ctk || ctk.enable_thinking !== false) {
      throw new Error(`Expected chat_template_kwargs.enable_thinking:false in code_task, got: ${JSON.stringify(ctk)}`);
    }
  });

  await test('HOUTINI_LM_DISABLE_THINKING=1: max_tokens NOT inflated (thinking is off)', async () => {
    await ct2('chat', { message: 'Say OK.', max_tokens: 100 });
    const body = mock.getLastBody();
    if (body == null) throw new Error('No request body captured');
    // With thinking disabled, max_tokens should not be inflated 4×.
    // We passed max_tokens:100; inflation would produce 400+.
    if (body.max_tokens > 200) {
      throw new Error(`max_tokens was inflated (${body.max_tokens}) even though thinking is disabled`);
    }
  });

} finally {
  s1.kill();
  s2.kill();
  await mock.close();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
