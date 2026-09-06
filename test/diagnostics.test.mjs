import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyPackageFailure, redactDiagnostics, writeDiagnosticLog } from '../src/diagnostics.mjs';

test('diagnostics redact common credentials while retaining useful failure details', () => {
  const text = redactDiagnostics('fatal: unable to access https://someone:private-value@github.com/owner/repo: certificate failure\nAuthorization: Bearer secret-header\nNPM_TOKEN=secret-env\n//registry.example/:_authToken=secret-npm\ngithub_pat_synthetic_token\nhttps://example.invalid/?access_token=secret-query\n');
  for (const secret of ['private-value', 'secret-header', 'secret-env', 'secret-npm', 'github_pat_synthetic_token', 'secret-query']) assert.ok(!text.includes(secret));
  assert.match(text, /certificate failure/);
  assert.match(text, /github\.com\/owner\/repo/);
});

test('large unbroken diagnostic output is handled without unbounded key matching', () => {
  const large = 'A'.repeat(1024 * 1024);
  assert.equal(redactDiagnostics(large), large);
});

test('diagnostic writes are private and reject symlink destinations', async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), 'repo-diagnostics-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'logs');
  const input = { root, fullName: 'owner/repo', kind: 'git', content: 'fatal: ECONNRESET\nGITHUB_TOKEN=secret-value' };
  const file = await writeDiagnosticLog(input);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(file, 'utf8'), /secret-value/);
  const outside = path.join(temp, 'outside');
  await writeFile(outside, 'keep');
  await rm(file);
  await symlink(outside, file);
  await assert.rejects(writeDiagnosticLog(input), /regular file/);
  assert.equal(await readFile(outside, 'utf8'), 'keep');
  await rm(path.join(root, 'owner'), { recursive: true });
  await mkdir(path.join(temp, 'outside-dir'));
  await symlink(path.join(temp, 'outside-dir'), path.join(root, 'owner'));
  await assert.rejects(writeDiagnosticLog(input), /regular directories/);
});

test('package errors distinguish engine, lock, network, permissions, and build failures without exposing output', () => {
  const examples = [
    ['npm error code EBADENGINE\nprivate-value', 'NODE_VERSION'],
    ['npm error code ERESOLVE\nprivate-value', 'DEPENDENCY_CONFLICT'],
    ['npm error code EUSAGE\nnpm ci can only install packages when package.json and package-lock.json are in sync. private-value', 'LOCKFILE_MISMATCH'],
    ['npm error code ECONNRESET\nprivate-value', 'NETWORK'],
    ['npm error code EACCES\nprivate-value', 'FILE_PERMISSIONS'],
    ['npm error code ENOSPC\nprivate-value', 'DISK_FULL'],
  ];
  for (const [output, reason] of examples) {
    const result = classifyPackageFailure({ output, code: 1 });
    assert.equal(result.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /private-value/);
  }
  // An incidental npm warning must not hide the actual fatal error below it.
  assert.equal(classifyPackageFailure({ output: 'npm warn ERESOLVE overriding peer dependency\nnpm error code ENOTFOUND' }).reason, 'NETWORK');
  assert.equal(classifyPackageFailure({ output: 'npm warn EBADENGINE Unsupported engine\nnpm error code EACCES' }).reason, 'FILE_PERMISSIONS');
  assert.equal(classifyPackageFailure({ output: 'compiler: unknown syntax', code: 1 }, { stage: 'build' }).reason, 'BUILD_FAILED');
  assert.equal(classifyPackageFailure({ output: 'npm error code 1\nCannot find specified certificateFile signing.p12', code: 1 }, { stage: 'build' }).reason, 'BUILD_FAILED');
  assert.equal(classifyPackageFailure({ output: 'npm error code SELF_SIGNED_CERT_IN_CHAIN', code: 1 }).reason, 'TLS');
});
