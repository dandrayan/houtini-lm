import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodeGenLoop } from '../orchestrator.js';
import type { LlmClient, ShellRunner, ShellResult, CodeGenRequest } from '../types.js';

const GOOD_CODE = 'public class UserDto { public int Id { get; set; } }';
const BAD_CODE_1 = 'public class UserDto { public int Id { get; set } }'; // missing semicolon
const BUILD_ERROR = 'error CS1002: ; expected';
const BUILD_SUCCESS: ShellResult = { exit_code: 0, stdout: 'Build succeeded', stderr: '', duration_ms: 100 };
const BUILD_FAIL: ShellResult = { exit_code: 1, stdout: '', stderr: BUILD_ERROR, duration_ms: 100 };
const TEST_SUCCESS: ShellResult = { exit_code: 0, stdout: 'Passed!', stderr: '', duration_ms: 50 };
const TEST_FAIL: ShellResult = { exit_code: 1, stdout: '', stderr: 'FAILED: SomeTest', duration_ms: 50 };

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'houtini-orch-test-'));
}

function makeLlm(responses: string[]): LlmClient {
  let i = 0;
  return async () => ({
    content: responses[i++ % responses.length] ?? '',
    prompt_tokens: 100,
    completion_tokens: 50,
    duration_ms: 200,
  });
}

function makeShell(results: ShellResult[]): ShellRunner {
  let i = 0;
  return async () => results[i++ % results.length] ?? BUILD_FAIL;
}

function baseRequest(root: string, overrides: Partial<CodeGenRequest> = {}): CodeGenRequest {
  return {
    task: 'Generate UserDto',
    model: 'qwen3-coder-next',
    target_file: join(root, 'UserDto.cs'),
    target_file_action: 'create',
    build_command: 'dotnet build',
    working_dir: root,
    max_iterations: 3,
    timeout_per_iteration_seconds: 30,
    length_cap_tokens: 800,
    ...overrides,
  };
}

