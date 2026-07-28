/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import { ProfileConnection, isDebuggable } from './profileConnection';
import { RelayConnection } from './relayConnection';
import { ExtensionConfiguration, loadConfiguration } from './configuration';
import {
  authenticatedRelayURL,
  extensionCapabilityVersion,
  extensionProtocolVersion,
} from './connectionMetadata';

const reconnectDelayMs = 2_000;
const reconnectAlarmDelayMinutes = 0.5;
const reconnectAlarmName = 'tyrs-browser-reconnect-v2';
const connectTimeoutMs = 2_000;
const heartbeatIntervalMs = 20_000;
const heartbeatTimeoutMs = 45_000;
const pendingUpdateKey = 'tyrsPendingExtensionUpdate';

class TyrsBrowserExtension {
  private _profile?: ProfileConnection;
  private _socket?: WebSocket;
  private _heartbeat?: number;
  private _reconnect?: number;
  private _connectTimeout?: number;
  private _connectedAt?: string;
  private _configuration?: ExtensionConfiguration;
  private _connecting?: Promise<void>;
  private _lastHeartbeatAckAt = 0;
  private _fastRetryUsed = false;

  constructor() {
    chrome.runtime.onInstalled.addListener(() => void this._connect());
    chrome.runtime.onStartup.addListener(() => void this._connect());
    chrome.runtime.onUpdateAvailable.addListener(() => void this._onUpdateAvailable());
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === reconnectAlarmName) {
        this._fastRetryUsed = false;
        void this._connect();
      }
    });
    chrome.storage.onChanged.addListener((_changes, areaName) => {
      if (areaName !== 'session')
        this._restart();
    });
    void this._connect();
  }

  private _connect(): Promise<void> {
    if (this._socket)
      return Promise.resolve();
    if (!this._connecting)
      this._connecting = this._connectOnce().finally(() => this._connecting = undefined);
    return this._connecting;
  }

  private async _connectOnce(): Promise<void> {
    this._clearTimers();
    const configuration = await loadConfiguration();
    if (!configuration) {
      await this._setBadge('!', '#B45309', 'Tyrs Browser Bridge is not configured');
      this._scheduleReconnect();
      return;
    }
    this._configuration = configuration;
    const healthUrl = new URL('/health', configuration.statusUrl);
    try {
      await fetch(healthUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(connectTimeoutMs),
      });
    } catch {
      await this._setBadge('OFF', '#B91C1C', 'Tyrs Browser Agent unavailable');
      this._scheduleReconnect();
      return;
    }
    const relay = authenticatedRelayURL(
        configuration.relayUrl,
        configuration.extensionToken,
        chrome.runtime.getManifest().version);
    const socket = new WebSocket(relay);
    this._socket = socket;
    socket.onopen = () => void this._onOpen(socket, configuration);
    socket.onclose = () => this._onDisconnect(socket);
    socket.onerror = () => this._onDisconnect(socket);
    this._connectTimeout = setTimeout(() => {
      if (socket === this._socket && socket.readyState !== WebSocket.OPEN)
        socket.close();
    }, connectTimeoutMs);
  }

  private async _onOpen(socket: WebSocket, configuration: ExtensionConfiguration): Promise<void> {
    if (socket !== this._socket)
      return socket.close();
    if (this._connectTimeout !== undefined)
      clearTimeout(this._connectTimeout);
    this._connectTimeout = undefined;
    this._connectedAt = new Date().toISOString();
    this._fastRetryUsed = false;
    void chrome.alarms.clear(reconnectAlarmName);
    const relay = new RelayConnection(socket);
    this._lastHeartbeatAckAt = Date.now();
    relay.onheartbeatack = () => this._lastHeartbeatAckAt = Date.now();
    const profile = new ProfileConnection(relay);
    profile.onclose = () => this._onDisconnect(socket);
    this._profile = profile;
    try {
      await profile.initialize();
      await this._sendStatus(configuration, true);
      await this._setBadge('ON', '#15803D', 'Tyrs Browser Bridge connected');
      this._heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          if (Date.now() - this._lastHeartbeatAckAt > heartbeatTimeoutMs) {
            socket.close(4000, 'Browser Agent heartbeat timed out');
            return;
          }
          socket.send(JSON.stringify({
            method: 'tyrs.heartbeat',
            params: [{ at: Date.now() }],
          }));
        }
        void this._sendStatus(configuration, socket.readyState === WebSocket.OPEN);
        void this._applyPendingUpdate();
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
    this._lastHeartbeatAckAt = 0;
    if (this._configuration)
      void this._sendStatus(this._configuration, false);
    void this._setBadge('OFF', '#B91C1C', 'Tyrs Browser Bridge disconnected');
    void this._applyPendingUpdate();
    this._scheduleReconnect();
  }

  private _restart(): void {
    this._socket?.close(1000, 'Configuration changed');
    if (!this._socket)
      void this._connect();
  }

  private _scheduleReconnect(): void {
    if (this._reconnect === undefined && !this._fastRetryUsed) {
      this._fastRetryUsed = true;
      this._reconnect = setTimeout(() => void this._connect(), reconnectDelayMs);
    }
    chrome.alarms.create(reconnectAlarmName, { delayInMinutes: reconnectAlarmDelayMinutes });
  }

  private _clearTimers(): void {
    if (this._heartbeat !== undefined)
      clearInterval(this._heartbeat);
    if (this._reconnect !== undefined)
      clearTimeout(this._reconnect);
    if (this._connectTimeout !== undefined)
      clearTimeout(this._connectTimeout);
    this._heartbeat = undefined;
    this._reconnect = undefined;
    this._connectTimeout = undefined;
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
        extensionProtocol: extensionProtocolVersion,
        capabilityVersion: extensionCapabilityVersion,
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

  private async _onUpdateAvailable(): Promise<void> {
    await chrome.storage.session.set({ [pendingUpdateKey]: true });
    if (!this._profile?.hasActiveSessions())
      chrome.runtime.reload();
  }

  private async _applyPendingUpdate(): Promise<void> {
    if (this._profile?.hasActiveSessions())
      return;
    const stored = await chrome.storage.session.get(pendingUpdateKey);
    if (stored[pendingUpdateKey] === true)
      chrome.runtime.reload();
  }
}

new TyrsBrowserExtension();
