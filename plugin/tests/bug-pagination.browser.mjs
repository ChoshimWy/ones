import assert from 'node:assert/strict'

/// 为分页旅程提供可控制的虚构游标、故障和延迟；不访问真实账号。
export function installBugPaginationFixture(handlers) {
  let pages = [], reads = [], held = [], followHeld = [], followProject = null, holdFollow = false
  const ok = value => ({ ok: true, value })
  handlers.set('fixture.pagination', input => {
    pages = input.pages
    reads = []
    followProject = null
    return ok(true)
  })
  handlers.set('fixture.paginationStats', () => ok({ reads, held: held.length, followHeld: followHeld.length }))
  handlers.set('fixture.paginationRelease', () => { held.splice(0).forEach(resolve => resolve()); return ok(true) })
  handlers.set('fixture.paginationFollow', input => { followProject = input.project; holdFollow = input.hold === true; return ok(true) })
  handlers.set('fixture.paginationFollowRelease', () => { followHeld.splice(0).forEach(resolve => resolve()); return ok(true) })
  handlers.set('bugs.projectFilter', async () => {
    const value = { localProject: followProject, project: followProject }
    if (holdFollow) {
      holdFollow = false
      await new Promise(resolve => followHeld.push(resolve))
    }
    return ok(value)
  })
  handlers.set('bugs.list', async input => {
    const index = input.after ? Number(input.after.slice(1)) : 0
    reads.push(index)
    const page = pages[index]
    assert.ok(page, `Unexpected remote page ${index}`)
    if (page.hold) {
      page.hold = false
      await new Promise(resolve => held.push(resolve))
    }
    if (page.fail) {
      page.fail = false
      return { ok: false, error: { code: 'fixture', message: '虚构分页读取失败' } }
    }
    return ok({ items: page.items, nextCursor: 'next' in page ? page.next : index + 1 < pages.length ? `p${index + 1}` : null })
  })
  const originalStatus = handlers.get('status')
  let account = ''
  handlers.set('fixture.paginationAccount', input => { account = input.label; return ok(true) })
  handlers.set('status', async (...args) => {
    const response = await originalStatus(...args)
    return { ...response, value: { ...response.value, ones: { ...response.value.ones, label: account || response.value.ones.label } } }
  })
  pages = chunks(tasks(25), 7)
}

/// 使用稳定 ID 构造匹配及非匹配任务，以验证过滤先于切页。
function tasks(count, start = 1, project = 'project', status = '待处理') {
  return Array.from({ length: count }, (_, offset) => ({
    id: `pagination-${start + offset}`, number: start + offset, name: `虚构分页缺陷 ${start + offset}`,
    project: { id: project, name: project === 'project' ? '分页验证项目' : '另一项目' },
    issueType: { id: 'bug', name: '缺陷' }, status: { id: status, name: status }
  }))
}

/// 切分远端批次，验证自动填充视口。
function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => ({ items: items.slice(index * size, (index + 1) * size) }))
}

