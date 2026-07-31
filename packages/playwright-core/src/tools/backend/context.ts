/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import debug from 'debug';
import { escapeWithQuotes } from '@isomorphic/stringUtils';
import { disposeAll } from '@isomorphic/disposable';
import { eventsHelper } from '@utils/eventsHelper';
import { isPathInside, isSystemDirectory, isWritable } from '@utils/fileUtils';
import { playwright } from '../../inprocess';

import { Tab } from './tab';

import type * as playwrightTypes from '../../..';
import type { TabHeader } from './tab';
import type { SessionLog } from './sessionLog';
import type { Disposable } from '@isomorphic/disposable';
import type { ToolCapability } from './tool';

const testDebug = debug('pw:mcp:test');

export type ContextConfig = {
  allowUnrestrictedFileAccess?: boolean;
  capabilities?: ToolCapability[];
  codegen?: 'typescript' | 'none';
  console?: { level?: 'error' | 'warning' | 'info' | 'debug' };
  imageResponses?: 'allow' | 'omit';
  network?: {
    allowedOrigins?: string[];
    blockedOrigins?: string[];
  };
  outputDir?: string;
  outputMaxSize?: number;
  outputMode?: 'file' | 'stdout';
  saveSession?: boolean;
  secrets?: Record<string, string>;
  snapshot?: {
    mode?: 'full' | 'none';
  };
  testIdAttribute?: string;
  timeouts?: {
    action?: number;
    navigation?: number;
    expect?: number;
  };
  browser?: {
    initScript?: string[];
    initPage?: string[];
  };
  skillMode?: boolean;
  isolatedTabs?: boolean;
  protectSensitiveData?: boolean;
  defaultTabOrigin?: TabOrigin;
};

type ContextOptions = {
  config: ContextConfig;
  sessionLog?: SessionLog;
  cwd: string;
};

export type RouteEntry = {
  pattern: string;
  status?: number;
  body?: string;
  contentType?: string;
  addHeaders?: Record<string, string>;
  removeHeaders?: string[];
  handler: (route: playwrightTypes.Route) => Promise<void>;
};

export type FilenameTemplate = {
  prefix: string;
  ext: string;
  suggestedFilename?: string;
  date?: Date;
};

type VideoParams = { size?: { width: number; height: number } };
export type TabOrigin = 'agent' | 'user';
export type TabDisposition = 'omit' | 'deliverable' | 'handoff';
export type ManagedTabState = { origin: TabOrigin, disposition: TabDisposition };
type TabClaim = {
  page: playwrightTypes.Page;
  title: string;
  url: string;
  expiresAt: number;
};

export class Context {
  readonly config: ContextConfig;
  readonly sessionLog: SessionLog | undefined;
  readonly options: ContextOptions;
  private _rawBrowserContext: playwrightTypes.BrowserContext;
  private _browserContextPromise: Promise<playwrightTypes.BrowserContext> | undefined;
  private _tabs: Tab[] = [];
  private _currentTab: Tab | undefined;
  private _tabStates = new Map<Tab, ManagedTabState>();
  private _pageIds = new WeakMap<playwrightTypes.Page, string>();
  private _tabClaims = new Map<string, TabClaim>();
  private _creatingPage = false;
  private _sessionName = '🌐 Browser task';
  private _routes: RouteEntry[] = [];
  private _video: {
    params: VideoParams;
    fileNames: string[];
    fileName: string;
  } | undefined;
  private _disposables: Disposable[] = [];

  private _runningToolName: string | undefined;
  private _pendingUnhandledRejections: unknown[] = [];
  private _unhandledRejectionListeners = new Set<(reason: unknown) => void>();
  private _onUnhandledRejection = (reason: unknown) => {
    this._pendingUnhandledRejections.push(reason);
    for (const listener of this._unhandledRejectionListeners)
      listener(reason);
  };

  constructor(browserContext: playwrightTypes.BrowserContext, options: ContextOptions) {
    this.config = options.config;
    this.sessionLog = options.sessionLog;
    this.options = options;
    this._rawBrowserContext = browserContext;
    testDebug('create context');
    process.on('unhandledRejection', this._onUnhandledRejection);
  }

