import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { RelayConnection } from '../src/relayConnection';

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

function spy(result?: unknown) {
  const calls: unknown[][] = [];
  const fn = async (...args: unknown[]) => { calls.push(args); return result; };
  return Object.assign(fn, { calls });
}

let debuggerEvent: ReturnType<typeof eventMock>;
let debuggerDetach: ReturnType<typeof eventMock>;
let tabCreated: ReturnType<typeof eventMock>;
let tabRemoved: ReturnType<typeof eventMock>;
let detach: ReturnType<typeof spy>;
let sent: string[];
let socket: any;

beforeEach(() => {
  debuggerEvent = eventMock();
  debuggerDetach = eventMock();
  tabCreated = eventMock();
  tabRemoved = eventMock();
  detach = spy();
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: { OPEN: 1 } });
  globalThis.chrome = {
    debugger: { attach: spy(), detach, sendCommand: spy({}), onEvent: debuggerEvent, onDetach: debuggerDetach },
    tabs: { create: spy({}), remove: spy(), onCreated: tabCreated, onRemoved: tabRemoved },
  } as unknown as typeof chrome;
  sent = [];
  socket = { readyState: 1, send: (value: string) => sent.push(value), close: spy() };
});

test('deduplicates attachment, filters unrelated events, and detaches all tabs on disconnect', async () => {
  const relay = new RelayConnection(socket);
  relay.attachTab({ id: 7, url: 'https://example.com' } as chrome.tabs.Tab);
  relay.attachTab({ id: 7, url: 'https://example.com' } as chrome.tabs.Tab);
  assert.equal(sent.length, 2, 'tabs are announced until debugger attachment is acknowledged');
  socket.onmessage({ data: JSON.stringify({ id: 1, method: 'chrome.debugger.attach',
    params: [{ tabId: 7 }, '1.3'] }) });
  await nextTurn();
  assert.equal(relay.attachedTabs.has(7), true);
  relay.attachTab({ id: 7, url: 'https://example.com' } as chrome.tabs.Tab);
  assert.equal(sent.length, 3, 'acknowledged tab is not announced again');
  debuggerEvent.emit({ tabId: 99 }, 'Page.loadEventFired', {});
  debuggerEvent.emit({ tabId: 7 }, 'Page.loadEventFired', {});
  assert.equal(sent.filter(value => JSON.parse(value).method === 'chrome.debugger.onEvent').length, 1);

  socket.onclose();
  await nextTurn();
  assert.deepEqual(detach.calls, [[{ tabId: 7 }]]);
  assert.equal(relay.attachedTabs.size, 0);
  assert.equal(debuggerEvent.listeners.size, 0);
  assert.equal(debuggerDetach.listeners.size, 0);
  socket.onerror();
  assert.equal(detach.calls.length, 1, 'close is idempotent');
});

test('returns parse and protocol errors without invoking Chrome APIs', async () => {
  new RelayConnection(socket);
  socket.onmessage({ data: 'not-json' });
  assert.equal(JSON.parse(sent.at(-1)!).error.code, -32700);
  socket.onmessage({ data: JSON.stringify({ id: 9, method: 'chrome.cookies.getAll' }) });
  await nextTurn();
  assert.deepEqual(JSON.parse(sent.at(-1)!), { id: 9, error: 'Unknown method: chrome.cookies.getAll' });
  socket.onmessage({ data: JSON.stringify({ id: 10, method: 'chrome.tabs.remove', params: 9 }) });
  await nextTurn();
  assert.deepEqual(JSON.parse(sent.at(-1)!), { id: 10, error: 'Invalid params for chrome.tabs.remove' });
  assert.equal((chrome.debugger.attach as any).calls.length, 0);
});

test('detach requests are ignored for unknown tabs and forwarded for attached tabs', async () => {
  const relay = new RelayConnection(socket);
  relay.detachTab(3);
  assert.equal(detach.calls.length, 0);
  socket.onmessage({ data: JSON.stringify({ id: 1, method: 'chrome.debugger.attach',
    params: [{ tabId: 3 }, '1.3'] }) });
  await nextTurn();
  relay.detachTab(3);
  await nextTurn();
  assert.deepEqual(detach.calls, [[{ tabId: 3 }]]);
  assert.equal(sent.some(value => JSON.parse(value).method === 'chrome.debugger.onDetach'), true);
});

function nextTurn() {
  return new Promise(resolve => setTimeout(resolve, 0));
}
