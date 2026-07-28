/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

export type ProtocolCommand = {
  id: number;
  method: string;
  params?: unknown;
};

import { SessionController } from './sessionController';
import { isDebuggableURL } from './tabUrl';

export interface RelayContext {
  readonly attachedTabs: ReadonlySet<number>;
  sendMessage(message: unknown): void;
  notifyTabAttached(tabId: number): void;
  notifyTabDetached(tabId: number): void;
}

const allowedChromeCommands = new Set([
  'chrome.debugger.attach',
  'chrome.debugger.detach',
  'chrome.debugger.sendCommand',
  'chrome.tabs.create',
  'chrome.tabs.remove',
  'chrome.downloads.search',
  'tyrs.tabs.discover',
  'tyrs.tab.claim',
  'tyrs.session.open',
  'tyrs.session.activate',
  'tyrs.session.idle',
  'tyrs.session.name',
  'tyrs.session.finalize',
  'tyrs.sessions.reset',
  'tyrs.tab.disposition',
  'tyrs.visibility',
]);

export class ProtocolV2Handler {
  private readonly _sessions: SessionController;
  private readonly _debuggerQueues = new Map<number, Promise<void>>();

  constructor(private readonly _context: RelayContext) {
    this._sessions = new SessionController(message => this._context.sendMessage(message));
  }

  async handleCommand(message: ProtocolCommand): Promise<unknown> {
    if (!allowedChromeCommands.has(message.method))
      throw new Error(`Unknown method: ${message.method}`);
    if (message.params !== undefined && !Array.isArray(message.params))
      throw new Error(`Invalid params for ${message.method}`);
    const args = (message.params ?? []) as unknown[];
    const target = args[0] as chrome.debugger.DebuggerSession | undefined;
    const result = message.method === 'chrome.debugger.sendCommand' && target?.tabId !== undefined ?
      await this._enqueueDebuggerCommand(target.tabId, () => this._invoke(message.method, args)) :
      await this._invoke(message.method, args);
    if (message.method === 'chrome.debugger.attach') {
      const target = args[0] as chrome.debugger.Debuggee | undefined;
      if (target?.tabId !== undefined)
        this._context.notifyTabAttached(target.tabId);
    } else if (message.method === 'chrome.debugger.detach') {
      const target = args[0] as chrome.debugger.Debuggee | undefined;
      if (target?.tabId !== undefined)
        this._context.notifyTabDetached(target.tabId);
    }
    return result ?? {};
  }

  async dispose(): Promise<void> {
    await this._sessions.stopAll();
  }

  hasActiveSessions(): boolean {
    return this._sessions.hasActiveSessions();
  }

  forwardChromeEvent(fullMethod: string, args: unknown[]): void {
    this._context.sendMessage({ method: fullMethod, params: args });
  }

  onUserAttachRequest(tab: chrome.tabs.Tab): void {
    this._context.sendMessage({ method: 'chrome.tabs.onCreated', params: [tab] });
  }

  onUserDetachRequest(tabId: number): void {
    this._context.sendMessage({
      method: 'chrome.debugger.onDetach',
      params: [{ tabId }, 'target_closed'],
    });
  }

  didInitialize(): void {
    this._context.sendMessage({ method: 'extension.initialized', params: [] });
  }

  private async _invoke(method: string, args: unknown[]): Promise<unknown> {
    const value = (args[0] ?? {}) as Record<string, any>;
    if (method === 'chrome.tabs.create')
      return await this._sessions.createTab(value);
    if (method === 'tyrs.tabs.discover') {
      return (await chrome.tabs.query({})).filter(isDiscoverableTab).map(tab => ({
        ...tab,
        tyrs: this._sessions.describeTab(tab.id!),
      }));
    }
    if (method === 'tyrs.tab.claim') {
      return await this._sessions.claimExisting(
          String(value.sessionId || ''),
          Number(value.tabId),
          String(value.title || ''),
          String(value.url || ''));
    }
    if (method === 'chrome.tabs.remove') {
      await this._sessions.removeTabs(args[0] as number | number[]);
      return;
    }
    if (method === 'chrome.debugger.sendCommand') {
      const target = args[0] as chrome.debugger.DebuggerSession;
      const cdpMethod = String(args[1] || '');
      const params = args[2] as Record<string, unknown> | undefined;
      await this._sessions.beforeDebuggerCommand(target, cdpMethod, params);
      const result = await invokeChromeMethod(method, args);
      await this._sessions.afterDebuggerCommand(target, cdpMethod, params);
      return result;
    }
    if (method === 'tyrs.session.open')
      return await this._sessions.open(
          String(value.sessionId || ''),
          String(value.name || ''),
          String(value.bootstrapUrl || ''));
    if (method === 'tyrs.session.activate')
      return await this._sessions.activate(String(value.sessionId || ''));
    if (method === 'tyrs.session.idle')
      return await this._sessions.idle(String(value.sessionId || ''));
    if (method === 'tyrs.session.name')
      return await this._sessions.name(String(value.sessionId || ''), String(value.name || ''));
    if (method === 'tyrs.session.finalize')
      return await this._sessions.finalize(String(value.sessionId || ''));
    if (method === 'tyrs.sessions.reset')
      return await this._sessions.stopAll();
    if (method === 'tyrs.tab.disposition')
      return await this._sessions.mark(
          String(value.sessionId || ''),
          value.disposition,
          value.tabId === undefined ? undefined : Number(value.tabId));
    if (method === 'tyrs.visibility')
      return await this._sessions.visibility(String(value.sessionId || ''), value.visible === true);
    return await invokeChromeMethod(method, args);
  }

  private async _enqueueDebuggerCommand(tabId: number, callback: () => Promise<unknown>): Promise<unknown> {
    const previous = this._debuggerQueues.get(tabId) ?? Promise.resolve();
    let release: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const tail = previous.then(() => gate);
    this._debuggerQueues.set(tabId, tail);
    await previous;
    try {
      return await callback();
    } finally {
      release!();
      if (this._debuggerQueues.get(tabId) === tail)
        this._debuggerQueues.delete(tabId);
    }
  }
}

function isDiscoverableTab(tab: chrome.tabs.Tab): boolean {
  if (tab.id === undefined || !tab.url)
    return false;
  return isDebuggableURL(tab.url);
}

export function resolveChromeMember(fullMethod: string): { obj: any, name: string } {
  const parts = fullMethod.split('.');
  if (parts[0] !== 'chrome' || parts.length < 3)
    throw new Error(`Invalid chrome method: ${fullMethod}`);
  let obj: any = chrome;
  for (let index = 1; index < parts.length - 1; index++) {
    obj = obj?.[parts[index]];
    if (obj === undefined)
      throw new Error(`Unknown chrome path: ${parts.slice(0, index + 1).join('.')}`);
  }
  return { obj, name: parts[parts.length - 1] };
}

async function invokeChromeMethod(fullMethod: string, args: unknown[]): Promise<unknown> {
  const { obj, name } = resolveChromeMember(fullMethod);
  const method = obj[name] as ((...values: unknown[]) => unknown) | undefined;
  if (typeof method !== 'function')
    throw new Error(`Not a function: ${fullMethod}`);
  return await method.apply(obj, args);
}
