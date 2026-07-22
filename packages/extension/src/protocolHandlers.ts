/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

export type ProtocolCommand = {
  id: number;
  method: string;
  params?: unknown;
};

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
]);

export class ProtocolV2Handler {
  constructor(private readonly _context: RelayContext) {}

  async handleCommand(message: ProtocolCommand): Promise<unknown> {
    if (!allowedChromeCommands.has(message.method))
      throw new Error(`Unknown method: ${message.method}`);
    if (message.params !== undefined && !Array.isArray(message.params))
      throw new Error(`Invalid params for ${message.method}`);
    const args = (message.params ?? []) as unknown[];
    const result = await invokeChromeMethod(message.method, args);
    if (message.method === 'chrome.debugger.attach') {
      const target = args[0] as chrome.debugger.Debuggee | undefined;
      if (target?.tabId !== undefined)
        this._context.notifyTabAttached(target.tabId);
    }
    return result ?? {};
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
