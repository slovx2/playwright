/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import { EventEmitter } from 'events';

import type net from 'net';

export const browserAgentProtocolVersion = 2;
export const browserAgentCapabilityVersion = 2;
export const browserAgentPreface = `TYRS-BROWSER/${browserAgentProtocolVersion}\n`;
export const browserAgentMaxFrameSize = 64 * 1024 * 1024;
export const browserAgentMaxFileSize = 25 * 1024 * 1024;
export const browserAgentMaxChunkSize = 1024 * 1024;

export type BrowserAgentMessage = {
  type: string;
  [key: string]: any;
};

export class FramedConnection extends EventEmitter {
  private _buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private _closed = false;

  constructor(private readonly _socket: net.Socket) {
    super();
    _socket.on('data', data => this._onData(data));
    _socket.on('close', () => this._close());
    _socket.on('error', error => this._close(error));
  }

  socket(): net.Socket {
    return this._socket;
  }

  send(message: BrowserAgentMessage): Promise<void> {
    if (this._closed)
      return Promise.reject(new Error('Browser Agent connection is closed'));
    const payload = Buffer.from(JSON.stringify(message));
    if (payload.length > browserAgentMaxFrameSize)
      return Promise.reject(new Error('Browser Agent frame is too large'));
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length);
    return new Promise((resolve, reject) => {
      this._socket.write(Buffer.concat([header, payload]), error => error ? reject(error) : resolve());
    });
  }

  close(): void {
    this._socket.destroy();
  }

  private _onData(data: Buffer): void {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, data]) : data;
    while (this._buffer.length >= 4) {
      const length = this._buffer.readUInt32BE(0);
      if (length > browserAgentMaxFrameSize) {
        this._close(new Error('Browser Agent frame is too large'));
        return;
      }
      if (this._buffer.length < 4 + length)
        return;
      const payload = this._buffer.subarray(4, 4 + length);
      this._buffer = this._buffer.subarray(4 + length);
      try {
        const message = JSON.parse(payload.toString()) as BrowserAgentMessage;
        if (!message || typeof message.type !== 'string')
          throw new Error('Browser Agent message has no type');
        this.emit('message', message);
      } catch (error) {
        this._close(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private _close(error?: Error): void {
    if (this._closed)
      return;
    this._closed = true;
    if (error)
      this.emit('connectionerror', error);
    this.emit('close');
  }
}

export function encodeBrowserAgentFrame(message: BrowserAgentMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length > browserAgentMaxFrameSize)
    throw new Error('Browser Agent frame is too large');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}
