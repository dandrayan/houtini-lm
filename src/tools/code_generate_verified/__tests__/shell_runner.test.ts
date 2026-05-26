import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../shell_runner.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'houtini-shell-test-'));

describe('runCommand', () => {
  it('captures exit code 0 and stdout on success', async () => {
    const result = await runCommand('node -e "process.stdout.write(\'hello\\n\')"', { cwd: tmpDir, timeout_ms: 5000 });
    assert.equal(result.exit_code, 0);
    assert.ok(result.stdout.includes('hello'));
    assert.ok(result.duration_ms >= 0);
  });

  it('captures non-zero exit code and stderr on failure', async () => {
    const result = await runCommand('node --eval "process.exit(42)"', { cwd: tmpDir, timeout_ms: 5000 });
    assert.equal(result.exit_code, 42);
  });

  it('respects the working directory', async () => {
    const subdir = join(tmpDir, 'subdir');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(subdir, { recursive: true });
    const result = await runCommand('node --print "process.cwd()"', { cwd: subdir, timeout_ms: 5000 });
    assert.equal(result.exit_code, 0);
    assert.ok(result.stdout.includes('subdir'), `stdout "${result.stdout}" should include "subdir"`);
  });

  it('kills the process and returns non-zero on timeout', async () => {
    const result = await runCommand('node --eval "setTimeout(()=>{},60000)"', { cwd: tmpDir, timeout_ms: 500 });
    assert.notEqual(result.exit_code, 0);
    assert.ok(result.duration_ms < 3000, `should time out quickly, took ${result.duration_ms}ms`);
  });

  it('returns a clear error for a non-existent binary', async () => {
    const result = await runCommand('nonexistent-binary-xyz --version', { cwd: tmpDir, timeout_ms: 5000 });
    assert.notEqual(result.exit_code, 0);
    assert.ok(
      result.stderr.length > 0 || result.stdout.length > 0,
      'should have some error output about the missing binary',
    );
  });

  it('truncates stdout at 256KB with a truncation marker', async () => {
    // Write a script that outputs more than 256KB
    const script = join(tmpDir, 'bigout.mjs');
    writeFileSync(script, `
      const chunk = 'x'.repeat(1024);
      for (let i = 0; i < 300; i++) process.stdout.write(chunk + '\\n');
    `);
    const result = await runCommand(`node ${script}`, { cwd: tmpDir, timeout_ms: 10000 });
    assert.equal(result.exit_code, 0);
    assert.ok(result.stdout.length <= 256 * 1024 + 200, `stdout too large: ${result.stdout.length}`);
    assert.ok(result.stdout.includes('[truncated]'), 'should include truncation marker');
  });

  it('truncates stderr at 256KB with a truncation marker', async () => {
    const script = join(tmpDir, 'bigerr.mjs');
    writeFileSync(script, `
      const chunk = 'e'.repeat(1024);
      for (let i = 0; i < 300; i++) process.stderr.write(chunk + '\\n');
    `);
    const result = await runCommand(`node ${script}`, { cwd: tmpDir, timeout_ms: 10000 });
    assert.ok(result.stderr.length <= 256 * 1024 + 200, `stderr too large: ${result.stderr.length}`);
    assert.ok(result.stderr.includes('[truncated]'), 'should include truncation marker in stderr');
  });

  it('substitutes {target_file} placeholder before execution', async () => {
    const target = join(tmpDir, 'target.txt');
    writeFileSync(target, 'hello');
    // The command prints the path passed as argument; {target_file} should be substituted
    const result = await runCommand('node -e "process.stdout.write(process.argv[1])" {target_file}', {
      cwd: tmpDir,
      timeout_ms: 5000,
      targetFileSubstitution: target,
    });
    assert.equal(result.exit_code, 0);
    assert.ok(result.stdout.includes('target.txt'), `stdout should include the substituted path, got: ${result.stdout}`);
  });
});
