import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCode } from '../response_parser.js';

describe('extractCode', () => {
  it('extracts a single code block', () => {
    const resp = 'Here is the code:\n```csharp\npublic class Foo {}\n```\nDone.';
    assert.equal(extractCode(resp), 'public class Foo {}');
  });

  it('returns the LAST code block when multiple are present', () => {
    const resp = '```csharp\npublic class Wrong {}\n```\nHere is the corrected version:\n```csharp\npublic class Right {}\n```';
    assert.equal(extractCode(resp), 'public class Right {}');
  });

  it('strips language tag from fenced block', () => {
    const resp = '```typescript\nconst x = 1;\n```';
    assert.equal(extractCode(resp), 'const x = 1;');
  });

  it('handles block with no language tag', () => {
    const resp = '```\nsome code\n```';
    assert.equal(extractCode(resp), 'some code');
  });

  it('returns null when no code block is present', () => {
    const resp = 'This is just plain text with no code block.';
    assert.equal(extractCode(resp), null);
  });

  it('trims leading and trailing whitespace from extracted code', () => {
    const resp = '```python\n\n  def foo():\n    pass\n\n```';
    const code = extractCode(resp);
    assert.ok(code !== null);
    assert.ok(!code.startsWith('\n'));
    assert.ok(!code.endsWith('\n'));
  });

  it('handles MTP restart pattern: last block is the restart after confusion', () => {
    const resp = [
      '```csharp',
      'public class Attempt1 { /* wrong */ }',
      '```',
      'Wait, let me reconsider...',
      '```csharp',
      'public class Attempt2 { /* also wrong */ }',
      '```',
      'Actually, the correct answer is:',
      '```csharp',
      'public class FinalCorrect {}',
      '```',
    ].join('\n');
    assert.equal(extractCode(resp), 'public class FinalCorrect {}');
  });

  it('handles blocks with various language tags', () => {
    for (const lang of ['csharp', 'cs', 'python', 'typescript', 'ts', 'javascript', 'js', 'go', 'rust']) {
      const resp = `\`\`\`${lang}\ncode here\n\`\`\``;
      assert.equal(extractCode(resp), 'code here', `should strip ${lang} tag`);
    }
  });

  it('returns empty string when code block is empty', () => {
    const resp = '```csharp\n```';
    const code = extractCode(resp);
    assert.equal(code, '');
  });
});
