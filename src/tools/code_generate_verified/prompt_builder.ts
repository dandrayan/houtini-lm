export interface ContextFile {
  path: string;
  content: string;
}

export interface BuildPromptOptions {
  task: string;
  iteration: number;
  lengthCapTokens: number;
  contextFiles?: ContextFile[];
  constraints?: string;
  previousCode?: string;
  buildError?: string;
  testError?: string;
}

export function buildPrompt(opts: BuildPromptOptions): string {
  const { task, iteration, lengthCapTokens, contextFiles = [], constraints, previousCode, buildError, testError } = opts;

  const parts: string[] = [];

  if (contextFiles.length > 0) {
    parts.push('## Context files\n');
    for (const f of contextFiles) {
      parts.push(`=== ${f.path} ===\n\`\`\`\n${f.content}\n\`\`\``);
    }
    parts.push('');
  }

  if (iteration > 1 && previousCode !== undefined) {
    parts.push('You previously generated this code:\n');
    parts.push(`\`\`\`\n${previousCode}\n\`\`\`\n`);

    if (buildError) {
      parts.push('It failed verification. Here is the error from the build command:\n');
      parts.push(`\`\`\`\n${buildError}\n\`\`\`\n`);
    }

    if (testError) {
      parts.push('Tests also failed:\n');
      parts.push(`\`\`\`\n${testError}\n\`\`\`\n`);
    }

    parts.push('Do not repeat the previous mistake. Read the error carefully.\n');
    parts.push('Produce a corrected version. Same constraints as before:\n');
  } else {
    parts.push(`## Task\n\n${task}\n`);
  }

  const constraints_block: string[] = [];
  if (constraints) {
    constraints_block.push(constraints);
  }
  constraints_block.push(`Output at most ~${lengthCapTokens} tokens.`);
  constraints_block.push('Output only the code, no commentary, no explanation.');

  parts.push(`## Constraints\n\n${constraints_block.join('\n')}`);

  if (iteration > 1) {
    parts.push(`\n## Original task\n\n${task}`);
  }

  return parts.join('\n');
}
