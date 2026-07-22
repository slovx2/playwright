import { build } from 'esbuild';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const extensionRoot = resolve(import.meta.dirname, '..');
const testRoot = join(extensionRoot, 'test');
const outputRoot = await mkdtemp(join(tmpdir(), 'tyrs-extension-tests-'));

try {
  const entries = (await readdir(testRoot))
      .filter(name => name.endsWith('.test.ts'))
      .map(name => join(testRoot, name));
  await build({
    entryPoints: entries,
    outdir: outputRoot,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: 'inline',
  });
  const tests = (await readdir(outputRoot)).filter(name => name.endsWith('.test.js')).map(name => join(outputRoot, name));
  const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
  if (result.status !== 0)
    process.exitCode = result.status ?? 1;
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}
