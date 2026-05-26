import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import {
  ALLOWED_MODELS,
  SHELL_METACHARACTERS,
  ALLOWED_BINARIES,
  type CodeGenRequest,
  type FailureReason,
} from './types.js';

export interface ValidationError {
  failure_reason: FailureReason;
  failure_details: string;
}

function fail(reason: FailureReason, details: string): ValidationError {
  return { failure_reason: reason, failure_details: details };
}

function isDescendant(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return !rel.startsWith('..') && !rel.startsWith('/');
}

export function validateRequest(
  req: CodeGenRequest,
  allowedRoots: string[],
): ValidationError | null {
  if (allowedRoots.length === 0) {
    return fail('allowed_roots_not_configured', 'HOUTINI_LM_ALLOWED_PROJECT_ROOTS is not configured');
  }

  const workDir = resolve(req.working_dir);
  const underRoot = allowedRoots.some((r) => isDescendant(workDir, resolve(r)));
  if (!underRoot) {
    return fail('working_dir_not_allowed', `working_dir "${req.working_dir}" is not under any allowed project root`);
  }

  const targetFile = resolve(req.target_file);
  if (!isDescendant(targetFile, workDir)) {
    return fail('target_file_outside_working_dir', `target_file "${req.target_file}" is not inside working_dir`);
  }

  const model = req.model ?? 'qwen3-coder-next';
  if (!(ALLOWED_MODELS as readonly string[]).includes(model)) {
    return fail('invalid_model', `"${model}" is not an allowed model alias`);
  }

  const buildErr = validateBuildCommand(req.build_command);
  if (buildErr) return buildErr;

  const action = req.target_file_action ?? 'create';
  const fileExists = existsSync(targetFile);

  if (action === 'create' && fileExists) {
    return fail('target_file_already_exists', `target_file "${req.target_file}" already exists (action=create requires it to not exist)`);
  }
  if ((action === 'replace' || action === 'append' || action === 'insert_at_marker') && !fileExists) {
    return fail('target_file_missing', `target_file "${req.target_file}" does not exist (action=${action} requires it to exist)`);
  }

  if (action === 'insert_at_marker') {
    const marker = req.insert_marker ?? '';
    const contents = readFileSync(targetFile, 'utf8');
    if (!contents.split('\n').some((line) => line === marker || line.includes(marker))) {
      return fail('insert_marker_not_found', `insert_marker "${marker}" was not found in "${req.target_file}"`);
    }
  }

  for (const ctx of req.context_files ?? []) {
    if (!existsSync(resolve(ctx))) {
      return fail('context_file_not_found', `context_file "${ctx}" does not exist`);
    }
  }

  return null;
}

function validateBuildCommand(cmd: string): ValidationError | null {
  for (const meta of SHELL_METACHARACTERS) {
    if (cmd.includes(meta)) {
      return fail('build_command_not_found', `build_command contains shell metacharacter "${meta}"`);
    }
  }

  const binary = cmd.trim().split(/\s+/)[0] ?? '';
  if (binary.startsWith('/')) {
    const name = binary.split('/').at(-1) ?? '';
    if (!(ALLOWED_BINARIES as readonly string[]).includes(name)) {
      return fail('build_command_not_found', `absolute-path binary "${binary}" is not in the allowed build tools list`);
    }
  }

  return null;
}
