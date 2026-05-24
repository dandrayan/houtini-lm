#!/usr/bin/env node
/**
 * Preflight estimator bypass tests.
 *
 * Spawns the server with HOUTINI_LM_PREFILL_THRESHOLD_SEC=0 to force
 * the estimator to refuse any input, then verifies the bypass options work.
 *
 * These tests do not require a live LLM endpoint.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeClient(extraEnv = {}) {
  const server = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  let nextId = 1;

  server.stdout.on('data', (chunk) => {
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
      } catch { /* ignore non-JSON */ }
    }
  });

  server.stderr.on('data', () => {}); // silence server stderr

  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`RPC ${method} timed out`)); }
      }, 30_000);
    });
  }

  function callTool(name, args) {
    return rpc('tools/call', { name, arguments: args });
  }

  return { server, rpc, callTool };
}

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

// ── Phase 1 tests ─────────────────────────────────────────────────────────
// These should be RED before the threshold env var and skip_preflight schema
// are implemented, and GREEN after.

const { server: s1, rpc: rpc1, callTool: ct1 } = makeClient({
  HOUTINI_LM_PREFILL_THRESHOLD_SEC: '0',
});

try {
  await rpc1('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'preflight-test', version: '0.1.0' },
  });
  await sleep(300);

  console.log('\n=== Preflight Bypass Tests — Phase 1 ===\n');

  await test('code_task_files: schema includes skip_preflight property', async () => {
    const res = await rpc1('tools/list', {});
    const tool = res.tools?.find(t => t.name === 'code_task_files');
    if (!tool?.inputSchema?.properties?.skip_preflight) {
      throw new Error('code_task_files schema missing skip_preflight property');
    }
  });

  await test('code_task_files: HOUTINI_LM_PREFILL_THRESHOLD_SEC=0 forces preflight refusal', async () => {
    const tmpPath = join(tmpdir(), `houtini-preflight-test-${Date.now()}.ts`);
    await writeFile(tmpPath, 'const x = 1;\n');
    try {
      const res = await ct1('code_task_files', { paths: [tmpPath], task: 'explain' });
      const text = res.content?.[0]?.text || '';
      if (!text.includes('estimated prefill time')) {
        throw new Error(`Expected preflight error, got: ${text.slice(0, 200)}`);
      }
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });

} finally {
  s1.kill();
}

console.log(`\n--- Phase 1: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  console.log('(Phase 2 tests skipped — implement Phase 1 features first)\n');
  process.exit(1);
}

// ── Phase 2 tests ─────────────────────────────────────────────────────────
// These can only be in a true RED state once Phase 1 is implemented
// (threshold=0 must force refusal before the bypass can be tested).

const phase1Passed = passed;

// per-call bypass: threshold=0 server, skip_preflight=true
const { server: s2, rpc: rpc2, callTool: ct2 } = makeClient({
  HOUTINI_LM_PREFILL_THRESHOLD_SEC: '0',
});

// env var bypass: threshold=0 AND skip env var
const { server: s3, rpc: rpc3, callTool: ct3 } = makeClient({
  HOUTINI_LM_PREFILL_THRESHOLD_SEC: '0',
  HOUTINI_LM_SKIP_PREFLIGHT: '1',
});

try {
  await Promise.all([
    rpc2('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't2', version: '0' } }),
    rpc3('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't3', version: '0' } }),
  ]);
  await sleep(300);

  console.log('\n=== Preflight Bypass Tests — Phase 2 ===\n');

  await test('code_task_files: skip_preflight=true bypasses forced refusal', async () => {
    const tmpPath = join(tmpdir(), `houtini-bypass-percall-${Date.now()}.ts`);
    await writeFile(tmpPath, 'const x = 1;\n');
    try {
      const res = await ct2('code_task_files', {
        paths: [tmpPath],
        task: 'explain',
        skip_preflight: true,
      });
      const text = res.content?.[0]?.text || '';
      if (text.includes('estimated prefill time')) {
        throw new Error(`Preflight error still returned with skip_preflight=true: ${text.slice(0, 200)}`);
      }
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });

  await test('code_task_files: HOUTINI_LM_SKIP_PREFLIGHT=1 bypasses forced refusal', async () => {
    const tmpPath = join(tmpdir(), `houtini-bypass-envvar-${Date.now()}.ts`);
    await writeFile(tmpPath, 'const x = 1;\n');
    try {
      const res = await ct3('code_task_files', { paths: [tmpPath], task: 'explain' });
      const text = res.content?.[0]?.text || '';
      if (text.includes('estimated prefill time')) {
        throw new Error(`Preflight error still returned with HOUTINI_LM_SKIP_PREFLIGHT=1: ${text.slice(0, 200)}`);
      }
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });

} finally {
  s2.kill();
  s3.kill();
}

const totalPassed = passed;
const totalFailed = failed;
console.log(`\n=== Results: ${totalPassed} passed, ${totalFailed} failed ===\n`);
process.exit(totalFailed > 0 ? 1 : 0);