describe('runCodeGenLoop', () => {
  it('returns success on iteration 1 when build passes immediately', async () => {
    const root = makeRoot();
    const req = baseRequest(root);
    const llm = makeLlm([`\`\`\`csharp\n${GOOD_CODE}\n\`\`\``]);
    const shell = makeShell([BUILD_SUCCESS]);

    const result = await runCodeGenLoop(req, [root], llm, shell);
    assert.equal(result.success, true);
    assert.equal(result.iterations_used, 1);
    assert.equal(result.final_code, GOOD_CODE);
    assert.equal(result.iterations.length, 1);
    rmSync(root, { recursive: true });
  });

  it('returns success on iteration 3 after two failures', async () => {
    const root = makeRoot();
    const req = baseRequest(root);
    const llm = makeLlm([
      `\`\`\`csharp\n${BAD_CODE_1}\n\`\`\``,
      `\`\`\`csharp\n${BAD_CODE_1}\n\`\`\``,
      `\`\`\`csharp\n${GOOD_CODE}\n\`\`\``,
    ]);
    const shell = makeShell([BUILD_FAIL, BUILD_FAIL, BUILD_SUCCESS]);

    const result = await runCodeGenLoop(req, [root], llm, shell);
    assert.equal(result.success, true);
    assert.equal(result.iterations_used, 3);
    rmSync(root, { recursive: true });
  });

  it('returns failure with max_iterations_exhausted after all iterations fail', async () => {
    const root = makeRoot();
    const req = baseRequest(root, { max_iterations: 2 });
    const llm = makeLlm([`\`\`\`csharp\n${BAD_CODE_1}\n\`\`\``]);
    const shell = makeShell([BUILD_FAIL]);

    const result = await runCodeGenLoop(req, [root], llm, shell);
    assert.equal(result.success, false);
    assert.equal(result.failure_reason, 'max_iterations_exhausted');
    assert.equal(result.iterations_used, 2);
    rmSync(root, { recursive: true });
  });

  it('preserves the last generated code on failure (no rollback)', async () => {
    const root = makeRoot();
    const req = baseRequest(root, { max_iterations: 1 });
    const llm = makeLlm([`\`\`\`csharp\n${BAD_CODE_1}\n\`\`\``]);
    const shell = makeShell([BUILD_FAIL]);

    const result = await runCodeGenLoop(req, [root], llm, shell);
    assert.equal(result.success, false);
    assert.equal(result.rollback_performed, false);
    assert.equal(result.final_code, BAD_CODE_1);
    const onDisk = readFileSync(req.target_file, 'utf8').trim();
    assert.equal(onDisk, BAD_CODE_1);
    rmSync(root, { recursive: true });
  });

  it('counts a no-code-block LLM response as an iteration failure', async () => {
    const root = makeRoot();
    const req = baseRequest(root, { max_iterations: 2 });
    const llm = makeLlm([
      'Sorry, I cannot help with that.',    // no code block
      `\`\`\`csharp\n${GOOD_CODE}\n\`\`\``,
    ]);
    const shell = makeShell([BUILD_SUCCESS]);

    const result = await runCodeGenLoop(req, [root], llm, shell);
    assert.equal(result.success, true);
    assert.equal(result.iterations_used, 2, 'no-code-block counts as one iteration');
    rmSync(root, { recursive: true });
  });

  it('runs test_command after successful build and returns success when tests pass', async () => {
    const root = makeRoot();
    const req = baseRequest(root, { test_command: 'dotnet test' });
    const llm = makeLlm([`\`\`\`csharp\n${GOOD_CODE}\n\`\`\``]);
    // shell: build call then test call
    const shell = makeShell([BUILD_SUCCESS, TEST_SUCCESS]);

    const result = await runCodeGenLoop(req, [root], llm, shell);
    assert.equal(result.success, true);
    assert.ok(result.final_test_result !== undefined);
    assert.equal(result.final_test_result!.exit_code, 0);
    rmSync(root, { recursive: true });
  });

  it('iterates when build passes but test_command fails', async () => {
    const root = makeRoot();
    const req = baseRequest(root, { test_command: 'dotnet test', max_iterations: 2 });
    const llm = makeLlm([
      `\`\`\`csharp\n${BAD_CODE_1}\n\`\`\``,
      `\`\`\`csharp\n${GOOD_CODE}\n\`\`\``,
    ]);
    const shell = makeShell([BUILD_SUCCESS, TEST_FAIL, BUILD_SUCCESS, TEST_SUCCESS]);

    const result = await runCodeGenLoop(req, [root], llm, shell);
    assert.equal(result.success, true);
    assert.equal(result.iterations_used, 2);
    rmSync(root, { recursive: true });
  });

  it('creates a backup file when target_file_action is replace', async () => {
    const root = makeRoot();
    const target = join(root, 'Existing.cs');
    writeFileSync(target, 'original content');

    const req = baseRequest(root, {
      target_file: target,
      target_file_action: 'replace',
    });
    const llm = makeLlm([`\`\`\`csharp\n${GOOD_CODE}\n\`\`\``]);
    const shell = makeShell([BUILD_SUCCESS]);

    await runCodeGenLoop(req, [root], llm, shell);

    // Verify a backup file was created alongside the target
    const files = (await import('node:fs')).readdirSync(root);
    const backups = files.filter((f) => f.includes('codegen-backup'));
    assert.ok(backups.length > 0, 'should have created a backup file');
    rmSync(root, { recursive: true });
  });

  it('includes full iteration history in result', async () => {
    const root = makeRoot();
    const req = baseRequest(root, { max_iterations: 3 });
    const llm = makeLlm([
      `\`\`\`csharp\n${BAD_CODE_1}\n\`\`\``,
      `\`\`\`csharp\n${BAD_CODE_1}\n\`\`\``,
      `\`\`\`csharp\n${GOOD_CODE}\n\`\`\``,
    ]);
    const shell = makeShell([BUILD_FAIL, BUILD_FAIL, BUILD_SUCCESS]);

    const result = await runCodeGenLoop(req, [root], llm, shell);
    assert.equal(result.iterations.length, 3);
    assert.equal(result.iterations[0].iteration, 1);
    assert.equal(result.iterations[1].iteration, 2);
    assert.equal(result.iterations[2].iteration, 3);
    rmSync(root, { recursive: true });
  });

  it('returns failure from Phase 0 when working_dir is not allowed', async () => {
    const root = makeRoot();
    const req = baseRequest(root);
    const llm = makeLlm([`\`\`\`csharp\n${GOOD_CODE}\n\`\`\``]);
    const shell = makeShell([BUILD_SUCCESS]);

    const result = await runCodeGenLoop(req, ['/some/other/root'], llm, shell);
    assert.equal(result.success, false);
    assert.equal(result.failure_reason, 'working_dir_not_allowed');
    assert.equal(result.iterations_used, 0);
    assert.equal(result.iterations.length, 0);
    rmSync(root, { recursive: true });
  });

  it('restores from backup before each write when action is append', async () => {
    const root = makeRoot();
    const target = join(root, 'File.cs');
    writeFileSync(target, 'original\n');

    const req = baseRequest(root, {
      target_file: target,
      target_file_action: 'append',
      max_iterations: 2,
    });
    const llm = makeLlm([
      `\`\`\`csharp\n// attempt 1\n\`\`\``,
      `\`\`\`csharp\n// attempt 2\n\`\`\``,
    ]);
    const shell = makeShell([BUILD_FAIL, BUILD_SUCCESS]);

    const result = await runCodeGenLoop(req, [root], llm, shell);
    assert.equal(result.success, true);
    // Final file should have original + attempt 2 only (not attempt 1 stacked)
    const finalContent = readFileSync(target, 'utf8');
    const attempt1Count = (finalContent.match(/attempt 1/g) ?? []).length;
    assert.equal(attempt1Count, 0, 'attempt 1 code should not persist after restoration');
    rmSync(root, { recursive: true });
  });
});
