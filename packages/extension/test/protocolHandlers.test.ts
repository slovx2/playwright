import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { ProtocolV2Handler, resolveChromeMember } from '../src/protocolHandlers';

const bootstrapUrl = 'http://127.0.0.1:8931/browser-bootstrap';

function spy(result?: unknown) {
  const calls: unknown[][] = [];
  const fn = async (...args: unknown[]) => { calls.push(args); return result; };
  return Object.assign(fn, { calls });
}

function eventMock() {
  const listeners = new Set<(...args: any[]) => void>();
  return {
    addListener: (listener: (...args: any[]) => void) => listeners.add(listener),
    removeListener: (listener: (...args: any[]) => void) => listeners.delete(listener),
    emit: (...args: any[]) => [...listeners].forEach(listener => listener(...args)),
  };
}

let attach: ReturnType<typeof spy>;
let detach: ReturnType<typeof spy>;
let sendCommand: ReturnType<typeof spy>;
let create: ReturnType<typeof spy>;
let remove: ReturnType<typeof spy>;
let runtimeMessage: ReturnType<typeof eventMock>;
let tabsUpdated: ReturnType<typeof eventMock>;
let tabsRemoved: ReturnType<typeof eventMock>;
let navigationCommitted: ReturnType<typeof eventMock>;

