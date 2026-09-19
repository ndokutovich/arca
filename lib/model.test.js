// The model cache moved out of the vault's git tree between 0.7.0 and 0.8.0.
// A version bump is no reason to make anyone download 90 MB they already have,
// and nothing else in this file is testable without the network — so this is
// the part that gets pinned.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-model-'));
  fs.mkdirSync(path.join(home, '.claude-vault'), { recursive: true });
  return home;
}

async function withHome(home, fn) {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ARCA_MODEL_DIR: process.env.ARCA_MODEL_DIR,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ARCA_MODEL_DIR;
  try {
    return await fn(await import('./model.js'));
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.ARCA_MODEL_DIR === undefined) delete process.env.ARCA_MODEL_DIR;
    else process.env.ARCA_MODEL_DIR = saved.ARCA_MODEL_DIR;
  }
}

/** A 0.7.0-shaped cache: at the vault root, where git could see it. */
function oldCache(home, { tokenizer = 'x', model = 'y' } = {}) {
  const dir = path.join(home, '.claude-vault', 'models', 'all-MiniLM-L6-v2');
  fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), tokenizer);
  fs.writeFileSync(path.join(dir, 'onnx', 'model.onnx'), model);
  return dir;
}

test('the cache lives under .cache, where git has been told not to look', async () => {
  const home = sandbox();
  await withHome(home, ({ modelDir }) => {
    assert.ok(modelDir().includes(`.cache${path.sep}models`), modelDir());
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('ARCA_MODEL_DIR still wins', async () => {
  const home = sandbox();
  await withHome(home, async ({ modelDir }) => {
    process.env.ARCA_MODEL_DIR = path.join(home, 'elsewhere');
    assert.equal(modelDir(), path.join(home, 'elsewhere'));
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a 0.7.0 cache is moved, not downloaded again', async () => {
  const home = sandbox();
  await withHome(home, async (M) => {
    const old = oldCache(home, { tokenizer: 'the-real-tokenizer', model: 'the-real-weights' });
    const dir = M.modelDir();
    M.adoptOldCache(dir);
    assert.equal(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8'), 'the-real-tokenizer');
    assert.equal(fs.readFileSync(path.join(dir, 'onnx', 'model.onnx'), 'utf8'), 'the-real-weights');
    assert.ok(!fs.existsSync(old), 'the old copy should be gone, not duplicated');
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('an existing cache is not overwritten by an older one', async () => {
  // If both exist, the one at the current path is the one in use. Replacing it
  // with a stale copy would be the worst of the available outcomes.
  const home = sandbox();
  await withHome(home, async (M) => {
    const dir = M.modelDir();
    fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tokenizer.json'), 'current');
    oldCache(home, { tokenizer: 'stale', model: 'stale' });

    M.adoptOldCache(dir);
    assert.equal(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8'), 'current');
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('with no old cache the move is a no-op', async () => {
  const home = sandbox();
  await withHome(home, async (M) => {
    const dir = M.modelDir();
    M.adoptOldCache(dir);
    assert.ok(!fs.existsSync(dir), 'nothing should have been created');
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('an explicit ARCA_MODEL_DIR is never migrated into', async () => {
  const home = sandbox();
  await withHome(home, async (M) => {
    process.env.ARCA_MODEL_DIR = path.join(home, 'chosen');
    const old = oldCache(home);
    M.adoptOldCache(M.modelDir());
    assert.ok(fs.existsSync(old), 'a directory you named is yours to fill');
    assert.ok(!fs.existsSync(path.join(home, 'chosen')));
  });
  fs.rmSync(home, { recursive: true, force: true });
});
