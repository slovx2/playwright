/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import { ProtocolCommand, ProtocolV2Handler, RelayContext, resolveChromeMember } from './protocolHandlers';

const chromeEventMethods = [
  'chrome.debugger.onEvent',
  'chrome.debugger.onDetach',
  'chrome.tabs.onCreated',
  'chrome.tabs.onRemoved',
];

type ProtocolResponse = {
  id?: number;
  result?: unknown;
  error?: string | { code: number, message: string };
};

export class RelayConnection {
  private readonly _handler: ProtocolV2Handler;
  private readonly _attached = new Set<number>();
  private readonly _eventListeners: Array<() => void> = [];
  private _closed = false;

  onclose?: () => void;
  ontabattached?: (tabId: number) => void;
  ontabdetached?: (tabId: number) => void;

  constructor(private readonly _socket: WebSocket) {
    const context: RelayContext = {
      attachedTabs: this._attached,
      sendMessage: message => this._send(message),
      notifyTabAttached: tabId => this._notifyAttached(tabId),
      notifyTabDetached: tabId => this._notifyDetached(tabId),
    };
    this._handler = new ProtocolV2Handler(context);
    this._installEventForwarders();
    _socket.onmessage = event => void this._onMessage(event);
    _socket.onclose = () => this._handleClose();
    _socket.onerror = () => this._handleClose();
  }

  get attachedTabs(): ReadonlySet<number> {
    return this._attached;
  }

  attachTab(tab: chrome.tabs.Tab): void {
    if (!this._closed && tab.id !== undefined && !this._attached.has(tab.id))
      this._handler.onUserAttachRequest(tab);
  }

  detachTab(tabId: number): void {
    if (this._closed || !this._attached.has(tabId))
      return;
    void chrome.debugger.detach({ tabId }).catch(() => undefined);
    this._notifyDetached(tabId);
    this._handler.onUserDetachRequest(tabId);
  }

  didInitialize(): void {
    this._handler.didInitialize();
  }

  close(reason: string): void {
    if (this._socket.readyState === WebSocket.OPEN)
      this._socket.close(1000, reason);
    this._handleClose();
  }

  private _notifyAttached(tabId: number): void {
    this._attached.add(tabId);
    this.ontabattached?.(tabId);
  }

  private _notifyDetached(tabId: number): void {
    this._attached.delete(tabId);
    this.ontabdetached?.(tabId);
  }

  private _installEventForwarders(): void {
    for (const fullMethod of chromeEventMethods) {
      const target = resolveChromeMember(fullMethod);
      const listener = (...args: unknown[]) => this._onChromeEvent(fullMethod, args);
      target.obj[target.name].addListener(listener);
      this._eventListeners.push(() => target.obj[target.name].removeListener(listener));
    }
  }

  private _onChromeEvent(fullMethod: string, args: unknown[]): void {
    const tabId = tabIDForEvent(fullMethod, args);
    if (tabId === undefined || !this._attached.has(tabId))
      return;
    this._handler.forwardChromeEvent(fullMethod, args);
    if (fullMethod === 'chrome.debugger.onDetach')
      this._notifyDetached(tabId);
  }

  private async _onMessage(event: MessageEvent): Promise<void> {
    let command: ProtocolCommand;
    try {
      command = JSON.parse(String(event.data)) as ProtocolCommand;
    } catch (error) {
      this._send({ error: { code: -32700, message: String(error) } });
      return;
    }
    const response: ProtocolResponse = { id: command.id };
    try {
      response.result = await this._handler.handleCommand(command);
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
    }
    this._send(response);
  }

  private _send(message: unknown): void {
    if (this._socket.readyState === WebSocket.OPEN)
      this._socket.send(JSON.stringify(message));
  }

  private _handleClose(): void {
    if (this._closed)
      return;
    this._closed = true;
    this._eventListeners.splice(0).forEach(remove => remove());
    for (const tabId of [...this._attached]) {
      void chrome.debugger.detach({ tabId }).catch(() => undefined);
      this._notifyDetached(tabId);
    }
    this.onclose?.();
  }
}

function tabIDForEvent(fullMethod: string, args: unknown[]): number | undefined {
  if (fullMethod === 'chrome.debugger.onEvent' || fullMethod === 'chrome.debugger.onDetach')
    return (args[0] as chrome.debugger.Debuggee | undefined)?.tabId;
  if (fullMethod === 'chrome.tabs.onCreated')
    return (args[0] as chrome.tabs.Tab | undefined)?.openerTabId;
  if (fullMethod === 'chrome.tabs.onRemoved')
    return args[0] as number;
  return undefined;
}
