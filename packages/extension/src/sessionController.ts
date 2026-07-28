/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

export type TabDisposition = 'omit' | 'deliverable' | 'handoff';

type SessionState = {
  name: string;
  bootstrapUrl?: string;
  groupId?: number;
  interrupted?: boolean;
  currentTabId?: number;
};

type LeaseState = {
  sessionId: string;
  origin: 'agent' | 'user';
  disposition: TabDisposition;
  title: string;
  url: string;
  originalFavIconUrl?: string;
};

type StoredState = {
  sessions: Record<string, SessionState>;
  leases: Record<string, LeaseState>;
};

type NavigationIntent = {
  expectedUrl?: string;
  allowInternalBlank?: boolean;
  expiresAt: number;
};

const storageKey = 'tyrsBrowserSessionsV2';
const cursorScriptId = 'tyrs-browser-cursor-v2';

export class SessionController {
  private _state: StoredState = { sessions: {}, leases: {} };
  private _activeSessionId = '';
  private _ready: Promise<void>;
  private _closingTabs = new Set<number>();
  private _removalWaiters = new Map<number, Set<() => void>>();
  private _navigationIntents = new Map<number, NavigationIntent>();

  constructor(private readonly _sendEvent: (message: unknown) => void) {
    this._ready = this._restore();
    chrome.tabs.onRemoved.addListener(tabId => {
      const waiters = this._removalWaiters.get(tabId);
      this._removalWaiters.delete(tabId);
      waiters?.forEach(resolve => resolve());
      // Chrome may recycle a tab id immediately. Capture both the close origin
      // and lease identity synchronously, before the async storage restore gate.
      const agentInitiated = this._closingTabs.delete(tabId);
      const lease = this._state.leases[String(tabId)];
      void this._onTabRemoved(tabId, agentInitiated, lease);
    });
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (change.url)
        void this._onTabUpdated(tabId);
    });
    chrome.webNavigation.onCommitted.addListener(details => void this._onCommittedNavigation(details));
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message?.type === 'tyrs.user.input' && sender.tab?.id !== undefined)
        void this.takeover(sender.tab.id, String(message.kind || 'input'));
    });
  }

  async open(sessionId: string, name: string, bootstrapUrl: string): Promise<void> {
    await this._ready;
    await this._ensureCursorScript();
    const parsedBootstrap = new URL(bootstrapUrl);
    if (parsedBootstrap.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(parsedBootstrap.hostname))
      throw new Error('Browser bootstrap URL must use loopback HTTP');
    this._state.sessions[sessionId] ??= { name: normalizeName(name) };
    this._state.sessions[sessionId].bootstrapUrl = parsedBootstrap.href;
    this._state.sessions[sessionId].interrupted = false;
    this._activeSessionId = sessionId;
    await this._persist();
  }

  async activate(sessionId: string): Promise<void> {
    await this._ready;
    const session = this._state.sessions[sessionId];
    if (!session)
      throw new Error('Unknown browser session');
    session.interrupted = false;
    this._activeSessionId = sessionId;
    await this._persist();
    const tabId = this._currentTab(sessionId);
    if (tabId !== undefined)
      await this._cursor(tabId, { action: 'thinking', visual: await this._isWatched(tabId) });
  }

  async idle(sessionId: string): Promise<void> {
    await this._ready;
    const tabId = this._currentTab(sessionId);
    if (tabId !== undefined)
      await this._cursor(tabId, { action: 'thinking', visual: false });
  }

  async name(sessionId: string, name: string): Promise<void> {
    await this._ready;
    const session = this._state.sessions[sessionId];
    if (!session)
      throw new Error('Unknown browser session');
    session.name = normalizeName(name);
    if (session.groupId !== undefined)
      await chrome.tabGroups.update(session.groupId, { title: session.name }).catch(() => undefined);
    await this._persist();
  }

  async createTab(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
    await this._ready;
    const sessionId = this._activeSessionId;
    const { url, ...createProperties } = properties;
    const initialUrl = isDebuggableURL(url) ? url :
      (sessionId ? this._state.sessions[sessionId]?.bootstrapUrl : undefined);
    let tab = await chrome.tabs.create({
      ...createProperties,
      ...(initialUrl ? { url: initialUrl } : {}),
      active: false,
    });
    if (!sessionId || tab.id === undefined)
      return tab;
    // Chrome can report the blank/new-tab commit after tabs.create resolves.
    // Suppress it before the lease exists so that this delayed initial event
    // cannot be mistaken for an address-bar takeover.
    this._navigationIntents.set(tab.id, {
      expectedUrl: url,
      allowInternalBlank: true,
      expiresAt: Date.now() + 15_000,
    });
    await this._claim(tab, sessionId, 'agent');
    await this._group(tab.id, sessionId);
    if (url && url !== initialUrl && isDebuggableURL(url)) {
      tab = await chrome.tabs.update(tab.id, { url });
    }
    return tab;
  }

  describeTab(tabId: number): {
    sessionId?: string;
    sessionName?: string;
    origin?: 'agent' | 'user';
    disposition?: TabDisposition;
  } {
    const lease = this._state.leases[String(tabId)];
    if (!lease)
      return {};
    return {
      sessionId: lease.sessionId,
      sessionName: this._state.sessions[lease.sessionId]?.name,
      origin: lease.origin,
      disposition: lease.disposition,
    };
  }

  async claimExisting(
    sessionId: string,
    tabId: number,
    expectedTitle: string,
    expectedURL: string,
  ): Promise<void> {
    await this._ready;
    if (!Number.isInteger(tabId) || tabId < 0)
      throw new Error('Invalid Chrome tab id');
    const session = this._state.sessions[sessionId];
    if (!session)
      throw new Error('Unknown browser session');
    const existing = this._state.leases[String(tabId)];
    if (existing && existing.sessionId !== sessionId)
      throw new Error(`Tab is leased by session ${existing.sessionId}`);
    const tab = await chrome.tabs.get(tabId);
    if ((tab.url || '') !== expectedURL)
      throw new Error('Tab URL changed after it was listed');
    if ((tab.title || '') !== expectedTitle)
      throw new Error('Tab title changed after it was listed');
    if (!existing)
      await this._claim(tab, sessionId, 'user');
    else {
      session.currentTabId = tabId;
      await this._persist();
    }
  }

  async removeTabs(tabIds: number | number[]): Promise<void> {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    const removed = ids.map(tabId => this._waitForRemoval(tabId));
    ids.forEach(tabId => this._closingTabs.add(tabId));
    try {
      await chrome.tabs.remove(tabIds);
      await Promise.all(removed);
    } catch (error) {
      ids.forEach(tabId => this._closingTabs.delete(tabId));
      throw error;
    } finally {
      ids.forEach(tabId => delete this._state.leases[String(tabId)]);
      await this._persist();
    }
  }

  async beforeDebuggerCommand(
    target: chrome.debugger.DebuggerSession,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    await this._ready;
    const tabId = target.tabId;
    const sessionId = tabId === undefined ?
      this._activeSessionId :
      (this._state.leases[String(tabId)]?.sessionId || this._activeSessionId);
    if (tabId === undefined || !sessionId)
      return;
    if (!method.startsWith('Input.') && method !== 'Page.navigate' && method !== 'Page.bringToFront')
      return;
    await this._ensureLease(tabId, sessionId);
    if (method === 'Page.bringToFront')
      return;
    await this._cursor(tabId, { action: 'thinking', visual: false });
    if (method === 'Page.navigate') {
      this._navigationIntents.set(tabId, {
        expectedUrl: typeof params?.url === 'string' ? params.url : undefined,
        expiresAt: Date.now() + 15_000,
      });
    }
    if (method.startsWith('Input.'))
      await this._prepareCursor(tabId, method, params);
  }

  async afterDebuggerCommand(
    target: chrome.debugger.DebuggerSession,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (target.tabId === undefined || method !== 'Input.dispatchMouseEvent')
      return;
    const type = String(params?.type || '');
    if (type === 'mouseReleased')
      await this._cursor(target.tabId, { action: 'release' });
  }

  async mark(
    sessionId: string,
    disposition: Exclude<TabDisposition, 'omit'>,
    requestedTabId?: number,
  ): Promise<void> {
    await this._ready;
    const tabId = requestedTabId ?? this._currentTab(sessionId);
    if (tabId === undefined)
      throw new Error('Browser session does not control a tab');
    if (this._state.leases[String(tabId)]?.sessionId !== sessionId)
      throw new Error('Tab is not leased by this browser session');
    this._state.leases[String(tabId)].disposition = disposition;
    await this._setFavicon(tabId, disposition);
    await this._persist();
    if (disposition === 'handoff')
      await this.visibility(sessionId, true);
  }

  async visibility(sessionId: string, visible: boolean): Promise<void> {
    await this._ready;
    if (!visible)
      return;
    const tabId = this._currentTab(sessionId);
    if (tabId === undefined)
      throw new Error('Browser session does not control a tab');
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined)
      await chrome.windows.update(tab.windowId, { focused: true });
  }

  async finalize(sessionId: string): Promise<void> {
    await this._ready;
    const entries = Object.entries(this._state.leases).filter(([, lease]) => lease.sessionId === sessionId);
    for (const [key, lease] of entries) {
      const tabId = Number(key);
      await this._finalizeLease(tabId, lease);
      delete this._state.leases[key];
    }
    delete this._state.sessions[sessionId];
    if (this._activeSessionId === sessionId)
      this._activeSessionId = '';
    await this._persist();
    if (!this.hasActiveSessions())
      await this._removeCursorScript();
  }

  async takeover(tabId: number, kind: string): Promise<void> {
    await this._ready;
    const lease = this._state.leases[String(tabId)];
    if (!lease)
      return;
    const session = this._state.sessions[lease.sessionId];
    if (!session || session.interrupted)
      return;
    session.interrupted = true;
    this._activeSessionId = '';
    this._sendEvent({ method: 'tyrs.takeover', params: [{
      sessionId: lease.sessionId,
      tabId,
      kind,
    }] });
    await this._release(tabId);
    delete this._state.leases[String(tabId)];
    await this._persist();
  }

  async stopAll(): Promise<void> {
    await this._ready;
    for (const [key, lease] of Object.entries(this._state.leases))
      await this._finalizeLease(Number(key), lease);
    this._state = { sessions: {}, leases: {} };
    this._activeSessionId = '';
    await this._persist();
    await this._removeCursorScript();
  }

  hasActiveSessions(): boolean {
    return Object.keys(this._state.sessions).length > 0;
  }

  private async _ensureLease(tabId: number, sessionId: string): Promise<void> {
    const current = this._state.leases[String(tabId)];
    if (current?.sessionId === sessionId) {
      this._state.sessions[sessionId].currentTabId = tabId;
      return;
    }
    if (current)
      throw new Error(`Tab is leased by session ${current.sessionId}`);
    const tab = await chrome.tabs.get(tabId);
    await this._claim(tab, sessionId, 'user');
  }

  private async _claim(tab: chrome.tabs.Tab, sessionId: string, origin: 'agent' | 'user'): Promise<void> {
    if (tab.id === undefined)
      throw new Error('Tab does not have an id');
    this._state.leases[String(tab.id)] = {
      sessionId,
      origin,
      disposition: 'omit',
      title: tab.title || '',
      url: tab.url || '',
      originalFavIconUrl: tab.favIconUrl,
    };
    this._state.sessions[sessionId].currentTabId = tab.id;
    await this._setFavicon(tab.id, 'omit');
    await this._persist();
  }

  private async _group(tabId: number, sessionId: string): Promise<void> {
    const session = this._state.sessions[sessionId];
    const groupId = await chrome.tabs.group({
      tabIds: tabId,
      ...(session.groupId === undefined ? {} : { groupId: session.groupId }),
    });
    session.groupId = groupId;
    await chrome.tabGroups.update(groupId, { title: session.name, color: 'blue', collapsed: false });
    await this._persist();
  }

  private _currentTab(sessionId: string): number | undefined {
    const current = this._state.sessions[sessionId]?.currentTabId;
    if (current !== undefined && this._state.leases[String(current)]?.sessionId === sessionId)
      return current;
    const entry = Object.entries(this._state.leases).find(([, lease]) => lease.sessionId === sessionId);
    return entry ? Number(entry[0]) : undefined;
  }

  private async _prepareCursor(tabId: number, method: string, params?: Record<string, unknown>): Promise<void> {
    const visible = await this._isWatched(tabId);
    if (method === 'Input.dispatchMouseEvent') {
      const type = String(params?.type || '');
      const x = Number(params?.x ?? 0);
      const y = Number(params?.y ?? 0);
      if (type === 'mouseMoved')
        await this._cursor(tabId, { action: 'move', x, y, visual: visible });
      else if (type === 'mousePressed') {
        await this._cursor(tabId, { action: 'move', x, y, visual: visible });
        await this._cursor(tabId, { action: 'press' });
        await this._cursor(tabId, { action: 'prepare', x, y });
      } else if (type === 'mouseWheel') {
        await this._cursor(tabId, { action: 'prepare' });
        await this._cursor(tabId, { action: 'wheel' });
      }
    } else if (method === 'Input.dispatchKeyEvent') {
      await this._cursor(tabId, { action: 'prepare', key: String(params?.key || '') });
    }
  }

  private async _cursor(tabId: number, message: Record<string, unknown>): Promise<void> {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'tyrs.cursor', ...message });
      return;
    } catch {
      // 导航会销毁 content script；仅在消息端点不存在时重新注入。
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/cursor.mjs'] });
      await chrome.tabs.sendMessage(tabId, { type: 'tyrs.cursor', ...message });
    } catch {
      // Chrome 内部页或尚未完成加载的页面不允许注入，CDP 动作仍可继续。
    }
  }

  private async _isWatched(tabId: number): Promise<boolean> {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active)
      return false;
    return (await chrome.windows.get(tab.windowId)).focused === true;
  }

  private async _setFavicon(tabId: number, disposition: TabDisposition): Promise<void> {
    const color = disposition === 'handoff' ? '#f59e0b' : '#16a34a';
    const svg = disposition === 'omit' ?
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
        `<circle cx="16" cy="16" r="15" fill="#2563eb"/>` +
        `<path d="M8 6l16 12-8 1-4 7z" fill="#111827" stroke="white" stroke-width="2" stroke-linejoin="round"/>` +
      `</svg>` :
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">` +
        `<circle cx="16" cy="16" r="13" fill="${color}" stroke="white" stroke-width="3"/>` +
      `</svg>`;
    const href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    await chrome.scripting.executeScript({
      target: { tabId },
      func: value => {
        document.getElementById('tyrs-browser-favicon')?.remove();
        const link = document.createElement('link');
        link.id = 'tyrs-browser-favicon';
        link.rel = 'icon';
        link.href = value;
        document.head?.appendChild(link);
      },
      args: [href],
    }).catch(() => undefined);
  }

  private async _release(tabId: number, keepFavicon = false): Promise<void> {
    await this._cursor(tabId, { action: 'hide' });
    if (!keepFavicon) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.getElementById('tyrs-browser-favicon')?.remove(),
      }).catch(() => undefined);
    }
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
  }

  private async _finalizeLease(tabId: number, lease: LeaseState): Promise<void> {
    if (lease.origin === 'agent' && lease.disposition === 'omit') {
      await this.removeTabs(tabId).catch(() => undefined);
      return;
    }
    const keepFavicon = lease.origin === 'agent' && lease.disposition !== 'omit';
    await this._release(tabId, keepFavicon);
  }

  private _waitForRemoval(tabId: number): Promise<void> {
    return new Promise(resolve => {
      const waiters = this._removalWaiters.get(tabId) ?? new Set();
      this._removalWaiters.set(tabId, waiters);
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        if (!waiters.size)
          this._removalWaiters.delete(tabId);
        resolve();
      };
      waiters.add(done);
      timer = setTimeout(done, 2_000);
    });
  }

  private async _ensureCursorScript(): Promise<void> {
    if (!chrome.scripting.registerContentScripts)
      return;
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [cursorScriptId] });
    if (registered.length)
      return;
    await chrome.scripting.registerContentScripts([{
      id: cursorScriptId,
      js: ['lib/cursor.mjs'],
      matches: ['http://*/*', 'https://*/*', 'file://*/*'],
      persistAcrossSessions: false,
      runAt: 'document_start',
      world: 'ISOLATED',
    }]);
  }

  private async _removeCursorScript(): Promise<void> {
    if (!chrome.scripting.unregisterContentScripts)
      return;
    await chrome.scripting.unregisterContentScripts({ ids: [cursorScriptId] }).catch(() => undefined);
  }

  private async _onTabUpdated(tabId: number): Promise<void> {
    const lease = this._state.leases[String(tabId)];
    if (!lease)
      return;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab) {
      lease.title = tab.title || '';
      lease.url = tab.url || '';
      lease.originalFavIconUrl = tab.favIconUrl;
    }
    await this._setFavicon(tabId, lease.disposition);
    await this._persist();
  }

  private async _onCommittedNavigation(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails):
      Promise<void> {
    if (details.frameId !== 0)
      return;
    const intent = this._navigationIntents.get(details.tabId);
    if (intent && Date.now() <= intent.expiresAt) {
      const expected = normalizeNavigationUrl(intent.expectedUrl);
      const committed = normalizeNavigationUrl(details.url);
      const internalBlank = intent.allowInternalBlank && /^(chrome:\/\/newtab\/?|about:blank)$/i.test(details.url);
      if ((expected && expected === committed) || internalBlank) {
        this._navigationIntents.delete(details.tabId);
        return;
      }
    }
    this._navigationIntents.delete(details.tabId);
    if (details.transitionType === 'typed' || details.transitionQualifiers.includes('from_address_bar'))
      await this.takeover(details.tabId, 'navigation');
  }

  private async _onTabRemoved(
    tabId: number,
    agentInitiated: boolean,
    removedLease: LeaseState | undefined,
  ): Promise<void> {
    if (agentInitiated || !removedLease)
      return;
    if (this._state.leases[String(tabId)] !== removedLease)
      return;
    await this.takeover(tabId, 'tab_closed');
  }

  private async _restore(): Promise<void> {
    const stored = await chrome.storage.session.get(storageKey);
    const value = stored[storageKey] as StoredState | undefined;
    if (value?.sessions && value?.leases)
      this._state = value;
  }

  private async _persist(): Promise<void> {
    await chrome.storage.session.set({ [storageKey]: this._state });
  }
}

function normalizeName(name: string): string {
  const value = name.trim().slice(0, 64);
  return value || '🌐 Browser task';
}

function normalizeNavigationUrl(value: string | undefined): string {
  if (!value)
    return '';
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return value;
  }
}

function isDebuggableURL(value: string | undefined): boolean {
  if (!value)
    return false;
  if (/^about:blank(?:[?#].*)?$/i.test(value))
    return true;
  return !/^(about|chrome|chrome-extension|devtools|edge):/i.test(value);
}
