import assert from 'node:assert/strict'

/// 提供完整本地执行记录及可控制故障；同步仅返回虚构数据，不启动修复。
export function installImplementationPaginationFixture(handlers) {
  const state = { count: 25, cacheError: '', syncError: '', holdSync: false }
  const reads = { cache: 0, sync: 0 }
  const pending = []
  const ok = value => ({ ok: true, value })
  const snapshot = () => ({
    version: 1, syncedAt: Date.now(), reconciledAt: Date.now(),
    items: Array.from({ length: state.count }, (_, index) => ({
      task: { id: `implementation-${index + 1}`, number: index + 1, name: `虚构实施分页记录 ${index + 1}`, project: { id: 'project', name: '实施验证项目' }, issueType: { id: 'bug', name: '缺陷' }, status: { id: 'pending', name: '待处理' } },
      record: { state: 'sent', projectId: 'local-fixture', projectName: '本地虚构项目', createdAt: 1794186000000 }
    }))
  })
  handlers.set('fixture.implementationPagination', input => { Object.assign(state, input); return ok(true) })
  handlers.set('fixture.implementationPaginationStats', () => ok({ ...reads, pending: pending.length }))
  handlers.set('fixture.implementationPaginationRelease', () => { pending.splice(0).forEach(resolve => resolve()); return ok(true) })
  for (const method of ['cache', 'sync']) handlers.set(`repair.${method}`, async () => {
    reads[method]++
    const value = snapshot()
    const error = state[`${method}Error`]
    if (method === 'sync' && state.holdSync) {
      state.holdSync = false
      await new Promise(resolve => pending.push(resolve))
    }
    return error ? { ok: false, error: { code: error, message: error === 'network' ? '虚构网络不可达' : '虚构认证已失效' } } : ok(value)
  })
}