  async dispose() {
    process.off('unhandledRejection', this._onUnhandledRejection);
    await disposeAll(this._disposables);
    for (const tab of this._tabs)
      await tab.dispose();
    this._tabs.length = 0;
    this._currentTab = undefined;
    await this.stopVideoRecording();
  }

  drainPendingUnhandledRejections(): unknown[] {
    const reasons = this._pendingUnhandledRejections.slice();
    this._pendingUnhandledRejections.length = 0;
    return reasons;
  }

  onUnhandledRejection(listener: (reason: unknown) => void): () => void {
    this._unhandledRejectionListeners.add(listener);
    return () => this._unhandledRejectionListeners.delete(listener);
  }

  debugger() {
    return this._rawBrowserContext.debugger;
  }

  tabs(): Tab[] {
    return this._tabs;
  }

  currentTab(): Tab | undefined {
    return this._currentTab;
  }

  currentTabOrDie(): Tab {
    if (!this._currentTab)
      throw new Error('No open pages available.');
    return this._currentTab;
  }

  async newTab(): Promise<Tab> {
    const browserContext = await this.ensureBrowserContext();
    this._creatingPage = true;
    let page: playwrightTypes.Page;
    try {
      page = await browserContext.newPage();
    } finally {
      this._creatingPage = false;
    }
    if (!this._tabs.some(tab => tab.page === page))
      this._onPageCreated(page);
    this._currentTab = this._tabs.find(t => t.page === page)!;
    this._tabStates.set(this._currentTab, { origin: 'agent', disposition: 'omit' });
    return this._currentTab;
  }

  async selectTab(id: string) {
    const tab = this.tabById(id);
    this._currentTab = tab;
    return tab;
  }

  async showTab(id?: string): Promise<Tab> {
    const tab = id ? this.tabById(id) : this.currentTabOrDie();
    await tab.page.bringToFront();
    this._currentTab = tab;
    return tab;
  }

  tabById(id: string): Tab {
    const tab = this._tabs.find(candidate => candidate.id === id);
    if (!tab)
      throw new Error(`Tab ${id} not found`);
    return tab;
  }

  tabState(tab: Tab): ManagedTabState {
    return this._tabStates.get(tab) ?? { origin: 'user', disposition: 'omit' };
  }

  async claimTab(claimToken: string): Promise<Tab> {
    const claim = this._tabClaims.get(claimToken);
    this._tabClaims.delete(claimToken);
    if (!claim || claim.expiresAt < Date.now())
      throw new Error('Claim token is invalid or expired; list tabs again');
    if (this._tabs.some(existing => existing.page === claim.page) || claim.page.isClosed())
      throw new Error('Claimed tab is no longer available; list tabs again');
    if (claim.page.url() !== claim.url || await claim.page.title() !== claim.title)
      throw new Error('Claimed tab changed after it was listed; list tabs again');
    this._onPageCreated(claim.page, { origin: 'user', disposition: 'omit' });
    const tab = this._tabs.find(candidate => candidate.page === claim.page)!;
    this._tabStates.set(tab, { origin: 'user', disposition: 'omit' });
    this._currentTab = tab;
    return tab;
  }

  async availableTabs(): Promise<Array<Omit<TabHeader, 'id'> & { claimToken: string }>> {
    this._tabClaims.clear();
    if (!this.config.isolatedTabs)
      return [];
    const pages = this._rawBrowserContext.pages().filter(page =>
      !this._tabs.some(tab => tab.page === page) && !isInternalPage(page.url()));
    return await Promise.all(pages.map(async page => {
      const claimToken = crypto.randomUUID();
      const title = await page.title().catch(() => '');
      const url = page.url();
      this._tabClaims.set(claimToken, { page, title, url, expiresAt: Date.now() + 30_000 });
      return {
        claimToken,
        title,
        url,
        current: false,
        crashed: false,
        console: { total: 0, warnings: 0, errors: 0 },
      };
    }));
  }

