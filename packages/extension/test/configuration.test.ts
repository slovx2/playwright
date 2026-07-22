import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfiguration, validateConfiguration } from '../src/configuration';

const managed = {
  relayUrl: 'ws://127.0.0.1:8932/extension',
  statusUrl: 'http://127.0.0.1:8931/extension-status',
  extensionToken: 'managed-token',
};

test('managed values override local configuration without contacting bootstrap', async () => {
  let fetches = 0;
  const result = await loadConfiguration(async () => managed, async () => ({
    relayUrl: 'ws://localhost:1/local',
    statusUrl: 'http://localhost:2/local',
    extensionToken: 'local-token',
  }), async () => {
    fetches++;
    return new Response('{}');
  });
  assert.deepEqual(result, managed);
  assert.equal(fetches, 0);
});

test('loopback bootstrap supplies configuration when Chrome managed storage is empty', async () => {
  let request: { input: string, init?: RequestInit } | undefined;
  const result = await loadConfiguration(async () => ({}), async () => ({}), async (input, init) => {
    request = { input, init };
    return Response.json(managed);
  });
  assert.deepEqual(result, managed);
  assert.equal(request?.input, 'http://127.0.0.1:8931/extension/config');
  assert.deepEqual(request?.init, { cache: 'no-store', credentials: 'omit' });
});

test('storage and bootstrap failures leave the extension unconfigured', async () => {
  assert.equal(await loadConfiguration(async () => { throw new Error('managed failed'); },
      async () => { throw new Error('local failed'); }, async () => new Response('', { status: 503 })), undefined);
  assert.equal(await loadConfiguration(async () => ({}), async () => ({}),
      async () => { throw new Error('offline'); }), undefined);
  assert.equal(await loadConfiguration(async () => ({}), async () => ({}),
      async () => Response.json({ relayUrl: managed.relayUrl })), undefined);
});

test('validation rejects incomplete, malformed, non-loopback and invalid-protocol values', () => {
  for (const value of [
    undefined,
    {},
    { ...managed, relayUrl: 'not-a-url' },
    { ...managed, relayUrl: 'https://127.0.0.1:8932/extension' },
    { ...managed, relayUrl: 'ws://192.168.1.2:8932/extension' },
    { ...managed, statusUrl: 'file:///tmp/status' },
    { ...managed, statusUrl: 'http://example.com/status' },
  ])
    assert.equal(validateConfiguration(value), undefined, JSON.stringify(value));
  assert.deepEqual(validateConfiguration({ ...managed, relayUrl: 'wss://[::1]:8932/extension' }),
      { ...managed, relayUrl: 'wss://[::1]:8932/extension' });
});
