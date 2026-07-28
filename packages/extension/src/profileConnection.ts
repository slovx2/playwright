/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import { RelayConnection } from './relayConnection';

const blockedSchemes = ['chrome:', 'chrome-extension:', 'devtools:', 'edge:', 'about:'];

export function isDebuggable(tab: chrome.tabs.Tab): boolean {
  if (tab.id === undefined || !tab.url)
    return false;
  return !blockedSchemes.some(scheme => tab.url!.startsWith(scheme));
}

export class ProfileConnection {
  private _closed = false;
  private readonly _onCreated = (tab: chrome.tabs.Tab) => this._attach(tab);
  private readonly _onUpdated = (_tabId: number, change: { url?: string, status?: string }, tab: chrome.tabs.Tab) => {
    if (change.url !== undefined || change.status === 'complete')
      this._reconcile(tab);
  };
  private readonly _onRemoved = (tabId: number) => this._connection.detachTab(tabId);

  onclose?: () => void;

  constructor(private readonly _connection: RelayConnection) {
    _connection.onclose = () => this.close();
    chrome.tabs.onCreated.addListener(this._onCreated);
    chrome.tabs.onUpdated.addListener(this._onUpdated);
    chrome.tabs.onRemoved.addListener(this._onRemoved);
  }

  async initialize(): Promise<void> {
    this._connection.didInitialize();
  }

  hasActiveSessions(): boolean {
    return this._connection.hasActiveSessions();
  }

  close(reason?: string): void {
    if (this._closed)
      return;
    this._closed = true;
    chrome.tabs.onCreated.removeListener(this._onCreated);
    chrome.tabs.onUpdated.removeListener(this._onUpdated);
    chrome.tabs.onRemoved.removeListener(this._onRemoved);
    if (reason)
      this._connection.close(reason);
    this.onclose?.();
  }

  private _attach(tab: chrome.tabs.Tab): void {
    if (isDebuggable(tab) && tab.openerTabId !== undefined &&
        this._connection.attachedTabs.has(tab.openerTabId))
      this._connection.attachTab(tab);
  }

  private _reconcile(tab: chrome.tabs.Tab): void {
    if (tab.id === undefined)
      return;
    if (!this._connection.attachedTabs.has(tab.id))
      return;
    if (isDebuggable(tab))
      this._connection.attachTab(tab);
    else
      this._connection.detachTab(tab.id);
  }
}