  markTab(id: string | undefined, disposition: Exclude<TabDisposition, 'omit'>): Tab {
    const tab = id ? this.tabById(id) : this.currentTabOrDie();
    const state = this.tabState(tab);
    if (state.origin !== 'agent')
      throw new Error('User-origin tabs cannot be marked deliverable or handoff');
    this._tabStates.set(tab, { ...state, disposition });
    return tab;
  }

  async finalizeTabs(): Promise<void> {
    const toClose = this._tabs.filter(tab => {
      const state = this.tabState(tab);
      return state.origin === 'agent' && state.disposition === 'omit';
    });
    for (const tab of toClose)
      await tab.page.close().catch(() => {});
  }

  setSessionName(name: string): void {
    this._sessionName = name;
  }

  sessionName(): string {
    return this._sessionName;
  }

  async ensureTab(): Promise<Tab> {
    await this.ensureBrowserContext();
    const crashed = this._currentTab?.crashed;
    if (crashed) {
      await this._currentTab!.page.close().catch(() => {});
      this._currentTab = undefined;
    }
    if (!this._currentTab)
      await this.newTab();
    if (crashed)
      this._currentTab!.logErrorMessage('Page crashed and was reset to about:blank.');
    await this._currentTab!.waitForInitialized();
    return this._currentTab!;
  }

  async closeTab(id: string): Promise<string> {
    const tab = this.tabById(id);
    if (this.tabState(tab).origin !== 'agent')
      throw new Error('User-origin tabs cannot be closed by the agent');
    const url = tab.page.url();
    await tab.page.close();
    return url;
  }

  async workspaceFile(fileName: string, perCallWorkspaceDir: string | undefined): Promise<string> {
    return await workspaceFile(this.options, fileName, perCallWorkspaceDir);
  }

  async outputFile(template: FilenameTemplate, options: { origin: 'code' | 'llm' }): Promise<string> {
    const baseName = template.suggestedFilename || `${template.prefix}-${(template.date ?? new Date()).toISOString().replace(/[:.]/g, '-')}${template.ext ? '.' + template.ext : ''}`;
    return await outputFile(this.options, baseName, options);
  }

  async startVideoRecording(fileName: string, params: VideoParams) {
    if (this._video)
      throw new Error('Video recording has already been started.');
    this._video = { params, fileName, fileNames: [] };
    const browserContext = await this.ensureBrowserContext();
    for (const page of browserContext.pages())
      await this._startPageVideo(page);
  }

  async stopVideoRecording(): Promise<string[]> {
    if (!this._video)
      return [];
    const video = this._video;
    for (const page of this._rawBrowserContext.pages())
      await page.screencast.stop();
    this._video = undefined;
    return [...video.fileNames];
  }

  private async _startPageVideo(page: playwrightTypes.Page) {
    if (!this._video)
      return;
    const suffix = this._video.fileNames.length ? `-${this._video.fileNames.length}` : '';
    let fileName = this._video.fileName;
    if (fileName && suffix) {
      const dir = path.dirname(fileName);
      const ext = path.extname(fileName);
      fileName = path.join(dir, path.basename(fileName, ext) + suffix + ext);
    }
    this._video.fileNames.push(fileName);
    await page.screencast.start({ path: fileName, ...this._video.params });
  }

  private _onPageCreated(page: playwrightTypes.Page, state?: ManagedTabState) {
    if (this._tabs.some(tab => tab.page === page))
      return;
    const tab = new Tab(this, page, tab => this._onPageClosed(tab), this._pageId(page));
    this._tabs.push(tab);
    this._tabStates.set(tab, state ?? {
      origin: this.config.defaultTabOrigin ?? 'user',
      disposition: 'omit',
    });
    if (!this._currentTab)
      this._currentTab = tab;
    this._startPageVideo(page).catch(() => {});
  }

  private async _considerPageCreated(page: playwrightTypes.Page): Promise<void> {
    if (this._creatingPage) {
      this._onPageCreated(page);
      return;
    }
    const opener = await page.opener().catch(() => null);
    if (opener && this._tabs.some(tab => tab.page === opener)) {
      this._onPageCreated(page, { origin: 'agent', disposition: 'omit' });
      return;
    }
    if (!this.config.isolatedTabs)
      this._onPageCreated(page);
  }

