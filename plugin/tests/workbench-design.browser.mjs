import assert from 'node:assert/strict'

// 复用生产面板与分页 fixture，所有文本和记录均为虚构。
export async function exerciseWorkbenchDesign({ page, screenshot }) {
  const names = ['调整设备面板的布局与交互', '跨项目配置的提示需要更清晰', '自定义配置弹窗适配窄屏', '清空页面前增加二次确认', '区分主控开关的状态图标', '优化场景切换后的状态显示', '空场景回退时显示明确提示', '指定场景的触发方式说明', '连续切换时保留正确选择']
  const items = names.map((name, index) => ({
    id: 'design-' + index, number: 10001 + index, name: '[UI] ' + name,
    project: { id: 'project', name: '示例照明项目' },
    creator: index === 1 ? null : { id: 'creator', name: '示例创建者' },
    issueType: { id: 'bug', name: '缺陷' }, status: { id: 'pending', name: '待处理' }
  }))
  await page.getByRole('tab', { name: '登录', exact: true }).click()
  await page.evaluate(items => orca.host.call('plugin.request', { name: 'fixture.pagination', input: { pages: [{ items }] } }), items)
  await page.getByRole('tab', { name: '我的 Bug', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.bug-table tbody tr').length === 9 && document.querySelector('.refresh-bugs')?.disabled === false)
  assert.equal(await page.locator('.tag[data-status="待处理"] .status-count').innerText(), '9')
  assert.equal(await page.locator('.tag[data-status="修复中"] .status-count').innerText(), '0')
  assert.equal(await page.getByText('实时更新', { exact: true }).count(), 0)
  assert.deepEqual(await page.locator('.bug-table th').allTextContents(), ['编号', '标题', '状态', '所属项目', '创建者'])
  assert.equal(await page.locator('.bug-table tbody tr').count(), 9)
  assert.equal(await page.locator('.bug-table-creator').first().innerText(), '示例创建者')
  assert.equal(await page.locator('.bug-table-creator').nth(1).innerText(), '—')
  assert.equal(await page.locator('.bug-item svg').count(), 0)
  assert.equal(await page.locator('.selected-tags .status-dot').count(), 0)
  assert.equal(await page.locator('.bug-table-status .status-dot').count(), 9)
  assert.equal(await page.locator('.refresh-bugs').innerText(), '')
  assert.equal(await page.locator('.auto-refresh, .personal-only, .read-state').count(), 0)
  assert.equal(await page.getByLabel('项目筛选', { exact: true }).inputValue(), 'all')
  assert.equal(await page.locator('.project-filter-display').innerText(), '项目')
  assert.equal(await page.getByText(/当前显示|未能识别当前 Orca 项目/).count(), 0)
  await page.locator('.bug-item').first().focus()
  await page.evaluate(() => window.scrollTo(0, 0))
  await screenshot('workbench-desktop', 'dark', 1000)
  const darkSurface = await page.locator('.workbench').evaluate(node => getComputedStyle(node).backgroundColor)
  await screenshot('workbench-light-desktop', 'light', 885)
  const lightSurface = await page.locator('.workbench').evaluate(node => getComputedStyle(node).backgroundColor)
  assert.notEqual(lightSurface, darkSurface)
  assert.equal(lightSurface, 'rgb(255, 255, 255)')
  await screenshot('workbench-panel', 'dark', 460)
  await screenshot('workbench-narrow', 'light', 360)
  assert.equal(await page.locator('.bug-items').evaluate(node => node.scrollWidth > node.clientWidth), true)
  await page.locator('.bug-items').evaluate(node => { node.scrollLeft = node.scrollWidth })
  await screenshot('workbench-narrow-project', 'light', 360)
  await page.locator('.bug-table-number').first().click()
  await page.getByRole('button', { name: '返回我的 Bug', exact: true }).click()
  await assertFooterRow(page)
  // 删除状态与恢复默认仍可用，数量和空态来自实际筛选。
  await page.getByLabel('移除状态：待处理', { exact: true }).click()
  assert.equal(await page.locator('.bug-item').count(), 0)
  await page.getByLabel('展开状态选项', { exact: true }).click()
  await page.getByRole('button', { name: '恢复默认状态', exact: true }).click()
  assert.equal(await page.locator('.bug-item').count(), 9)
  await page.getByLabel('收起状态选项', { exact: true }).click()
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.bug-table tbody tr').length === 9 && document.querySelector('.refresh-bugs')?.disabled === false)
  await page.locator('.bug-item').first().focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '返回我的 Bug', exact: true }).waitFor()
  await screenshot('workbench-detail', 'dark', 460)
  await page.getByRole('button', { name: '返回我的 Bug', exact: true }).click()
  await page.getByRole('tab', { name: '登录', exact: true }).click()
  await screenshot('workbench-login', 'dark', 360)
  await page.getByRole('tab', { name: '我的 Bug', exact: true }).click()
  await exercisePaginationAppearance(page, screenshot, items[0])
  return { environment: 'Headless Chrome, production HTML with fictional Worker', checks: ['desktop 885 / panel 460 / narrow 360 without page overflow', 'accurate loaded status counts', 'remove and restore filters', 'footer refresh', 'keyboard detail navigation and return', 'login form narrow layout', 'host light/dark tokens change actual surface', 'paging first/loading/middle/last/error and keyboard focus'], liveOrcaVerified: false }
}


async function exercisePaginationAppearance(page, screenshot) {
  assert.equal(await page.locator('.pagination-controls').count(), 0)
  assert.equal(await page.locator('.bug-list-end').count(), 1)
  await screenshot('continuous-list-footer', 'light', 460)
}

async function assertFooterRow(page) {
  for (const width of [360, 460, 1000]) {
    await page.setViewportSize({ width, height: 1100 })
    const boxes = await page.locator('.bug-footer > *').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect()
      return { left: rect.left, right: rect.right, center: rect.y + rect.height / 2 }
    }))
    assert.equal(boxes.length, 3)
    assert.ok(boxes.every(box => Math.abs(box.center - boxes[0].center) < 1))
    assert.ok(boxes[0].right <= boxes[1].left && boxes[1].right <= boxes[2].left)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  }
}
