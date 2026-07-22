import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { ProfileConnection, isDebuggable } from '../src/profileConnection';

type Listener = (...args: any[]) => void;

function eventMock() {
  const listeners = new Set<Listener>();
  return {
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    emit: (...args: any[]) => [...listeners].forEach(listener => listener(...args)),
    listeners,
  };
}

function spy() {
  const calls: any[][] = [];
  const fn = (...args: any[]) => calls.push(args);
  return Object.assign(fn, { calls });
}

let created: ReturnType<typeof eventMock>;
let updated: ReturnType<typeof eventMock>;
let removed: ReturnType<typeof eventMock>;
let attachTab: ReturnType<typeof spy>;
let detachTab: ReturnType<typeof spy>;
let didInitialize: ReturnType<typeof spy>;
let closeConnection: ReturnType<typeof spy>;

beforeEach(() => {
  created = eventMock();
  updated = eventMock();
  removed = eventMock();
  attachTab = spy();
  detachTab = spy();
  didInitialize = spy();
  closeConnection = spy();
  globalThis.chrome = {
    tabs: {
      query: async () => [
        { id: 1, url: 'https://example.com' },
        { id: 2, url: 'chrome://settings' },
        { id: 3 },
      ],
      onCreated: created,
      onUpdated: updated,
      onRemoved: removed,
    },
  } as unknown as typeof chrome;
});

test('enumerates current-profile tabs and tracks every lifecycle branch', async () => {
  const relay = { attachTab, detachTab, didInitialize, close: closeConnection } as any;
  const profile = new ProfileConnection(relay);
  await profile.initialize();
  assert.deepEqual(attachTab.calls, [[{ id: 1, url: 'https://example.com' }]]);
  assert.equal(didInitialize.calls.length, 1);

  created.emit({ id: 4, url: 'https://new.example' });
  created.emit({ id: 5, url: 'chrome-extension://blocked/page.html' });
  updated.emit(4, { status: 'loading' }, { id: 4, url: 'https://new.example' });
  updated.emit(4, { status: 'complete' }, { id: 4, url: 'https://new.example/done' });
  updated.emit(4, { url: 'chrome://version' }, { id: 4, url: 'chrome://version' });
  removed.emit(4);
  assert.equal(attachTab.calls.length, 3);
  assert.deepEqual(detachTab.calls, [[4], [4]]);

  profile.close('bridge disconnected');
  assert.deepEqual(closeConnection.calls, [['bridge disconnected']]);
  assert.equal(created.listeners.size, 0);
  assert.equal(updated.listeners.size, 0);
  assert.equal(removed.listeners.size, 0);
  profile.close('second close');
  assert.equal(closeConnection.calls.length, 1);
});

test('filters every internal scheme plus tabs without IDs or URLs', () => {
  for (const url of ['chrome://version', 'chrome-extension://id/page', 'devtools://tools',
    'edge://settings', 'about:blank'])
    assert.equal(isDebuggable({ id: 1, url } as chrome.tabs.Tab), false, url);
  for (const url of ['https://example.com', 'http://127.0.0.1', 'file:///tmp/result.html'])
    assert.equal(isDebuggable({ id: 1, url } as chrome.tabs.Tab), true, url);
  assert.equal(isDebuggable({ id: 1 } as chrome.tabs.Tab), false);
  assert.equal(isDebuggable({ url: 'https://example.com' } as chrome.tabs.Tab), false);
});

test('query failure does not emit initialized or leave listeners installed', async () => {
  chrome.tabs.query = async () => { throw new Error('query failed'); };
  const profile = new ProfileConnection({ attachTab, detachTab, didInitialize, close: closeConnection } as any);
  await assert.rejects(profile.initialize(), /query failed/);
  profile.close();
  assert.equal(didInitialize.calls.length, 0);
  assert.equal(created.listeners.size, 0);
});