  private _pageId(page: playwrightTypes.Page): string {
    let id: string | undefined = this._pageIds.get(page);
    if (!id) {
      id = crypto.randomUUID();
      this._pageIds.set(page, id);
    }
    return id;
  }

  private _onPageClosed(tab: Tab) {
    const index = this._tabs.indexOf(tab);
    if (index === -1)
      return;
    this._tabs.splice(index, 1);
    this._tabStates.delete(tab);

    if (this._currentTab === tab)
      this._currentTab = this._tabs[Math.min(index, this._tabs.length - 1)];
  }

  routes(): RouteEntry[] {
    return this._routes;
  }

  async addRoute(entry: RouteEntry): Promise<void> {
    const browserContext = await this.ensureBrowserContext();
    await browserContext.route(entry.pattern, entry.handler);
    this._routes.push(entry);
  }

  async removeRoute(pattern?: string): Promise<number> {
    let removed = 0;
    const browserContext = await this.ensureBrowserContext();
    if (pattern) {
      const toRemove = this._routes.filter(r => r.pattern === pattern);
      for (const route of toRemove)
        await browserContext.unroute(route.pattern, route.handler);
      this._routes = this._routes.filter(r => r.pattern !== pattern);
      removed = toRemove.length;
    } else {
      for (const route of this._routes)
        await browserContext.unroute(route.pattern, route.handler);
      removed = this._routes.length;
      this._routes = [];
    }
    return removed;
  }

  isRunningTool() {
    return this._runningToolName !== undefined;
  }

  setRunningTool(name: string | undefined) {
    this._runningToolName = name;
  }

  private async _setupRequestInterception(context: playwrightTypes.BrowserContext) {
    if (this.config.network?.allowedOrigins?.length) {
      this._disposables.push(await context.route('**', route => route.abort('blockedbyclient')));

      for (const origin of this.config.network.allowedOrigins) {
        const glob = originOrHostGlob(origin);
        this._disposables.push(await context.route(glob, route => route.continue()));
      }
    }

    if (this.config.network?.blockedOrigins?.length) {
      for (const origin of this.config.network.blockedOrigins)
        this._disposables.push(await context.route(originOrHostGlob(origin), route => route.abort('blockedbyclient')));
    }
  }

  async ensureBrowserContext(): Promise<playwrightTypes.BrowserContext> {
    if (this._browserContextPromise)
      return this._browserContextPromise;
    this._browserContextPromise = this._initializeBrowserContext();
    return this._browserContextPromise;
  }

  async refreshTabs(): Promise<void> {
    const browserContext = await this.ensureBrowserContext();
    await Promise.all(browserContext.pages().map(page => this._considerPageCreated(page)));
  }

  private async _initializeBrowserContext() {
    if (this.config.testIdAttribute)
      playwright.selectors.setTestIdAttribute(this.config.testIdAttribute);
    const browserContext = this._rawBrowserContext;
    await this._setupRequestInterception(browserContext);

    for (const initScript of this.config.browser?.initScript || [])
      this._disposables.push(await browserContext.addInitScript({ path: path.resolve(this.options.cwd, initScript) }));

    if (!this.config.isolatedTabs) {
      for (const page of browserContext.pages())
        this._onPageCreated(page);
    }
    this._disposables.push(eventsHelper.addEventListener(browserContext, 'page',
        page => void this._considerPageCreated(page)));

    return browserContext;
  }

  checkUrlAllowed(url: string) {
    if (this.config.allowUnrestrictedFileAccess)
      return;
    if (!URL.canParse(url))
      return;
    if (new URL(url).protocol === 'file:')
      throw new Error(`Access to "file:" protocol is blocked. Attempted URL: "${url}"`);
  }

  lookupSecret(secretName: string): { value: string, code: string } {
    if (!this.config.secrets?.[secretName])
      return { value: secretName, code: escapeWithQuotes(secretName, '\'') };
    return {
      value: this.config.secrets[secretName]!,
      code: `process.env['${secretName}']`,
    };
  }

