import { test, expect } from './fixtures';
import { Context } from '../../packages/playwright-core/src/tools/backend/context';

test('concurrent worker sessions finalize only their own tabs', async ({ cdpServer }, testInfo) => {
  const browserContext = await cdpServer.start();
  const userPage = browserContext.pages()[0];
  const createContext = () => new Context(browserContext as any, {
    config: { isolatedTabs: true, defaultTabOrigin: 'agent' },
    cwd: testInfo.outputPath(),
  });
  const first = createContext();
  const second = createContext();
  try {
    // 两个会话同时创建相同 URL 的页面，不能通过时间窗口或 URL 猜测归属。
    const [a, b] = await Promise.all([first.newTab(), second.newTab()]);
    await Promise.all([a.page.goto('data:text/html,shared'), b.page.goto('data:text/html,shared')]);
    await Promise.all([first.refreshTabs(), second.refreshTabs()]);
    expect(first.tabs().map(tab => tab.id)).toEqual([a.id]);
    expect(second.tabs().map(tab => tab.id)).toEqual([b.id]);
    await first.finalizeTabs();
    await first.dispose();
    expect(a.page.isClosed()).toBe(true);
    expect(b.page.isClosed()).toBe(false);
    expect(userPage.isClosed()).toBe(false);
    await second.refreshTabs();
    expect(second.currentTabOrDie().id).toBe(b.id);
    expect(await b.page.locator('body').innerText()).toBe('shared');
    await second.finalizeTabs();
    expect(b.page.isClosed()).toBe(true);
    expect(userPage.isClosed()).toBe(false);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
  }
});
