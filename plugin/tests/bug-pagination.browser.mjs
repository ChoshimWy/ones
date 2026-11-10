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

/// 切分远端页，故意与每页十条的 UI 边界不同。
function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => ({ items: items.slice(index * size, (index + 1) * size) }))
}

/// 定向验收分页、筛选、详情返回与旧响应隔离；返回可存档的行为证据。
export async function exerciseBugPagination({ page, screenshot }) {
  const call = (name, input = {}) => page.evaluate(async ({ name, input }) => (await orca.host.call('plugin.request', { name, input })).output.value, { name, input })
  const stats = () => call('fixture.paginationStats')
  const button = name => page.getByRole('button', { name, exact: true })
  const rows = page.locator('button.bug-item')
  const settled = () => page.waitForFunction(() => !document.body.innerText.includes('正在刷新缺陷'))
  const at = async (number, count) => {
    await settled()
    await page.getByText(`第 ${number} 页`, { exact: true }).waitFor()
    assert.equal(await rows.count(), count)
  }
  const config = async pages => {
    await call('fixture.pagination', { pages })
    await button('刷新缺陷').click()
    await settled()
  }
  const pending = key => page.waitForFunction(async key => (await orca.host.call('plugin.request', { name: 'fixture.paginationStats' })).output.value[key] === 1, key)
  const focus = () => page.evaluate(() => globalThis.fixtureWorkspaceChanged({ context: { displayName: String(Math.random()), branch: '', terminals: [] } }))
  const chooseProject = value => page.getByLabel('项目筛选', { exact: true }).selectOption(value)
  const openStatuses = async () => {
    const toggle = page.getByLabel('展开状态选项', { exact: true })
    if (await toggle.count()) await toggle.click()
    await page.getByLabel('全部状态', { exact: true }).waitFor()
  }
  const defaultStatuses = async () => { await openStatuses(); await button('恢复默认状态').click(); await settled() }

  await at(1, 10)
  assert.deepEqual((await stats()).reads, [0, 1])
  assert.equal(await button('上一页').isDisabled(), true)
  assert.equal(await page.getByText('加载更多缺陷（列表尚未完整）', { exact: true }).count(), 0)
  assert.equal((await page.locator('body').innerText()).includes('Bug 创建、修改、状态流转尚未开放'), false)
  await button('下一页').click(); await at(2, 10)
  assert.match(await rows.first().innerText(), /#11 /)
  assert.deepEqual((await stats()).reads, [0, 1, 2])
  await button('上一页').click(); await at(1, 10)
  await button('下一页').click(); await at(2, 10)
  assert.deepEqual((await stats()).reads, [0, 1, 2])
  await rows.first().click()
  await button('返回我的 Bug').click(); await at(2, 10)
  assert.deepEqual((await stats()).reads, [0, 1, 2])
  await screenshot('bug-pagination-page2-360', 'light', 360)
  await screenshot('bug-pagination-page2-460', 'dark', 460)
  await button('下一页').click(); await at(3, 5)
  assert.equal(await button('下一页').isDisabled(), true)

  // 稀疏筛选跨越空远端页；当前页满十条后不继续预读。
  await config([{ items: [...tasks(4), ...tasks(4, 101, 'other', '已关闭')] }, { items: [] }, { items: tasks(8, 5) }, { items: tasks(5, 13) }])
  await at(1, 10)
  assert.deepEqual((await stats()).reads, [0, 1, 2])
  await button('下一页').click(); await at(2, 7)
  await chooseProject('other'); await at(1, 0)
  await openStatuses(); await page.getByLabel('全部状态', { exact: true }).check(); await at(1, 4)
  await chooseProject('all'); await at(1, 10)
  await button('下一页').click(); await at(2, 10)
  await page.getByLabel('移除状态：全部状态', { exact: true }).click(); await at(1, 0)
  const beforeEmpty = (await stats()).reads.length
  assert.equal(await button('下一页').isDisabled(), true)
  assert.equal((await stats()).reads.length, beforeEmpty)
  await defaultStatuses(); await at(1, 10)
  await button('下一页').click(); await at(2, 7)
  await page.getByLabel('移除状态：待处理', { exact: true }).click(); await at(1, 0)
  await page.getByLabel('状态：待处理', { exact: true }).check(); await at(1, 10)
  await button('下一页').click(); await at(2, 7)
  await button('清空状态').click(); await at(1, 0)
  await defaultStatuses()

  // 没有真实下一页时不能跳到空页，也不能把非匹配记录显示出来。
  await config([{ items: tasks(10) }, { items: tasks(8, 11, 'project', '已关闭') }])
  await button('下一页').click(); await at(1, 10)
  assert.equal(await button('下一页').isDisabled(), true)

  // 已填入部分目标页后失败，仍显示原页；重试复用缓存续读。
  await config([{ items: tasks(10) }, { items: tasks(3, 11) }, { items: tasks(7, 14), fail: true }])
  await button('下一页').click(); await at(1, 10)
  await page.getByText('虚构分页读取失败 本次结果不完整。', { exact: true }).waitFor()
  await screenshot('bug-pagination-retry-360', 'light', 360)
  await button('重试读取').click(); await at(2, 10)
  assert.deepEqual((await stats()).reads, [0, 1, 2, 2])

  // 循环游标与重复 ID 都必须停止，保留已有页并要求刷新。
  for (const bad of [{ items: tasks(5, 11), next: 'p1' }, { items: tasks(2, 10) }]) {
    await config([{ items: tasks(10) }, bad])
    await button('下一页').click(); await at(1, 10)
    assert.equal(await button('下一页').isDisabled(), true)
    assert.ok((await page.locator('body').innerText()).includes('分页重复或未推进'))
    assert.deepEqual((await stats()).reads, [0, 1])
  }

  // 筛选切换后旧响应（即使桥接忽略 abort）不能覆盖当前页。
  await config([{ items: tasks(10) }, { items: tasks(10, 11), hold: true }])
  await button('下一页').click(); await pending('held')
  await openStatuses(); await button('清空状态').click(); await at(1, 0)
  await call('fixture.paginationRelease'); await at(1, 0)
  await defaultStatuses(); await at(1, 10)
  assert.deepEqual((await stats()).reads, [0, 1])
  await button('下一页').click(); await at(2, 10)
  assert.deepEqual((await stats()).reads, [0, 1, 1])

  // 项目跟随改变筛选要回第一页；迟到的项目匹配不得覆盖手选。
  await config([{ items: [...tasks(20), ...tasks(12, 101, 'other')] }])
  await button('下一页').click(); await at(2, 10)
  await call('fixture.paginationFollow', { project: { id: 'other', name: '另一项目' } }); await focus(); await at(1, 10)
  assert.equal(await page.getByLabel('项目筛选', { exact: true }).inputValue(), 'other')
  await button('下一页').click(); await at(2, 2)
  assert.ok((await rows.allTextContents()).every(text => text.includes('另一项目')))
  await call('fixture.paginationFollow', { project: { id: 'project', name: '分页验证项目' }, hold: true }); await focus(); await pending('followHeld')
  await chooseProject('all'); await at(1, 10)
  await call('fixture.paginationFollowRelease'); await at(1, 10)
  assert.equal(await page.getByLabel('项目筛选', { exact: true }).inputValue(), 'all')

  // 状态改变不能丢失进行中的项目跟随；匹配到新项目后补足新筛选页。
  await call('fixture.paginationFollow', { project: { id: 'project', name: '分页验证项目' }, hold: true })
  await focus(); await pending('followHeld')
  await openStatuses(); await button('清空状态').click(); await at(1, 0)
  await call('fixture.paginationFollowRelease'); await at(1, 0)
  assert.equal(await page.getByLabel('项目筛选', { exact: true }).inputValue(), 'project')
  await defaultStatuses(); await at(1, 10)
  assert.ok((await rows.allTextContents()).every(text => text.includes('分页验证项目')))
  await chooseProject('all'); await at(1, 10)

  // 导航、账号更换都拒绝迟到的旧分页数据。
  await config([{ items: tasks(10) }, { items: tasks(10, 11), hold: true }])
  await button('下一页').click(); await pending('held')
  await rows.first().click()
  await call('fixture.paginationRelease')
  await button('返回我的 Bug').click(); await at(1, 10)
  assert.deepEqual((await stats()).reads, [0, 1])
  await button('下一页').click(); await at(2, 10)
  assert.deepEqual((await stats()).reads, [0, 1, 1])
  await config([{ items: tasks(10) }, { items: tasks(10, 11), hold: true }])
  await button('下一页').click(); await pending('held')
  await page.getByRole('tab', { name: '登录', exact: true }).click()
  await call('fixture.paginationAccount', { label: '另一个虚构账号' })
  await button('刷新连接状态').click()
  await page.getByText('另一个虚构账号', { exact: true }).waitFor()
  await call('fixture.paginationRelease')
  await call('fixture.pagination', { pages: [{ items: tasks(2, 201) }] })
  await page.getByRole('tab', { name: '我的 Bug', exact: true }).click(); await at(1, 2)
  assert.match(await rows.first().innerText(), /#201 /)
  assert.equal(await button('下一页').isDisabled(), true)
  await config([{ items: [], fail: true }, { items: tasks(1) }])
  await at(1, 0)
  await button('重试读取').click(); await at(1, 1)
  assert.deepEqual((await stats()).reads, [0, 0, 1])
  for (const count of [0, 1, 9, 10, 11, 20, 21]) {
    await config([{ items: tasks(count) }]); await at(1, Math.min(count, 10))
    for (let number = 2; number <= Math.ceil(count / 10); number++) {
      await button('下一页').click(); await at(number, Math.min(10, count - (number - 1) * 10))
    }
    assert.equal(await button('下一页').isDisabled(), true)
    assert.deepEqual((await stats()).reads, [0])
  }
  const calls = await call('fixture.calls')
  assert.equal(calls.calls.some(name => ['hours.submit', 'bugs.businessSubmit', 'repair.start'].includes(name)), false)
  return { environment: 'Headless Chrome + production HTML + fictional Worker; no live ONES access', checks: ['10-item first/middle/partial-last pages', 'cached back/forward and detail return', 'filter before slicing with sparse and empty remote pages', 'all status controls and project change reset page', 'no fabricated next page', 'partial load failure retains page and retries cursor', 'duplicate ID and cursor stop', 'stale filter, navigation, account and project-follow responses rejected', 'empty state and first-page retry', '360 light / 460 dark without horizontal overflow', 'no business writes'] }
}
