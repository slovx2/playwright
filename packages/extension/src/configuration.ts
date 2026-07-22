export type ExtensionConfiguration = {
  relayUrl: string;
  statusUrl: string;
  extensionToken: string;
};

type StorageReader = () => Promise<Record<string, unknown>>;
type ConfigurationFetcher = (input: string, init?: RequestInit) => Promise<Response>;

const bootstrapURL = 'http://127.0.0.1:8931/extension/config';

export async function loadConfiguration(
  managedReader: StorageReader = () => chrome.storage.managed.get(),
  localReader: StorageReader = () => chrome.storage.local.get(),
  fetcher: ConfigurationFetcher = fetch,
): Promise<ExtensionConfiguration | undefined> {
  const [managed, local] = await Promise.all([
    managedReader().catch(() => ({})),
    localReader().catch(() => ({})),
  ]);
  const stored = validateConfiguration({ ...local, ...managed });
  if (stored)
    return stored;
  try {
    const response = await fetcher(bootstrapURL, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok)
      return undefined;
    return validateConfiguration(await response.json());
  } catch {
    return undefined;
  }
}

export function validateConfiguration(values: unknown): ExtensionConfiguration | undefined {
  if (!values || typeof values !== 'object')
    return undefined;
  const candidate = values as Partial<ExtensionConfiguration>;
  if (!candidate.relayUrl || !candidate.statusUrl || !candidate.extensionToken)
    return undefined;
  try {
    const relay = new URL(candidate.relayUrl);
    const status = new URL(candidate.statusUrl);
    if (!isLoopback(relay.hostname) || !isLoopback(status.hostname))
      return undefined;
    if (relay.protocol !== 'ws:' && relay.protocol !== 'wss:')
      return undefined;
    if (status.protocol !== 'http:' && status.protocol !== 'https:')
      return undefined;
  } catch {
    return undefined;
  }
  return candidate as ExtensionConfiguration;
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}
