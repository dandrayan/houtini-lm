import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../prompt_builder.js';

const BASE_TASK = 'Generate a UserDto class with Id (int) and Name (string) properties';
const BASE_CONSTRAINTS = 'Use file-scoped namespace. No XML doc comments.';
const CTX_FILES = [
  { path: '/proj/Models/BaseEntity.cs', content: 'public abstract class BaseEntity { public int Id { get; set; } }' },
];

describe('buildPrompt', () => {
  describe('first iteration', () => {
    it('includes the task description', () => {
      const prompt = buildPrompt({ task: BASE_TASK, iteration: 1, lengthCapTokens: 800 });
      assert.ok(prompt.includes(BASE_TASK), 'prompt must include the task');
    });

    it('includes context files with path headers', () => {
      const prompt = buildPrompt({ task: BASE_TASK, iteration: 1, lengthCapTokens: 800, contextFiles: CTX_FILES });
      assert.ok(prompt.includes('/proj/Models/BaseEntity.cs'), 'must include context file path');
      assert.ok(prompt.includes('BaseEntity'), 'must include context file content');
    });

    it('includes context files in input order', () => {
      const files = [
        { path: '/a.cs', content: 'A' },
        { path: '/b.cs', content: 'B' },
        { path: '/c.cs', content: 'C' },
      ];
      const prompt = buildPrompt({ task: BASE_TASK, iteration: 1, lengthCapTokens: 800, contextFiles: files });
      const posA = prompt.indexOf('/a.cs');
      const posB = prompt.indexOf('/b.cs');
      const posC = prompt.indexOf('/c.cs');
      assert.ok(posA < posB && posB < posC, 'context files must appear in input order');
    });

    it('includes the constraints when provided', () => {
      const prompt = buildPrompt({ task: BASE_TASK, iteration: 1, lengthCapTokens: 800, constraints: BASE_CONSTRAINTS });
      assert.ok(prompt.includes(BASE_CONSTRAINTS), 'must include constraints verbatim');
    });

    it('includes a length cap directive', () => {
      const prompt = buildPrompt({ task: BASE_TASK, iteration: 1, lengthCapTokens: 1200 });
      assert.ok(prompt.includes('1200'), 'must reference the token cap number');
    });

    it('does not include correction language on first iteration', () => {
      const prompt = buildPrompt({ task: BASE_TASK, iteration: 1, lengthCapTokens: 800 });
      assert.ok(!prompt.includes('previously generated'), 'must not have correction preamble');
      assert.ok(!prompt.includes('corrected version'), 'must not have correction language');
    });
  });

  describe('correction iterations (iteration > 1)', () => {
    const prevCode = 'public class UserDto { public int Id { get; set } }';
    const buildError = "error CS1002: ; expected";
    const opts = {
      task: BASE_TASK,
      iteration: 2,
      lengthCapTokens: 800,
      previousCode: prevCode,
      buildError,
    };

    it('includes the previous generated code', () => {
      const prompt = buildPrompt(opts);
      assert.ok(prompt.includes(prevCode), 'must include previous code');
    });

    it('includes the build error output', () => {
      const prompt = buildPrompt(opts);
      assert.ok(prompt.includes(buildError), 'must include the error from build');
    });

    it('instructs to produce a corrected version', () => {
      const prompt = buildPrompt(opts);
      assert.ok(
        prompt.toLowerCase().includes('correct') || prompt.toLowerCase().includes('fix'),
        'must instruct correction',
      );
    });

    it('includes do-not-repeat instruction', () => {
      const prompt = buildPrompt(opts);
      assert.ok(
        prompt.toLowerCase().includes('do not repeat') || prompt.toLowerCase().includes("don't repeat"),
        'must include do-not-repeat instruction',
      );
    });

    it('still includes constraints on correction iterations', () => {
      const prompt = buildPrompt({ ...opts, constraints: BASE_CONSTRAINTS });
      assert.ok(prompt.includes(BASE_CONSTRAINTS), 'constraints must persist across iterations');
    });

    it('still includes length cap on correction iterations', () => {
      const prompt = buildPrompt({ ...opts, lengthCapTokens: 900 });
      assert.ok(prompt.includes('900'), 'length cap must persist across iterations');
    });

    it('includes test error when provided alongside build error', () => {
      const testError = 'FAILED: UserDtoTests.Constructor_SetsDefaults';
      const prompt = buildPrompt({ ...opts, testError });
      assert.ok(prompt.includes(testError), 'must include test failure output');
    });
  });
});