/// 定向连续加载：缓存追加、稀疏筛选、重试、详情返回及旧响应隔离。
export async function exerciseBugPagination({ page, screenshot }) {
  const call = (name, input = {}) => page.evaluate(async ({ name, input }) => (await orca.host.call('plugin.request', { name, input })).output.value, { name, input })
  const rows = page.locator('button.bug-item')
  const settled = () => page.waitForFunction(() => document.querySelector('.bug-workspace')?.getAttribute('aria-busy') === 'false')
  const at = async count => { await page.waitForFunction(count => document.querySelectorAll('button.bug-item').length === count, count); await settled() }
  const config = async pages => {
    await page.getByRole('tab', { name: '登录', exact: true }).click()
    await call('fixture.pagination', { pages })
    await page.getByRole('tab', { name: '我的 Bug', exact: true }).click()
    await settled()
  }
  const bottom = () => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await config([{ items: tasks(25) }, { items: tasks(25, 26) }, { items: tasks(3, 51) }])
  await at(25)
  assert.equal(await page.getByRole('tab', { name: '记录核对', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: /上一页|下一页/ }).count(), 0)
  assert.deepEqual((await call('fixture.paginationStats')).reads, [0])
  await bottom(); await at(50)
  assert.match(await rows.first().innerText(), /缺陷 1$/)
  assert.match(await rows.last().innerText(), /缺陷 50$/)
  await bottom(); await at(53)
  assert.equal(await page.getByText('已全部加载', { exact: true }).count(), 1)
  await screenshot('bugs-continuous-light', 'light', 1100)
  await screenshot('bugs-continuous-dark', 'dark', 460)
  await page.evaluate(() => window.scrollTo(0, 900))
  await rows.nth(12).click()
  await page.getByRole('button', { name: '返回我的 Bug', exact: true }).click()
  await at(53)
  assert.ok(await page.evaluate(() => window.scrollY > 0))
  assert.deepEqual((await call('fixture.paginationStats')).reads, [0, 1, 2])

  await config([{ items: tasks(25) }, { items: tasks(3, 26), fail: true }])
  await bottom(); await page.getByRole('button', { name: '重试读取', exact: true }).waitFor()
  await at(25)
  const reads = (await call('fixture.paginationStats')).reads
  await bottom(); await page.waitForTimeout(150)
  assert.deepEqual((await call('fixture.paginationStats')).reads, reads)
  await screenshot('bugs-continuous-retry', 'light', 360)
  assert.ok(await page.locator('nav').evaluate(node => node.scrollWidth <= node.clientWidth), 'Four tabs fit at 360px')
  await page.getByRole('button', { name: '重试读取', exact: true }).click(); await at(28)

  // 不匹配及空批次不能把列表误判为结束。
  await config([{ items: tasks(12, 1, 'project', '已关闭') }, { items: [] }, { items: tasks(25, 13) }])
  await at(25)
  assert.deepEqual((await call('fixture.paginationStats')).reads, [0, 1, 2])
  await page.getByRole('button', { name: '展开状态选项', exact: true }).click()
  await page.getByLabel('全部状态', { exact: true }).check(); await at(37)
  await page.getByRole('button', { name: '清空状态', exact: true }).click(); await at(0)
  await page.getByRole('button', { name: '恢复默认状态', exact: true }).click(); await at(25)
  await page.getByRole('button', { name: '收起状态选项', exact: true }).click()

  for (const invalid of [{ items: tasks(2) }, { items: tasks(2, 26), next: 'p1' }]) {
    await config([{ items: tasks(25) }, invalid]); await bottom(); await at(25)
    await page.getByText(/缺陷分页重复或未推进/).waitFor()
    assert.equal(await page.getByText('已全部加载', { exact: true }).count(), 0)
  }
  await config([{ items: tasks(25) }, { items: tasks(2, 26), hold: true }]); await bottom()
  await page.waitForFunction(async () => (await orca.host.call('plugin.request', { name: 'fixture.paginationStats' })).output.value.held === 1)
  assert.equal(await page.locator('.refresh-bugs').getAttribute('aria-busy'), 'true')
  await page.getByRole('tab', { name: '登录', exact: true }).click()
  await call('fixture.paginationRelease')
  await call('fixture.paginationAccount', { label: '新的虚构账号' })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByText('新的虚构账号', { exact: true }).waitFor()
  await call('fixture.pagination', { pages: [{ items: tasks(2, 201) }] })
  await page.getByRole('tab', { name: '我的 Bug', exact: true }).click(); await at(2)
  assert.match(await rows.first().innerText(), /201/)
  assert.equal(await page.getByText('记录核对', { exact: true }).count(), 0)
  return { checks: ['25 → 50 → 53 rows, no UI pagination or total cap', 'scroll appends without duplicate reads', 'detail return preserves cache and scroll', 'failure preserves rows and requires explicit retry', 'empty and unmatched batches continue; filters apply to all cached rows', 'duplicate/cyclic pages remain incomplete', 'navigation/account changes reject late replies', 'record reconciliation tab removed'], environment: 'Chrome preview + fictional Worker; no live ONES writes' }
}
