// The release scripts decide what gets published and under which dist-tag, so
// they are tested by EXECUTION rather than by reading their regexes. A
// pre-release leaking onto `latest` hands every `npm install` an RC, and a tag
// that disagrees with package.json publishes the wrong version under the right
// name — neither failure is visible until after it has shipped.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = (name) => path.join(ROOT, '.github', 'scripts', name);

function run(name, arg) {
  return execFileSync('bash', [script(name), arg], { cwd: ROOT, encoding: 'utf8' }).trim();
}
function fails(name, arg) {
  try {
    execFileSync('bash', [script(name), arg], { cwd: ROOT, stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
}

test('dist-tag: releases take latest, pre-releases take next', () => {
  assert.equal(run('npm-dist-tag.sh', 'v1.2.3'), 'latest');
  assert.equal(run('npm-dist-tag.sh', '1.2.3'), 'latest');
  assert.equal(run('npm-dist-tag.sh', 'refs/tags/v0.9.0'), 'latest');
  for (const pre of ['v1.2.3-rc.1', 'v1.2.3-alpha', 'refs/tags/v2.0.0-beta.4']) {
    assert.equal(run('npm-dist-tag.sh', pre), 'next', `${pre} must not take latest`);
  }
});

test('version validation accepts the tag that matches package.json', () => {
  const version = JSON.parse(
    execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], {
      cwd: ROOT, encoding: 'utf8',
    })
  ).version;
  assert.equal(run('validate-release-version.sh', `v${version}`), version);
});

test('version validation rejects drift from package.json', () => {
  assert.ok(fails('validate-release-version.sh', 'v99.99.99'), 'accepted a tag that does not match');
});

test('version validation rejects malformed semver', () => {
  for (const bad of ['v1.2.3-01', 'v1.2.3-', 'v1.2.3-a..b', 'v01.2.3', 'v1.2', 'v1.2.3+build']) {
    assert.ok(fails('validate-release-version.sh', bad), `accepted malformed tag ${bad}`);
  }
});
