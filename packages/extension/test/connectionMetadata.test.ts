/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authenticatedRelayURL,
  extensionCapabilityVersion,
  extensionProtocolVersion,
} from '../src/connectionMetadata';

test('relay URL carries the complete extension handshake before connecting', () => {
  const relay = authenticatedRelayURL(
      'ws://127.0.0.1:8932/extension?existing=value',
      'secret-token',
      '0.3.1');

  assert.equal(relay.searchParams.get('existing'), 'value');
  assert.equal(relay.searchParams.get('token'), 'secret-token');
  assert.equal(relay.searchParams.get('extensionVersion'), '0.3.1');
  assert.equal(relay.searchParams.get('extensionProtocol'), String(extensionProtocolVersion));
  assert.equal(relay.searchParams.get('capabilityVersion'), String(extensionCapabilityVersion));
});
