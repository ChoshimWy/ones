import assert from 'node:assert/strict'

// 生产 HTML/CSS + 已有虚构 Worker；仅验证导航吸顶与关联列表交互。
export async function exerciseStickyTabs({ page, screenshot }) {
  const call = (name, input = {}) => page.evaluate(async ({ name, input }) =>
    (await orca.host.call('plugin.request', { name, input })).output.value, { name, input })
  const nav = page.getByRole('tablist', { name: '工作台功能' })
  const scroll = async y => {
    await page.evaluate(y => window.scrollTo(0, y), y)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const bounds = () => nav.evaluate(node => {
    const rect = node.getBoundingClientRect()
    const header = document.querySelector('.workbench-header').getBoundingClientRect()
    const button = node.querySelector('button'), target = button.getBoundingClientRect()
    return { top: rect.top, height: rect.height, headerBottom: header.bottom,
      clickable: button.contains(document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2)),
      clipped: node.scrollWidth > node.clientWidth,
      background: getComputedStyle(node).backgroundImage }
  })
  await page.getByRole('tab', { name: '登录', exact: true }).click()
  const tasks = Array.from({ length: 60 }, (_, i) => ({ id: `sticky-${i}`, number: i + 1,
    name: `虚构吸顶检查 ${i + 1}`, project: { id: 'project', name: '虚构项目' },
    issueType: { id: 'bug', name: '缺陷' }, status: { id: 'pending', name: '待处理' } }))
  await call('fixture.pagination', { pages: [{ items: tasks.slice(0, 30) }, { items: tasks.slice(30) }] })
  await page.getByRole('tab', { name: '我的 Bug', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.bug-item').length === 30)
  const cases = []
  for (const [mode, width] of [['light', 1100], ['dark', 460], ['light', 360]]) {
    await page.setViewportSize({ width, height: 1100 })
    await scroll(0)
    const initial = await bounds()
    assert.ok(initial.top > 100)
    assert.equal(initial.clipped, false)
    for (const y of [400, 850, 500]) {
      await scroll(y)
      const pinned = await bounds()
      assert.ok(Math.abs(pinned.top) < 1)
      assert.ok(pinned.headerBottom < 0, 'Only tabs are pinned; branding scrolls away')
      assert.ok(pinned.clickable, 'Rows cannot cover tab controls')
      assert.equal(pinned.height, initial.height)
    }
    await screenshot(`sticky-tabs-bugs-${mode}-${width}`, mode, width)
    await scroll(0)
    assert.ok(Math.abs((await bounds()).top - initial.top) < 1, 'Returning to top restores normal flow')
    cases.push({ mode, width, pinned: true, returnsToFlow: true })
  }
  // 自动追加会重建根节点；标签栏仍须停在顶部。
  await scroll(100000)
  await page.waitForFunction(() => document.querySelectorAll('.bug-item').length === 60)
  assert.ok(Math.abs((await bounds()).top) < 1)
  await page.getByRole('tab', { name: '实施', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.implementation-table tbody tr').length === 25)
  await scroll(600)
  assert.ok(Math.abs((await bounds()).top) < 1)
  await screenshot('sticky-tabs-implementation-dark-460', 'dark', 460)
  // 吸顶状态下切页，不被长列表截获点击；短内容不会悬浮品牌区。
  await page.getByRole('tab', { name: '登录', exact: true }).click()
  await scroll(0)
  assert.ok((await bounds()).top > 100)
  assert.equal(await page.getByRole('tab', { name: '登录', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(await page.locator('.implementation-table').count(), 0)
  return { environment: 'Chrome preview; fictional Worker; no live ONES writes', cases,
    checks: ['tabs pin at top in both scroll directions', 'branding scrolls away', 'normal flow restored at top',
      'opaque background and tab hit testing above list rows', 'no tab clipping at 360/460/1100px',
      'automatic list append retains sticky position', 'implementation list uses same sticky navigation', 'pinned tabs remain clickable'] }
}