/// 验证真实父级与列表的分页生命周期；五秒轮询通过浏览器虚拟时钟触发。
export async function exerciseImplementationPagination({ page, screenshot }) {
  const call = (name, input = {}) => page.evaluate(async ({ name, input }) => (await orca.host.call('plugin.request', { name, input })).output.value, { name, input })
  const config = input => call('fixture.implementationPagination', input)
  const stats = () => call('fixture.implementationPaginationStats')
  const button = name => page.getByRole('button', { name, exact: true })
  const rows = page.locator('section.card').filter({ has: page.getByRole('button', { name: '查看详情', exact: true }) })
  const at = async (number, count) => {
    await page.getByText(`第 ${number} 页`, { exact: true }).waitFor()
    await page.waitForFunction(count => document.querySelectorAll('section.card').length === count, count)
    assert.equal(await rows.count(), count)
  }
  const idle = () => page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '刷新执行记录' && !button.disabled))
  const refresh = async () => { await button('刷新执行记录').click(); await idle() }
  const poll = async () => {
    const previous = (await stats()).cache
    await page.clock.runFor(5000)
    await page.waitForFunction(async previous => (await orca.host.call('plugin.request', { name: 'fixture.implementationPaginationStats' })).output.value.cache > previous, previous)
    await idle()
  }
  await page.getByRole('tab', { name: '实施', exact: true }).click()
  await at(1, 10); await idle()
  assert.equal(await button('上一页').isDisabled(), true)
  const initialReads = await stats()
  await button('下一页').click(); await at(2, 10)
  assert.match(await rows.first().innerText(), /#11 /)
  await button('下一页').click(); await at(3, 5)
  assert.equal(await button('下一页').isDisabled(), true)
  await button('上一页').click(); await at(2, 10)
  assert.deepEqual(await stats(), initialReads)
  await screenshot('implementation-pagination-page2-360', 'light', 360)
  await screenshot('implementation-pagination-page2-460', 'dark', 460)

  for (const entry of ['查看详情', '更新状态']) {
    await rows.first().getByRole('button', { name: entry, exact: true }).click()
    await button('返回执行记录').click(); await at(2, 10); await idle()
    assert.match(await rows.first().innerText(), /#11 /)
  }
  await refresh(); await at(2, 10)
  await poll(); await at(2, 10)
  await button('下一页').click(); await at(3, 5)
  await config({ count: 11 }); await refresh(); await at(2, 1)
  assert.equal(await button('下一页').isDisabled(), true)
  await config({ count: 21 }); await poll(); await at(2, 10)
  await button('下一页').click(); await at(3, 1)
  await config({ count: 9 }); await poll(); await at(1, 9)
  await config({ count: 0 }); await poll(); await at(1, 0)
  await page.getByText('暂无匹配的执行记录。', { exact: true }).waitFor()
  assert.equal(await button('上一页').isDisabled(), true)
  assert.equal(await button('下一页').isDisabled(), true)
  await screenshot('implementation-pagination-empty-360', 'light', 360)

  // 网络失败保留当前缓存页；鉴权错误移除数据并清除父级页码。
  await config({ count: 25 }); await refresh(); await at(1, 10)
  await button('下一页').click(); await at(2, 10)
  await config({ syncError: 'network' }); await refresh(); await at(2, 10)
  await page.getByText('同步失败，当前显示上次缓存（可能过期）：虚构网络不可达', { exact: true }).waitFor()
  await config({ syncError: 'auth' }); await refresh(); await at(1, 0)
  await page.getByText('执行记录不可用：虚构认证已失效', { exact: true }).waitFor()
  assert.equal(await button('上一页').isDisabled(), true)
  assert.equal(await button('下一页').isDisabled(), true)
  await config({ syncError: '' }); await refresh(); await at(1, 10)
  await button('下一页').click(); await at(2, 10)
  await config({ cacheError: 'forbidden' }); await poll(); await at(1, 0)
  await config({ cacheError: '' }); await refresh(); await at(1, 10)

  // 同步未完成时离开，迟到的 25 条不能覆盖重新进入后的一条新缓存。
  await button('下一页').click(); await at(2, 10)
  await config({ holdSync: true }); await button('刷新执行记录').click()
  await page.waitForFunction(async () => (await orca.host.call('plugin.request', { name: 'fixture.implementationPaginationStats' })).output.value.pending === 1)
  await page.getByRole('tab', { name: '我的 Bug', exact: true }).click()
  await page.locator('button.bug-item').first().waitFor()
  await config({ count: 1 })
  await page.getByRole('tab', { name: '实施', exact: true }).click(); await at(1, 1)
  await call('fixture.implementationPaginationRelease')
  await at(1, 1)
  assert.equal(await button('下一页').isDisabled(), true)

  // 完整本地列表的边界值无需任何翻页网络请求。
  for (const count of [0, 1, 9, 10, 11, 20, 21]) {
    await config({ count }); await refresh()
    await at(1, Math.min(count, 10))
    const before = await stats()
    for (let number = 2; number <= Math.ceil(count / 10); number++) {
      await button('下一页').click(); await at(number, Math.min(10, count - (number - 1) * 10))
    }
    assert.equal(await button('下一页').isDisabled(), true)
    assert.deepEqual(await stats(), before)
    while (await button('上一页').isEnabled()) await button('上一页').click()
  }
  const calls = await call('fixture.calls')
  assert.equal(calls.calls.some(name => ['repair.start', 'bugs.businessSubmit', 'hours.submit'].includes(name)), false)
  return { environment: 'Headless Chrome + production WorkbenchUI/ImplementationView + fictional Worker; virtual clock drives real five-second interval', checks: ['10-item first/middle/partial-last pages and 0/1/9/10/11/20/21 boundaries', 'page navigation performs no cache or sync request', 'detail and update-status entry preserve page on return', 'manual refresh and five-second polling preserve page', 'refresh/poll shrink clamps page and empty list disables both buttons', 'network failure preserves page/cache; sync and poll auth failures clear cache/page', 'disposed late sync cannot overwrite new view', '360 light / 460 dark visual preview without horizontal overflow', 'no business writes'] }
}