beforeEach(() => {
  attach = spy();
  detach = spy();
  sendCommand = spy({ result: true });
  create = spy({ id: 9, url: 'https://example.com' });
  const removeCalls: unknown[][] = [];
  const removeFn = async (...args: unknown[]) => {
    removeCalls.push(args);
    queueMicrotask(() => {
      const ids = Array.isArray(args[0]) ? args[0] : [args[0]];
      ids.forEach(id => tabsRemoved.emit(id));
    });
  };
  remove = Object.assign(removeFn, { calls: removeCalls });
  runtimeMessage = eventMock();
  tabsUpdated = eventMock();
  tabsRemoved = eventMock();
  navigationCommitted = eventMock();
  globalThis.chrome = {
    debugger: { attach, detach, sendCommand },
    tabs: {
      create,
      remove,
      query: spy([
        { id: 7, url: 'https://example.com', title: 'Example' },
        { id: 8, url: 'chrome://settings', title: 'Settings' },
        { id: 9, url: 'about:blank', title: '' },
      ]),
      get: spy({ id: 7, windowId: 1, url: 'https://example.com', title: 'Example' }),
      update: spy({ id: 9, windowId: 1, url: 'https://example.com' }),
      group: spy(1),
      sendMessage: spy({ ok: true }),
      onRemoved: tabsRemoved,
      onUpdated: tabsUpdated,
    },
    tabGroups: { update: spy() },
    windows: { get: spy({ focused: true }), update: spy() },
    webNavigation: { onCommitted: navigationCommitted },
    scripting: { executeScript: spy() },
    runtime: { onMessage: runtimeMessage },
    storage: {
      session: { get: spy({}), set: spy() },
    },
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

test('preserves about:blank when creating a tab without an active session', async () => {
  const protocol = handler();
  await protocol.handleCommand({
    id: 1,
    method: 'chrome.tabs.create',
    params: [{ url: 'about:blank' }],
  });
  assert.deepEqual(create.calls, [[{ url: 'about:blank', active: false }]]);
});

test('discovers debuggable user tabs only when explicitly requested', async () => {
  const protocol = handler();
  assert.deepEqual(await protocol.handleCommand({
    id: 1,
    method: 'tyrs.tabs.discover',
    params: [],
  }), [
    { id: 7, url: 'https://example.com', title: 'Example', tyrs: {} },
    { id: 9, url: 'about:blank', title: '', tyrs: {} },
  ]);
  assert.equal((chrome.tabs.query as any).calls.length, 1);
});

test('claims an existing tab with fail-closed title and URL validation', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const protocol = handler();
  await protocol.handleCommand({ id: 1, method: 'tyrs.session.open',
    params: [{ sessionId, name: 'Claim', bootstrapUrl }] });
  await protocol.handleCommand({ id: 2, method: 'tyrs.tab.claim',
    params: [{ sessionId, tabId: 7, title: 'Example', url: 'https://example.com' }] });
  await assert.rejects(protocol.handleCommand({ id: 3, method: 'tyrs.tab.claim',
    params: [{ sessionId, tabId: 7, title: 'Changed', url: 'https://example.com' }] }),
      /title changed/i);
});

test('resets persisted sessions before a new executor takes control', async () => {
  const protocol = handler();
  await protocol.handleCommand({ id: 1, method: 'tyrs.session.open',
    params: [{ sessionId: '11111111-1111-4111-8111-111111111111',
      name: 'Stale', bootstrapUrl }] });
  await protocol.handleCommand({ id: 2, method: 'chrome.tabs.create', params: [{}] });
  await protocol.handleCommand({ id: 3, method: 'tyrs.sessions.reset', params: [] });
  assert.deepEqual(remove.calls, [[9]]);
});

test('finalize closes unmarked agent tabs as a disconnect fallback', async () => {
  const protocol = handler();
  const sessionId = '11111111-1111-4111-8111-111111111111';
  await protocol.handleCommand({ id: 1, method: 'tyrs.session.open',
    params: [{ sessionId, name: 'Cleanup', bootstrapUrl }] });
  await protocol.handleCommand({ id: 2, method: 'chrome.tabs.create', params: [{}] });
  await protocol.handleCommand({ id: 3, method: 'tyrs.session.finalize', params: [{ sessionId }] });
  assert.deepEqual(remove.calls, [[9]]);
});

test('finalize preserves marked agent tabs and their status favicon', async () => {
  const protocol = handler();
  const sessionId = '11111111-1111-4111-8111-111111111111';
  await protocol.handleCommand({ id: 1, method: 'tyrs.session.open',
    params: [{ sessionId, name: 'Deliverable', bootstrapUrl }] });
  await protocol.handleCommand({ id: 2, method: 'chrome.tabs.create', params: [{}] });
  await protocol.handleCommand({ id: 3, method: 'tyrs.tab.disposition',
    params: [{ sessionId, disposition: 'deliverable' }] });
  const faviconCalls = (chrome.scripting.executeScript as any).calls.length;
  (chrome.tabs.get as any) = spy({
    id: 9,
    url: 'https://example.com',
    title: 'Example',
  });
  await protocol.handleCommand({ id: 4, method: 'tyrs.session.finalize', params: [{ sessionId }] });
  assert.deepEqual(remove.calls, []);
  assert.equal((chrome.scripting.executeScript as any).calls.length, faviconCalls);
  assert.deepEqual(detach.calls, [[{ tabId: 9 }]]);
  (chrome.tabs.query as any) = spy([
    { id: 7, url: 'https://example.com', title: 'Example' },
    { id: 9, url: 'https://example.com', title: 'Example' },
  ]);
  assert.deepEqual(await protocol.handleCommand({
    id: 5,
    method: 'tyrs.tabs.discover',
    params: [],
  }), [
    { id: 7, url: 'https://example.com', title: 'Example', tyrs: {} },
    { id: 9, url: 'https://example.com', title: 'Example', tyrs: {
      sessionName: 'Deliverable',
      origin: 'agent',
      disposition: 'deliverable',
    } },
  ]);
});

test('waits for retained tab metadata to restore before discovery', async () => {
  let releaseRestore!: () => void;
  const restoreGate = new Promise<void>(resolve => releaseRestore = resolve);
  (chrome.storage.session.get as any) = async () => {
    await restoreGate;
    return {
      tyrsBrowserSessionsV2: {
        sessions: {},
        leases: {},
        retainedTabs: {
          '9': {
            sessionName: 'Restored deliverable',
            origin: 'agent',
            disposition: 'deliverable',
            title: '',
            url: 'about:blank',
          },
        },
      },
    };
  };
  const protocol = handler();
  const discovery = protocol.handleCommand({
    id: 1,
    method: 'tyrs.tabs.discover',
    params: [],
  });
  releaseRestore();
  const tabs = await discovery as any[];
  assert.deepEqual(tabs.find(tab => tab.id === 9)?.tyrs, {
    sessionName: 'Restored deliverable',
    origin: 'agent',
    disposition: 'deliverable',
  });
  (chrome.tabs.query as any) = spy([
    { id: 9, url: 'https://changed.example', title: 'Changed' },
  ]);
  const recycled = await protocol.handleCommand({
    id: 2,
    method: 'tyrs.tabs.discover',
    params: [],
  }) as any[];
  assert.deepEqual(recycled[0].tyrs, {});
});

test('serializes concurrent debugger input commands per tab', async () => {
  const calls: string[] = [];
  let releasePress!: () => void;
  const pressGate = new Promise<void>(resolve => releasePress = resolve);
  (chrome.debugger as any).sendCommand = async (
      _target: chrome.debugger.DebuggerSession,
      _method: string,
      params: { type?: string },
  ) => {
    calls.push(String(params.type));
    if (params.type === 'mousePressed')
      await pressGate;
  };
  const protocol = handler();
  await protocol.handleCommand({ id: 1, method: 'tyrs.session.open',
    params: [{ sessionId: '11111111-1111-4111-8111-111111111111',
      name: 'Test', bootstrapUrl }] });
  await protocol.handleCommand({ id: 2, method: 'chrome.tabs.create', params: [{}] });
  const pressed = protocol.handleCommand({ id: 3, method: 'chrome.debugger.sendCommand',
    params: [{ tabId: 9 }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10 }] });
  const released = protocol.handleCommand({ id: 4, method: 'chrome.debugger.sendCommand',
    params: [{ tabId: 9 }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10 }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['mousePressed']);
  releasePress();
  await Promise.all([pressed, released]);
  assert.deepEqual(calls, ['mousePressed', 'mouseReleased']);
});

test('routes input by the existing tab lease when another session is active', async () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const protocol = handler();
  await protocol.handleCommand({ id: 1, method: 'tyrs.session.open',
    params: [{ sessionId: first, name: 'First', bootstrapUrl }] });
  await protocol.handleCommand({ id: 2, method: 'chrome.tabs.create', params: [{}] });
  await protocol.handleCommand({ id: 3, method: 'tyrs.session.open',
    params: [{ sessionId: second, name: 'Second', bootstrapUrl }] });
  await protocol.handleCommand({ id: 4, method: 'chrome.debugger.sendCommand',
    params: [{ tabId: 9 }, 'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: 10, y: 10 }] });
  assert.equal(sendCommand.calls.length, 1);
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
      /not a function/i);
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

test('creates background grouped tabs and reports user takeover for the leased tab', async () => {
  const messages: unknown[] = [];
  const protocol = handler(messages);
  await protocol.handleCommand({ id: 1, method: 'tyrs.session.open',
    params: [{ sessionId: '11111111-1111-4111-8111-111111111111',
      name: '🧭 Test', bootstrapUrl }] });
  await protocol.handleCommand({ id: 2, method: 'chrome.tabs.create',
    params: [{ url: 'https://example.com' }] });
  assert.deepEqual(create.calls, [[{ url: 'https://example.com', active: false }]]);
  assert.deepEqual((chrome.tabs.update as any).calls, []);
  assert.deepEqual((chrome.tabs.group as any).calls, [[{ tabIds: 9 }]]);
  tabsUpdated.emit(9, { url: 'chrome://newtab/' });
  navigationCommitted.emit({
    tabId: 9,
    frameId: 0,
    url: 'chrome://newtab/',
    transitionType: 'auto_toplevel',
    transitionQualifiers: [],
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(messages.some(message => (message as any).method === 'tyrs.takeover'), false);
  runtimeMessage.emit({ type: 'tyrs.user.input', kind: 'pointerdown' }, { tab: { id: 9 } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(messages.some(message => (message as any).method === 'tyrs.takeover'), true);
});

test('address bar navigation interrupts even immediately after agent navigation', async () => {
  const messages: unknown[] = [];
  const protocol = handler(messages);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  await protocol.handleCommand({ id: 1, method: 'tyrs.session.open',
    params: [{ sessionId, name: 'Navigation', bootstrapUrl }] });
  await protocol.handleCommand({ id: 2, method: 'chrome.tabs.create',
    params: [{ url: 'https://example.com' }] });
  await protocol.handleCommand({ id: 3, method: 'chrome.debugger.sendCommand',
    params: [{ tabId: 9 }, 'Page.navigate', { url: 'https://example.com/next' }] });
  navigationCommitted.emit({
    tabId: 9,
    frameId: 0,
    url: 'https://user.example/',
    transitionType: 'typed',
    transitionQualifiers: ['from_address_bar'],
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(messages.some(message =>
    (message as any).method === 'tyrs.takeover' &&
    (message as any).params?.[0]?.kind === 'navigation'), true);
});

test('waits for tab removal before allowing a recycled id to be leased', async () => {
  const messages: unknown[] = [];
  (chrome.tabs as any).remove = spy();
  const protocol = handler(messages);
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  await protocol.handleCommand({ id: 1, method: 'tyrs.session.open',
    params: [{ sessionId: first, name: 'First', bootstrapUrl }] });
  await protocol.handleCommand({ id: 2, method: 'chrome.tabs.create', params: [{}] });
  let removalFinished = false;
  const removal = protocol.handleCommand({ id: 3, method: 'chrome.tabs.remove', params: [9] })
      .then(() => removalFinished = true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(removalFinished, false);
  tabsRemoved.emit(9);
  await removal;
  await protocol.handleCommand({ id: 4, method: 'tyrs.session.open',
    params: [{ sessionId: second, name: 'Second', bootstrapUrl }] });
  await protocol.handleCommand({ id: 5, method: 'chrome.tabs.create', params: [{}] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(messages.some(message =>
    (message as any).method === 'tyrs.takeover' &&
    (message as any).params?.[0]?.sessionId === second), false);
  await protocol.handleCommand({ id: 6, method: 'tyrs.visibility',
    params: [{ sessionId: second, visible: true }] });
});
