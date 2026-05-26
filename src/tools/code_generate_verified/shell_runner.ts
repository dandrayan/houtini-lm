import { spawn } from 'node:child_process';
import { MAX_OUTPUT_BYTES, type ShellResult } from './types.js';

export interface RunCommandOptions {
  cwd: string;
  timeout_ms: number;
  targetFileSubstitution?: string;
}

function parseCommand(cmd: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}

function truncate(buf: Buffer): string {
  if (buf.length <= MAX_OUTPUT_BYTES) return buf.toString('utf8');
  return buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8') + '\n[truncated]';
}

export async function runCommand(command: string, options: RunCommandOptions): Promise<ShellResult> {
  const { cwd, timeout_ms, targetFileSubstitution } = options;

  const resolved = targetFileSubstitution
    ? command.replaceAll('{target_file}', targetFileSubstitution)
    : command;

  const parts = parseCommand(resolved);
  const [bin, ...args] = parts;
  if (!bin) {
    return { exit_code: 1, stdout: '', stderr: 'Empty command', duration_ms: 0 };
  }

  const start = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutLen = 0;
  let stderrLen = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({
        exit_code: 1,
        stdout: '',
        stderr: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
      });
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeout_ms);

    child.stdout!.on('data', (chunk: Buffer) => {
      if (stdoutLen < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      } else {
        stdoutTruncated = true;
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderrLen < MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      } else {
        stderrTruncated = true;
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exit_code: 1,
        stdout: '',
        stderr: err.message,
        duration_ms: Date.now() - start,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      let stdout = truncate(Buffer.concat(stdoutChunks));
      let stderr = truncate(Buffer.concat(stderrChunks));
      if (stdoutTruncated) stdout += '\n[truncated]';
      if (stderrTruncated) stderr += '\n[truncated]';
      resolve({
        exit_code: code ?? 1,
        stdout,
        stderr,
        duration_ms: Date.now() - start,
      });
    });
  });
}
