import { readFileSync, writeFileSync, copyFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateRequest } from './validation.js';
import { buildPrompt } from './prompt_builder.js';
import { extractCode } from './response_parser.js';
import { runCommand } from './shell_runner.js';
import type {
  CodeGenRequest,
  CodeGenResponse,
  IterationRecord,
  LlmClient,
  ShellResult,
  ShellRunner,
} from './types.js';

const LOG_PATH = process.env['HOUTINI_LM_CODEGEN_LOG_PATH'];

function logIteration(entry: Record<string, unknown>): void {
  if (!LOG_PATH) return;
  try {
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* best-effort */ }
}

function backupPath(targetFile: string): string {
  return `${targetFile}.codegen-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function writeToTarget(req: CodeGenRequest, code: string, backupFile: string | null): void {
  const action = req.target_file_action ?? 'create';
  const target = resolve(req.target_file);

  if (action === 'create' || action === 'replace') {
    writeFileSync(target, code, 'utf8');
    return;
  }

  if (action === 'append') {
    // Restore from backup first so iterations don't stack
    if (backupFile) {
      const original = readFileSync(backupFile, 'utf8');
      writeFileSync(target, original, 'utf8');
    }
    appendFileSync(target, '\n' + code, 'utf8');
    return;
  }

  if (action === 'insert_at_marker') {
    if (backupFile) {
      const original = readFileSync(backupFile, 'utf8');
      writeFileSync(target, original, 'utf8');
    }
    const marker = req.insert_marker ?? '';
    const contents = readFileSync(target, 'utf8');
    const lines = contents.split('\n');
    const markerIdx = lines.findIndex((l) => l.includes(marker));
    if (markerIdx === -1) return; // shouldn't happen — validated in Phase 0
    lines.splice(markerIdx + 1, 0, code);
    writeFileSync(target, lines.join('\n'), 'utf8');
  }
}

function allowedRootsFromEnv(): string[] {
  const raw = process.env['HOUTINI_LM_ALLOWED_PROJECT_ROOTS'] ?? '';
  return raw.split(':').map((r) => r.trim()).filter(Boolean);
}

function readContextFiles(req: CodeGenRequest): Array<{ path: string; content: string }> {
  return (req.context_files ?? []).map((p) => ({
    path: p,
    content: readFileSync(resolve(p), 'utf8'),
  }));
}

export async function runCodeGenLoop(
  req: CodeGenRequest,
  allowedRoots: string[] | null,
  llmClient: LlmClient,
  shellRunner: ShellRunner = runCommand,
): Promise<CodeGenResponse> {
  const roots = allowedRoots ?? allowedRootsFromEnv();
  const totalStart = Date.now();

  // PHASE 0: validation
  const validationErr = validateRequest(req, roots);
  if (validationErr) {
    return {
      success: false,
      iterations_used: 0,
      final_code: '',
      final_file_path: resolve(req.target_file),
      final_build_result: { exit_code: -1, stdout: '', stderr: '', duration_ms: 0 },
      iterations: [],
      total_duration_ms: Date.now() - totalStart,
      total_llm_tokens: 0,
      failure_reason: validationErr.failure_reason,
      failure_details: validationErr.failure_details,
      rollback_performed: false,
    };
  }

  const action = req.target_file_action ?? 'create';
  const targetFile = resolve(req.target_file);
  const maxIterations = req.max_iterations ?? 3;
  const timeoutMs = (req.timeout_per_iteration_seconds ?? 90) * 1000;
  const lengthCapTokens = req.length_cap_tokens ?? 1200;
  const contextFiles = readContextFiles(req);

  // PHASE 1: backup
  let backupFile: string | null = null;
  if (action !== 'create') {
    backupFile = backupPath(targetFile);
    copyFileSync(targetFile, backupFile);
  }

  const iterations: IterationRecord[] = [];
  let totalLlmTokens = 0;
  let lastGeneratedCode = '';
  let lastBuildResult: ShellResult = { exit_code: -1, stdout: '', stderr: '', duration_ms: 0 };
  let lastTestResult: ShellResult | undefined;
  const requestId = Math.random().toString(36).slice(2);

  // PHASE 2: iteration loop
  for (let i = 1; i <= maxIterations; i++) {
    const prompt = buildPrompt({
      task: req.task,
      iteration: i,
      lengthCapTokens,
      contextFiles,
      constraints: req.constraints,
      previousCode: i > 1 ? lastGeneratedCode : undefined,
      buildError: i > 1 ? lastBuildResult.stderr || lastBuildResult.stdout : undefined,
      testError: i > 1 ? lastTestResult?.stderr || lastTestResult?.stdout : undefined,
    });

    // STEP B: call LLM
    let llmResp;
    let llmError: string | null = null;
    try {
      llmResp = await llmClient({
        prompt,
        model: req.model ?? 'qwen3-coder-next',
        max_tokens: lengthCapTokens + 200,
        timeout_ms: timeoutMs,
      });
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err);
      llmResp = { content: '', prompt_tokens: 0, completion_tokens: 0, duration_ms: 0 };
    }

    totalLlmTokens += llmResp.prompt_tokens + llmResp.completion_tokens;

    const code = extractCode(llmResp.content);
    if (code === null || llmError) {
      // No code block — treat as iteration failure, feed error back
      lastGeneratedCode = '';
      lastBuildResult = {
        exit_code: 1,
        stdout: '',
        stderr: llmError ?? 'LLM response contained no code block',
        duration_ms: 0,
      };
      lastTestResult = undefined;
      iterations.push({
        iteration: i,
        llm_request_tokens: llmResp.prompt_tokens,
        llm_response_tokens: llmResp.completion_tokens,
        llm_response_time_ms: llmResp.duration_ms,
        generated_code: '',
        build_result: lastBuildResult,
      });
      logIteration({ timestamp: new Date().toISOString(), request_id: requestId, iteration: i, model: req.model ?? 'qwen3-coder-next', task_preview: req.task.slice(0, 100), working_dir: req.working_dir, target_file: req.target_file, llm_tokens_in: llmResp.prompt_tokens, llm_tokens_out: llmResp.completion_tokens, llm_duration_ms: llmResp.duration_ms, build_exit_code: 1, build_duration_ms: 0, test_exit_code: null, result: 'no_code_block_continuing' });
      continue;
    }

    lastGeneratedCode = code;

    // STEP C: write to target file
    try {
      writeToTarget(req, code, backupFile);
    } catch (err) {
      return {
        success: false,
        iterations_used: i,
        final_code: code,
        final_file_path: targetFile,
        final_build_result: { exit_code: 1, stdout: '', stderr: String(err), duration_ms: 0 },
        iterations,
        total_duration_ms: Date.now() - totalStart,
        total_llm_tokens: totalLlmTokens,
        failure_reason: 'filesystem_error',
        failure_details: String(err),
        rollback_performed: false,
      };
    }

    // STEP D: run build command
    const buildResult = await shellRunner(req.build_command, {
      cwd: resolve(req.working_dir),
      timeout_ms: timeoutMs,
      targetFileSubstitution: targetFile,
    });
    lastBuildResult = buildResult;

    let testResult: ShellResult | undefined;
    let iterSuccess = false;

    if (buildResult.exit_code === 0) {
      if (req.test_command) {
        testResult = await shellRunner(req.test_command, {
          cwd: resolve(req.working_dir),
          timeout_ms: timeoutMs,
        });
        lastTestResult = testResult;
        iterSuccess = testResult.exit_code === 0;
      } else {
        iterSuccess = true;
      }
    }

    const iterRecord: IterationRecord = {
      iteration: i,
      llm_request_tokens: llmResp.prompt_tokens,
      llm_response_tokens: llmResp.completion_tokens,
      llm_response_time_ms: llmResp.duration_ms,
      generated_code: code,
      build_result: buildResult,
      test_result: testResult,
    };
    iterations.push(iterRecord);

    logIteration({ timestamp: new Date().toISOString(), request_id: requestId, iteration: i, model: req.model ?? 'qwen3-coder-next', task_preview: req.task.slice(0, 100), working_dir: req.working_dir, target_file: req.target_file, llm_tokens_in: llmResp.prompt_tokens, llm_tokens_out: llmResp.completion_tokens, llm_duration_ms: llmResp.duration_ms, build_exit_code: buildResult.exit_code, build_duration_ms: buildResult.duration_ms, test_exit_code: testResult?.exit_code ?? null, result: iterSuccess ? 'success' : 'iteration_failed_continuing' });

    if (iterSuccess) {
      const finalTest = testResult;
      return {
        success: true,
        iterations_used: i,
        final_code: code,
        final_file_path: targetFile,
        final_build_result: buildResult,
        final_test_result: finalTest,
        iterations,
        total_duration_ms: Date.now() - totalStart,
        total_llm_tokens: totalLlmTokens,
        rollback_performed: false,
      };
    }
  }

  // PHASE 3: failure — leave last code in place
  return {
    success: false,
    iterations_used: maxIterations,
    final_code: lastGeneratedCode,
    final_file_path: targetFile,
    final_build_result: lastBuildResult,
    final_test_result: lastTestResult,
    iterations,
    total_duration_ms: Date.now() - totalStart,
    total_llm_tokens: totalLlmTokens,
    failure_reason: 'max_iterations_exhausted',
    rollback_performed: false,
  };
}
