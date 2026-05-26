import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRequest } from '../validation.js';
import type { CodeGenRequest } from '../types.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'houtini-test-'));
}

function baseRequest(overrides: Partial<CodeGenRequest> = {}): CodeGenRequest {
  return {
    task: 'Generate a DTO',
    model: 'qwen3-coder-next',
    target_file: '',       // filled in per test
    target_file_action: 'create',
    build_command: 'dotnet build',
    working_dir: '',       // filled in per test
    ...overrides,
  };
}

describe('validateRequest', () => {
  describe('working_dir', () => {
    it('passes when working_dir is under an allowed root', () => {
      const root = makeTempDir();
      const sub = join(root, 'project');
      mkdirSync(sub);
      const target = join(sub, 'Out.cs');
      const req = baseRequest({ working_dir: sub, target_file: target });
      const err = validateRequest(req, [root]);
      assert.equal(err, null);
      rmSync(root, { recursive: true });
    });

    it('fails when working_dir is not under any allowed root', () => {
      const root = makeTempDir();
      const other = makeTempDir();
      const target = join(other, 'Out.cs');
      const req = baseRequest({ working_dir: other, target_file: target });
      const err = validateRequest(req, [root]);
      assert.ok(err !== null);
      assert.equal(err.failure_reason, 'working_dir_not_allowed');
      rmSync(root, { recursive: true });
      rmSync(other, { recursive: true });
    });

    it('fails when working_dir uses .. to escape an allowed root', () => {
      const root = makeTempDir();
      const escaped = join(root, '..', 'outside');
      const target = join(escaped, 'Out.cs');
      const req = baseRequest({ working_dir: escaped, target_file: target });
      const err = validateRequest(req, [root]);
      assert.ok(err !== null);
      assert.equal(err.failure_reason, 'working_dir_not_allowed');
      rmSync(root, { recursive: true });
    });

    it('fails when allowed roots list is empty', () => {
      const dir = makeTempDir();
      const target = join(dir, 'Out.cs');
      const req = baseRequest({ working_dir: dir, target_file: target });
      const err = validateRequest(req, []);
      assert.ok(err !== null);
      assert.equal(err.failure_reason, 'allowed_roots_not_configured');
      rmSync(dir, { recursive: true });
    });
  });

  describe('target_file location', () => {
    it('fails when target_file is outside working_dir', () => {
      const root = makeTempDir();
      const workDir = join(root, 'work');
      mkdirSync(workDir);
      const outsideFile = join(root, 'Out.cs');
      const req = baseRequest({ working_dir: workDir, target_file: outsideFile });
      const err = validateRequest(req, [root]);
      assert.ok(err !== null);
      assert.equal(err.failure_reason, 'target_file_outside_working_dir');
      rmSync(root, { recursive: true });
    });

    it('fails when target_file uses .. to escape working_dir', () => {
      const root = makeTempDir();
      const workDir = join(root, 'work');
      mkdirSync(workDir);
      const escaped = join(workDir, '..', 'Out.cs');
      const req = baseRequest({ working_dir: workDir, target_file: escaped });
      const err = validateRequest(req, [root]);
      assert.ok(err !== null);
      assert.equal(err.failure_reason, 'target_file_outside_working_dir');
      rmSync(root, { recursive: true });
    });
  });

  describe('model alias', () => {
    it('passes for valid model aliases', () => {
      const root = makeTempDir();
      const target = join(root, 'Out.cs');
      for (const model of ['qwen3-coder-next', 'gemma4-26b', 'qwen3.6-mtp'] as const) {
        const req = baseRequest({ working_dir: root, target_file: target, model });
        const err = validateRequest(req, [root]);
        assert.equal(err, null, `${model} should be valid`);
      }
      rmSync(root, { recursive: true });
    });

    it('fails for an unknown model alias', () => {
      const root = makeTempDir();
      const target = join(root, 'Out.cs');
      const req = baseRequest({ working_dir: root, target_file: target, model: 'gpt-4' as never });
      const err = validateRequest(req, [root]);
      assert.ok(err !== null);
      assert.equal(err.failure_reason, 'invalid_model');
      rmSync(root, { recursive: true });
    });
  });

  describe('build_command metacharacters', () => {
    const metas = ['&&', '||', ';', '|', '>', '<', '`', '$(', '&'];

    for (const meta of metas) {
      it(`rejects build_command containing "${meta}"`, () => {
        const root = makeTempDir();
        const target = join(root, 'Out.cs');
        const req = baseRequest({
          working_dir: root,
          target_file: target,
          build_command: `dotnet build ${meta} rm -rf /`,
        });
        const err = validateRequest(req, [root]);
        assert.ok(err !== null, `Should reject command with ${meta}`);
        assert.equal(err.failure_reason, 'build_command_not_found');
        rmSync(root, { recursive: true });
      });
    }
  });

  describe('build_command binary allowlist', () => {
    it('passes for allowed binary names', () => {
      const root = makeTempDir();
      const target = join(root, 'Out.cs');
      for (const bin of ['dotnet', 'npm', 'npx', 'yarn', 'python', 'python3', 'pytest', 'cargo', 'go', 'make']) {
        const req = baseRequest({ working_dir: root, target_file: target, build_command: `${bin} build` });
        const err = validateRequest(req, [root]);
        assert.equal(err, null, `${bin} should be allowed`);
      }
      rmSync(root, { recursive: true });
    });

    it('rejects an absolute path to a non-allowed binary', () => {
      const root = makeTempDir();
      const target = join(root, 'Out.cs');
      const req = baseRequest({
        working_dir: root,
        target_file: target,
        build_command: '/usr/bin/rm -rf /',
      });
      const err = validateRequest(req, [root]);
      assert.ok(err !== null);
      assert.equal(err.failure_reason, 'build_command_not_found');
      rmSync(root, { recursive: true });
    });

    it('allows an absolute path to an allowed binary', () => {
      const root = makeTempDir();
      const target = join(root, 'Out.cs');
      const req = baseRequest({
        working_dir: root,
        target_file: target,
        build_command: '/usr/bin/dotnet build',
      });
      const err = validateRequest(req, [root]);
      assert.equal(err, null);
      rmSync(root, { recursive: true });
    });
  });

  describe('target_file_action: create', () => {
    it('passes when target file does not exist', () => {
      const root = makeTempDir();
      const target = join(root, 'NewFile.cs');
      const req = baseRequest({ working_dir: root, target_file: target, target_file_action: 'create' });
      const err = validateRequest(req, [root]);
      assert.equal(err, null);
      rmSync(root, { recursive: true });
    });

    it('fails when target file already exists', () => {
      const root = makeTempDir();
      const target = join(root, 'Existing.cs');
      writeFileSync(target, 'existing content');
      const req = baseRequest({ working_dir: root, target_file: target, target_file_action: 'create' });
      const err = validateRequest(req, [root]);
      assert.ok(err !== null);
      assert.equal(err.failure_reason, 'target_file_already_exists');
      rmSync(root, { recursive: true });
    });
  });

  describe('target_file_action: replace/append', () => {
    for (const action of ['replace', 'append'] as const) {
      it(`passes for ${action} when target file exists`, () => {
        const root = makeTempDir();
        const target = join(root, 'Existing.cs');
        writeFileSync(target, 'content');
        const req = baseRequest({ working_dir: root, target_file: target, target_file_action: action });
        const err = validateRequest(req, [root]);
        assert.equal(err, null);
        rmSync(root, { recursive: true });
      });

      it(`fails for ${action} when target file does not exist`, () => {
        const root = makeTempDir();
        const target = join(root, 'Missing.cs');
        const req = baseRequest({ working_dir: root, target_file: target, target_file_action: action });
        const err = validateRequest(req, [root]);
        assert.ok(err !== null);
        assert.equal(err.failure_reason, 'target_file_missing');
        rmSync(root, { recursive: true });
      });
    }
  });

  describe('target_file_action: insert_at_marker', () => {
    it('passes when file exists and marker is found', () => {
      const root = makeTempDir();
      const target = join(root, 'File.cs');
      writeFileSync(target, 'line1\n// INSERT HERE\nline3\n');
      const req = baseRequest({
        working_dir: root,
        target_file: target,
        target_file_action: 'insert_at_marker',
        insert_marker: '// INSERT HERE',
      });
      const err = validateRequest(req, [root]);
      assert.equal(err, null);
      rmSync(root, { recursive: true });
    });

    it('fails when file exists but marker is not found', () => {
      const root = makeTempDir();
      const target = join(root, 'File.cs');
      writeFileSync(target, 'line1\nline2\nline3\n');
      const req = baseRequest({
        working_dir: root,
        target_file: target,
        target_file_action: 'insert_at_marker',
        insert_marker: '// NOT PRESENT',
      });
      const err = validateRequest(req, [root]);
      assert.ok(err !== null);
      assert.equal(err.failure_reason, 'insert_marker_not_found');
      rmSync(root, { recursive: true });
    });

    it('fails when file is missing', () => {
      const root = makeTempDir();
      const target = join(root, 'Missing.cs');
      const req = baseRequest({
        working_dir: root,
        target_file: target,
        target_file_action: 'insert_at_marker',
        insert_marker: '// marker',
      });
      const err = validateRequest(req, [root]);
      assert.ok(err !== null);
      assert.equal(err.failure_reason, 'target_file_missing');
      rmSync(root, { recursive: true });
    });
  });

  describe('context_files', () => {
    it('passes when all context files exist', () => {
      const root = makeTempDir();
      const target = join(root, 'Out.cs');
      const ctx = join(root, 'Ctx.cs');
      writeFileSync(ctx, 'context');
      const req = baseRequest({ working_dir: root, target_file: target, context_files: [ctx] });
      const err = validateRequest(req, [root]);
      assert.equal(err, null);
      rmSync(root, { recursive: true });
    });

    it('fails when a context file does not exist', () => {
      const root = makeTempDir();
      const target = join(root, 'Out.cs');
      const req = baseRequest({
        working_dir: root,
        target_file: target,
        context_files: [join(root, 'Missing.cs')],
      });
      const err = validateRequest(req, [root]);
      assert.ok(err !== null);
      assert.equal(err.failure_reason, 'context_file_not_found');
      rmSync(root, { recursive: true });
    });
  });
});
