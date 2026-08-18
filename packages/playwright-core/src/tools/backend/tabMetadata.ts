/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

export type TabMetadata = {
  id?: number;
  title: string;
  url: string;
  active: boolean;
  tyrs?: {
    sessionId?: string;
    sessionName?: string;
    origin?: 'agent' | 'user';
    disposition?: 'omit' | 'deliverable' | 'handoff';
  };
};

export interface TabMetadataProvider {
  sessionId?: string;
  listTabs(): Promise<TabMetadata[]>;
  invalidate(reason: string): void;
}

export class BrowserMetadataUnavailableError extends Error {
  readonly code = 'BROWSER_METADATA_UNAVAILABLE';
  readonly stage: string;
  readonly durationMs: number;

  constructor(stage: string, durationMs: number) {
    super(`BROWSER_METADATA_UNAVAILABLE stage=${stage} durationMs=${durationMs}`);
    this.name = 'BrowserMetadataUnavailableError';
    this.stage = stage;
    this.durationMs = durationMs;
  }
}

export async function readTabMetadata(provider: TabMetadataProvider, timeoutMs: number): Promise<TabMetadata[]> {
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      provider.listTabs(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserMetadataUnavailableError(
            'discoverTabs', Math.round(performance.now() - startedAt))), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof BrowserMetadataUnavailableError)
      throw error;
    throw new BrowserMetadataUnavailableError('discoverTabs', Math.round(performance.now() - startedAt));
  } finally {
    if (timer)
      clearTimeout(timer);
  }
}
