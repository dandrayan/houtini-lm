// Extracts the LAST fenced code block from an LLM response.
// Using the last block handles MTP's restart-after-confusion pattern where
// the model re-emits partial attempts before producing the final answer.
export function extractCode(response: string): string | null {
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let last: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(response)) !== null) {
    last = match[1].trim();
  }

  return last;
}
