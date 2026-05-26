export type TargetFileAction = 'create' | 'replace' | 'append' | 'insert_at_marker';

export type ModelAlias = 'qwen3-coder-next' | 'gemma4-26b' | 'qwen3.6-mtp';

export const ALLOWED_MODELS: readonly ModelAlias[] = ['qwen3-coder-next', 'gemma4-26b', 'qwen3.6-mtp'];

export const SHELL_METACHARACTERS = ['&&', '||', ';', '|', '>', '<', '`', '$(', '&'] as const;

export const ALLOWED_BINARIES = ['dotnet', 'npm', 'npx', 'yarn', 'python', 'python3', 'pytest', 'cargo', 'go', 'make'] as const;

export const MAX_OUTPUT_BYTES = 256 * 1024;

export interface CodeGenRequest {
  task: string;
  model?: ModelAlias;
  context_files?: string[];
  target_file: string;
  target_file_action?: TargetFileAction;
  insert_marker?: string;
  build_command: string;
  test_command?: string;
  working_dir: string;
  constraints?: string;
  length_cap_tokens?: number;
  max_iterations?: number;
  timeout_per_iteration_seconds?: number;
}

export interface ShellResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface IterationRecord {
  iteration: number;
  llm_request_tokens: number;
  llm_response_tokens: number;
  llm_response_time_ms: number;
  generated_code: string;
  build_result: ShellResult;
  test_result?: ShellResult;
}

export type FailureReason =
  | 'max_iterations_exhausted'
  | 'build_command_not_found'
  | 'working_dir_not_allowed'
  | 'target_file_outside_working_dir'
  | 'llm_timeout'
  | 'llm_error'
  | 'filesystem_error'
  | 'insert_marker_not_found'
  | 'target_file_already_exists'
  | 'context_file_not_found'
  | 'invalid_model'
  | 'target_file_missing'
  | 'allowed_roots_not_configured';

export interface CodeGenResponse {
  success: boolean;
  iterations_used: number;
  final_code: string;
  final_file_path: string;
  final_build_result: ShellResult;
  final_test_result?: ShellResult;
  iterations: IterationRecord[];
  total_duration_ms: number;
  total_llm_tokens: number;
  failure_reason?: FailureReason;
  failure_details?: string;
  rollback_performed: boolean;
}

export interface LlmResponse {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
}

export interface LlmRequest {
  prompt: string;
  model: ModelAlias;
  max_tokens: number;
  timeout_ms: number;
}

export type LlmClient = (req: LlmRequest) => Promise<LlmResponse>;

export interface ShellRunnerOptions {
  cwd: string;
  timeout_ms: number;
  targetFileSubstitution?: string;
}

export type ShellRunner = (command: string, options: ShellRunnerOptions) => Promise<ShellResult>;
