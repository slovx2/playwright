export type ExtensionConfiguration = {
  proxyUrl: string;
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
    const bootstrap = new URL(bootstrapURL);
    const extensionId = globalThis.chrome?.runtime?.id;
    if (extensionId)
      bootstrap.searchParams.set('extensionId', extensionId);
    const response = await fetcher(bootstrap.href, { cache: 'no-store', credentials: 'omit' });
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
  if (!candidate.proxyUrl || !candidate.statusUrl || !candidate.extensionToken)
    return undefined;
  try {
    const proxy = new URL(candidate.proxyUrl);
    const status = new URL(candidate.statusUrl);
    if (!isLoopback(proxy.hostname) || !isLoopback(status.hostname))
      return undefined;
    if (proxy.protocol !== 'ws:' && proxy.protocol !== 'wss:')
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
