import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const outputRoot = resolve(process.argv[2] || 'out/tyrs-browser');
const repositoryRoot = resolve(import.meta.dirname, '../..');
const extensionRoot = join(repositoryRoot, 'packages/extension/dist');
const coreArtifact = join(outputRoot, 'playwright-core.tgz');
const extensionArtifact = join(outputRoot, 'tyrs-browser-extension.zip');
const revision = run('git', ['rev-parse', 'HEAD'], repositoryRoot).trim();
const dirty = Boolean(run('git', ['status', '--porcelain'], repositoryRoot).trim());

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
run('npm', ['run', 'build'], repositoryRoot);
const localCoreArtifact = join(repositoryRoot, 'out/tyrs-playwright-core.tgz');
await mkdir(join(repositoryRoot, 'out'), { recursive: true });
run('node', ['utils/pack_package.js', 'playwright-core', localCoreArtifact], repositoryRoot);
await copyFile(localCoreArtifact, coreArtifact);
await rm(localCoreArtifact);
run('zip', ['-q', '-r', extensionArtifact, '.'], extensionRoot);

const extensionManifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
const corePackage = JSON.parse(await readFile(join(repositoryRoot, 'packages/playwright-core/package.json'), 'utf8'));
const artifacts = [extensionArtifact, coreArtifact];
const manifest = {
  repository: 'https://github.com/slovx2/playwright',
  revision,
  dirty,
  extensionVersion: extensionManifest.version,
  playwrightCoreVersion: corePackage.version,
  artifacts: Object.fromEntries(await Promise.all(artifacts.map(async file => [basename(file), {
    sha256: createHash('sha256').update(await readFile(file)).digest('hex'),
  }]))),
};
await writeFile(join(outputRoot, 'playwright-artifacts.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(outputRoot);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}
