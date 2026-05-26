import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCodeGenLoop } from '../orchestrator.js';
import type { LlmClient, CodeGenRequest } from '../types.js';

// Path to the fixture .NET project
const FIXTURE_DIR = join(process.cwd(), 'test/fixtures/sample-project');
const TARGET_FILE = join(FIXTURE_DIR, 'GeneratedDto.cs');
const BUILD_CMD = `dotnet build ${FIXTURE_DIR}/SampleProject.csproj`;

// Mocked LLM: returns progressively better code across iterations.
// Iter 1: syntax error (missing semicolon in property setter)
// Iter 2: compile error (undeclared type NonExistentType)
// Iter 3: correct record DTO
const ITER_RESPONSES = [
  // Iteration 1: CS1002 — missing ; in property
  `\`\`\`csharp
namespace SampleProject;

public class GeneratedDto
{
    public int Id { get; set }
    public string Name { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
}
\`\`\``,

  // Iteration 2: CS0246 — unknown type
  `\`\`\`csharp
namespace SampleProject;

public class GeneratedDto
{
    public int Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public NonExistentType999 Email { get; set; } = default!;
}
\`\`\``,

  // Iteration 3: correct code
  `\`\`\`csharp
namespace SampleProject;

public record GeneratedDto(int Id, string Name, string Email);
\`\`\``,
];

function makeMockLlm(): { client: LlmClient; callCount: () => number } {
  let calls = 0;
  const client: LlmClient = async () => {
    const response = ITER_RESPONSES[calls] ?? ITER_RESPONSES[ITER_RESPONSES.length - 1];
    calls++;
    return {
      content: response,
      prompt_tokens: 200,
      completion_tokens: 100,
      duration_ms: 50,
    };
  };
  return { client, callCount: () => calls };
}

function baseRequest(): CodeGenRequest {
  return {
    task: 'Create a GeneratedDto record with Id (int), Name (string), and Email (string) properties',
    model: 'qwen3-coder-next',
    target_file: TARGET_FILE,
    target_file_action: 'create',
    build_command: BUILD_CMD,
    working_dir: FIXTURE_DIR,
    max_iterations: 3,
    timeout_per_iteration_seconds: 120,
    length_cap_tokens: 800,
  };
}

describe('code_generate_verified integration (real dotnet build)', () => {
  before(() => {
    if (existsSync(TARGET_FILE)) rmSync(TARGET_FILE);
  });

  after(() => {
    if (existsSync(TARGET_FILE)) rmSync(TARGET_FILE);
    for (const f of readdirSync(FIXTURE_DIR)) {
      if (f.includes('codegen-backup')) {
        rmSync(join(FIXTURE_DIR, f));
      }
    }
  });

  it('iterates 3 times and succeeds on the third build', { timeout: 120_000 }, async () => {
    const { client, callCount } = makeMockLlm();

    const result = await runCodeGenLoop(baseRequest(), [FIXTURE_DIR], client);

    assert.equal(result.success, true, `Expected success but got: ${result.failure_reason} — ${result.failure_details}`);
    assert.equal(result.iterations_used, 3, 'Should have needed exactly 3 iterations');
    assert.equal(callCount(), 3, 'LLM should have been called exactly 3 times');
    assert.equal(result.rollback_performed, false);

    // Verify the iteration history
    assert.equal(result.iterations.length, 3);
    assert.notEqual(result.iterations[0].build_result.exit_code, 0, 'Iteration 1 should have failed');
    assert.notEqual(result.iterations[1].build_result.exit_code, 0, 'Iteration 2 should have failed');
    assert.equal(result.iterations[2].build_result.exit_code, 0, 'Iteration 3 should have succeeded');

    // Verify the final file exists and contains the correct code
    assert.ok(existsSync(TARGET_FILE), 'Target file should exist after success');
    assert.ok(result.final_code.includes('record GeneratedDto'), 'Final code should be the correct record');
  });

  it('rejects a working_dir outside allowed roots without running any build', { timeout: 5_000 }, async () => {
    const { client, callCount } = makeMockLlm();
    const req = { ...baseRequest() };

    const result = await runCodeGenLoop(req, ['/tmp/not-allowed'], client);

    assert.equal(result.success, false);
    assert.equal(result.failure_reason, 'working_dir_not_allowed');
    assert.equal(result.iterations_used, 0);
    assert.equal(callCount(), 0, 'LLM should not have been called for a rejected request');
  });
});