  redactSecrets(text: string): string {
    for (const [secretName, secretValue] of Object.entries(this.config.secrets ?? {})) {
      if (!secretValue)
        continue;
      text = text.replaceAll(secretValue, `<secret>${secretName}</secret>`);
    }
    return this.config.protectSensitiveData ? redactSensitiveData(text) : text;
  }
}

const sensitiveKey = '(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|secret|token|password|passwd|session[-_]?(?:id|key|token))';

export function redactSensitiveData(text: string): string {
  text = text.replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1<redacted>@');
  text = text.replace(new RegExp(`^([ \\t]*${sensitiveKey}[ \\t]*:)[^\\r\\n]*$`, 'gim'), '$1 <redacted>');
  text = text.replace(new RegExp(`(["']${sensitiveKey}["']\\s*:\\s*)(["'][^"']*["']|[^,}\\r\\n]+)`, 'gim'), '$1"<redacted>"');
  text = text.replace(new RegExp(`(^|[?&;\\s])(${sensitiveKey})=([^&#;\\s]*)`, 'gim'), '$1$2=<redacted>');
  text = text.replace(/<input\b[^>]*>/gi, input => {
    if (!/\btype\s*=\s*(["']?)password\1/i.test(input))
      return input;
    if (/\bvalue\s*=/i.test(input))
      return input.replace(/\bvalue\s*=\s*(?:["'][^"']*["']|[^\s>]+)/i, 'value="<redacted>"');
    return input;
  });
  return text;
}

function originOrHostGlob(originOrHost: string) {
  // Support wildcard port patterns like "http://localhost:*" or "https://example.com:*"
  const wildcardPortMatch = originOrHost.match(/^(https?:\/\/[^/:]+):\*$/);
  if (wildcardPortMatch)
    return `${wildcardPortMatch[1]}:*/**`;

  try {
    const url = new URL(originOrHost);
    // localhost:1234 will parse as protocol 'localhost:' and 'null' origin.
    if (url.origin !== 'null')
      return `${url.origin}/**`;
  } catch {
  }
  // Support for legacy host-only mode.
  return `*://${originOrHost}/**`;
}

function isInternalPage(url: string): boolean {
  return /^(chrome|chrome-extension|devtools|edge):/i.test(url);
}

export async function workspaceFile(options: ContextOptions, fileName: string, perCallWorkspaceDir?: string): Promise<string> {
  const workspace = perCallWorkspaceDir ?? options.cwd;
  const resolvedName = path.resolve(workspace, fileName);
  await checkFile(options, resolvedName, { origin: 'llm' });
  return resolvedName;
}

export function outputDir(options: ContextOptions): string {
  if (options.config.outputDir)
    return path.resolve(options.config.outputDir);
  const baseName = options.config.skillMode ? '.playwright-cli' : '.playwright-mcp';
  if (isSystemDirectory(options.cwd) || !isWritable(options.cwd))
    return path.join(os.tmpdir(), baseName);
  return path.join(options.cwd, baseName);
}

export async function outputFile(options: ContextOptions, fileName: string, flags: { origin: 'code' | 'llm' }): Promise<string> {
  const resolvedFile = path.resolve(outputDir(options), fileName);
  await checkFile(options, resolvedFile, flags);
  await fs.promises.mkdir(path.dirname(resolvedFile), { recursive: true });
  debug('pw:mcp:file')(resolvedFile);
  return resolvedFile;
}

async function checkFile(options: ContextOptions, resolvedFilename: string, flags: { origin: 'code' | 'llm' }) {
  // Trust code and unrestricted file access.
  if (flags.origin === 'code' || options.config.allowUnrestrictedFileAccess || options.config.skillMode)
    return;

  // Trust llm to use valid characters in file names.
  const output = outputDir(options);
  const workspace = options.cwd;
  if (!isPathInside(output, resolvedFilename) && !isPathInside(workspace, resolvedFilename))
    throw new Error(`File access denied: ${resolvedFilename} is outside allowed roots. Allowed roots: ${output}, ${workspace}`);
}
