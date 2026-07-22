import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { ProtocolV2Handler, resolveChromeMember } from '../src/protocolHandlers';

function spy(result?: unknown) {
  const calls: unknown[][] = [];
  const fn = async (...args: unknown[]) => { calls.push(args); return result; };
  return Object.assign(fn, { calls });
}

let attach: ReturnType<typeof spy>;
let detach: ReturnType<typeof spy>;
let sendCommand: ReturnType<typeof spy>;
let create: ReturnType<typeof spy>;
let remove: ReturnType<typeof spy>;

beforeEach(() => {
  attach = spy();
  detach = spy();
  sendCommand = spy({ result: true });
  create = spy({ id: 9, url: 'https://example.com' });
  remove = spy();
  globalThis.chrome = {
    debugger: { attach, detach, sendCommand },
    tabs: { create, remove },
  } as unknown as typeof chrome;
});

function handler(messages: unknown[] = [], attached: number[] = [], detached: number[] = []) {
  return new ProtocolV2Handler({
    attachedTabs: new Set(),
    sendMessage: message => messages.push(message),
    notifyTabAttached: tabId => attached.push(tabId),
    notifyTabDetached: tabId => detached.push(tabId),
  });
}

test('allows only the fixed command set and records debugger attachment', async () => {
  const attached: number[] = [];
  const protocol = handler([], attached);
  assert.deepEqual(await protocol.handleCommand({ id: 1, method: 'chrome.debugger.attach',
    params: [{ tabId: 7 }, '1.3'] }), {});
  assert.deepEqual(attach.calls, [[{ tabId: 7 }, '1.3']]);
  assert.deepEqual(attached, [7]);
  assert.deepEqual(await protocol.handleCommand({ id: 2, method: 'chrome.debugger.sendCommand',
    params: [{ tabId: 7 }, 'Page.navigate', { url: 'https://example.com' }] }), { result: true });
  assert.deepEqual(await protocol.handleCommand({ id: 3, method: 'chrome.tabs.create',
    params: [{ url: 'https://example.com' }] }), { id: 9, url: 'https://example.com' });
  assert.deepEqual(await protocol.handleCommand({ id: 4, method: 'chrome.tabs.remove', params: [9] }), {});
  assert.deepEqual(remove.calls, [[9]]);
});

test('rejects unknown methods, malformed params, missing paths, and non-functions', async () => {
  const protocol = handler();
  await assert.rejects(protocol.handleCommand({ id: 1, method: 'chrome.cookies.getAll', params: [] }),
      /Unknown method/);
  await assert.rejects(protocol.handleCommand({ id: 2, method: 'chrome.tabs.remove', params: 9 }),
      /Invalid params/);
  assert.throws(() => resolveChromeMember('invalid.method'), /Invalid chrome method/);
  assert.throws(() => resolveChromeMember('chrome.unknown.method'), /Unknown chrome path/);
  (chrome.tabs as any).remove = 4;
  await assert.rejects(protocol.handleCommand({ id: 3, method: 'chrome.tabs.remove', params: [9] }),
      /Not a function/);
  assert.equal(attach.calls.length, 0);
});

test('emits lifecycle messages with exact protocol shapes', () => {
  const messages: unknown[] = [];
  const protocol = handler(messages);
  protocol.onUserAttachRequest({ id: 3, url: 'https://example.com' } as chrome.tabs.Tab);
  protocol.onUserDetachRequest(3);
  protocol.forwardChromeEvent('chrome.debugger.onEvent', [{ tabId: 3 }, 'Page.loadEventFired']);
  protocol.didInitialize();
  assert.deepEqual(messages, [
    { method: 'chrome.tabs.onCreated', params: [{ id: 3, url: 'https://example.com' }] },
    { method: 'chrome.debugger.onDetach', params: [{ tabId: 3 }, 'target_closed'] },
    { method: 'chrome.debugger.onEvent', params: [{ tabId: 3 }, 'Page.loadEventFired'] },
    { method: 'extension.initialized', params: [] },
  ]);
});
