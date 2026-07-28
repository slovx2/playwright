/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

export const extensionProtocolVersion = 2;
export const extensionCapabilityVersion = 1;

export function authenticatedRelayURL(
  relayURL: string,
  extensionToken: string,
  extensionVersion: string,
): URL {
  const relay = new URL(relayURL);
  relay.searchParams.set('token', extensionToken);
  relay.searchParams.set('extensionVersion', extensionVersion);
  relay.searchParams.set('extensionProtocol', String(extensionProtocolVersion));
  relay.searchParams.set('capabilityVersion', String(extensionCapabilityVersion));
  return relay;
}
