/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import { ProfileConnection, isDebuggable } from './profileConnection';
import { RelayConnection } from './relayConnection';

const reconnectDelayMs = 5_000;
const heartbeatIntervalMs = 30_000;

type ExtensionConfiguration = {
  relayUrl: string;
  statusUrl: string;
  extensionToken: string;
};

class TyrsBrowserExtension {
  private _profile?: ProfileConnection;
  private _socket?: WebSocket;
  private _heartbeat?: number;
  private _reconnect?: number;
  private _connectedAt?: string;

  constructor() {
    chrome.runtime.onInstalled.addListener(() => void this._connect());
    chrome.runtime.onStartup.addListener(() => void this._connect());
    chrome.storage.onChanged.addListener(() => this._restart());
    void this._connect();
  }

  private async _connect(): Promise<void> {
    this._clearTimers();
    const configuration = await loadConfiguration();
    if (!configuration) {
      await this._setBadge('!', '#B45309', 'Tyrs Browser Bridge is not configured');
      this._scheduleReconnect();
      return;
    }
    const relay = new URL(configuration.relayUrl);
    relay.searchParams.set('token', configuration.extensionToken);
    const socket = new WebSocket(relay);
    this._socket = socket;
    socket.onopen = () => void this._onOpen(socket, configuration);
    socket.onclose = () => this._onDisconnect(socket);
    socket.onerror = () => this._onDisconnect(socket);
  }

  private async _onOpen(socket: WebSocket, configuration: ExtensionConfiguration): Promise<void> {
    if (socket !== this._socket)
      return socket.close();
    this._connectedAt = new Date().toISOString();
    const relay = new RelayConnection(socket);
    const profile = new ProfileConnection(relay);
    profile.onclose = () => this._onDisconnect(socket);
    this._profile = profile;
    try {
      await profile.initialize();
      await this._setBadge('ON', '#15803D', 'Tyrs Browser Bridge connected');
      await this._sendStatus(configuration, true);
      this._heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ method: 'tyrs.heartbeat', params: [] }));
        void this._sendStatus(configuration, socket.readyState === WebSocket.OPEN);
      }, heartbeatIntervalMs);
    } catch {
      socket.close(1011, 'Failed to initialize Chrome profile');
    }
  }

  private _onDisconnect(socket: WebSocket): void {
    if (socket !== this._socket)
      return;
    this._clearTimers();
    this._profile?.close();
    this._profile = undefined;
    this._socket = undefined;
    this._connectedAt = undefined;
    void this._setBadge('OFF', '#B91C1C', 'Tyrs Browser Bridge disconnected');
    this._scheduleReconnect();
  }

  private _restart(): void {
    this._socket?.close(1000, 'Configuration changed');
    if (!this._socket)
      void this._connect();
  }

  private _scheduleReconnect(): void {
    if (this._reconnect === undefined)
      this._reconnect = setTimeout(() => void this._connect(), reconnectDelayMs);
  }

  private _clearTimers(): void {
    if (this._heartbeat !== undefined)
      clearInterval(this._heartbeat);
    if (this._reconnect !== undefined)
      clearTimeout(this._reconnect);
    this._heartbeat = undefined;
    this._reconnect = undefined;
  }

  private async _sendStatus(configuration: ExtensionConfiguration, connected: boolean): Promise<void> {
    const tabs = (await chrome.tabs.query({})).filter(isDebuggable);
    await fetch(configuration.statusUrl, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${configuration.extensionToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connected,
        profile: 'current',
        tabCount: tabs.length,
        extensionVersion: chrome.runtime.getManifest().version,
        chromeVersion: navigator.userAgent,
        connectedAt: this._connectedAt,
      }),
    }).catch(() => undefined);
  }

  private async _setBadge(text: string, color: string, title: string): Promise<void> {
    await Promise.all([
      chrome.action.setBadgeText({ text }),
      chrome.action.setBadgeBackgroundColor({ color }),
      chrome.action.setTitle({ title }),
    ]);
  }
}

async function loadConfiguration(): Promise<ExtensionConfiguration | undefined> {
  const [managed, local] = await Promise.all([
    chrome.storage.managed.get().catch(() => ({})),
    chrome.storage.local.get(),
  ]);
  const values = { ...local, ...managed } as Partial<ExtensionConfiguration>;
  if (!values.relayUrl || !values.statusUrl || !values.extensionToken)
    return undefined;
  const relay = new URL(values.relayUrl);
  const status = new URL(values.statusUrl);
  if (!isLoopback(relay.hostname) || !isLoopback(status.hostname))
    return undefined;
  if (relay.protocol !== 'ws:' && relay.protocol !== 'wss:')
    return undefined;
  if (status.protocol !== 'http:' && status.protocol !== 'https:')
    return undefined;
  return values as ExtensionConfiguration;
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

new TyrsBrowserExtension();
