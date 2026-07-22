import { createHash, createPublicKey } from 'node:crypto';
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [keyArgument, chromeArgument, outputArgument] = process.argv.slice(2);
if (!keyArgument || !chromeArgument || !outputArgument)
  throw new Error('usage: node package-crx.mjs <signing-key.pem> <chrome-binary> <output-dir>');

const keyPath = resolve(keyArgument);
const chromePath = resolve(chromeArgument);
const outputRoot = resolve(outputArgument);
const privateKey = await readFile(keyPath);
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const extensionId = extensionIdFromPublicKey(publicKey);
const temporary = await mkdtemp(join(tmpdir(), 'tyrs-browser-extension-'));

try {
  const extensionRoot = join(temporary, 'extension');
  await cp(resolve(import.meta.dirname, '../dist'), extensionRoot, { recursive: true });
  const manifestPath = join(extensionRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.key = publicKey.toString('base64');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = spawnSync(chromePath, [
    `--pack-extension=${extensionRoot}`,
    `--pack-extension-key=${keyPath}`,
  ], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`Chrome failed to package CRX: ${result.stderr || result.stdout}`);
  await mkdir(outputRoot, { recursive: true });
  const crxPath = join(outputRoot, 'tyrs-browser-extension.crx');
  await copyFile(join(temporary, `${basename(extensionRoot)}.crx`), crxPath);
  await writeFile(join(outputRoot, 'extension-release.json'), `${JSON.stringify({
    extensionId,
    version: manifest.version,
    sha256: createHash('sha256').update(await readFile(crxPath)).digest('hex'),
  }, null, 2)}\n`);
  console.log(extensionId);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function extensionIdFromPublicKey(publicKey) {
  const alphabet = 'abcdefghijklmnop';
  const prefix = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  return [...prefix].map(byte => alphabet[byte >> 4] + alphabet[byte & 15]).join('');
}
