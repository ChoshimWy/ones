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
      task: { id: `implementation-${index + 1}`, number: index + 1, name: `虚构实施分页记录 ${index + 1}：用于检查很长的缺陷标题始终只显示一行且不会挤压状态和操作列，超长内容通过悬停或进入详情查看完整信息`, project: { id: 'project', name: '实施验证项目' }, issueType: { id: 'bug', name: '缺陷' }, status: { id: 'pending', name: '待处理' } },
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

/// 完整缓存不再切页；缓存轮询、详情往返和身份保护继续生效。
export async function exerciseImplementationPagination({ page, screenshot }) {
  const call = (name, input = {}) => page.evaluate(async ({ name, input }) => (await orca.host.call('plugin.request', { name, input })).output.value, { name, input })
  const config = input => call('fixture.implementationPagination', input)
  const at = count => page.waitForFunction(count => document.querySelectorAll('.implementation-table tbody tr').length === count, count)
  const idle = () => page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '刷新执行记录' && !b.disabled))
  const refresh = async () => { await page.getByRole('button', { name: '刷新执行记录', exact: true }).click(); await idle() }
  const poll = async () => { await page.clock.runFor(5000); await idle() }
  await page.getByRole('tab', { name: '实施', exact: true }).click(); await at(25); await idle()
  assert.equal(await page.getByRole('button', { name: /上一页|下一页/ }).count(), 0)
  const before = await call('fixture.implementationPaginationStats')
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  assert.deepEqual(await call('fixture.implementationPaginationStats'), before)
  await screenshot('implementation-continuous-light', 'light', 1100)
  await screenshot('implementation-continuous-dark', 'dark', 460)
  for (const name of ['详情', '更新状态']) {
    const row = page.locator('.implementation-table tbody tr').nth(15)
    await (name === '详情' ? row.locator('.bug-item') : row.getByRole('button', { name, exact: true })).click()
    await page.getByRole('button', { name: '返回执行记录', exact: true }).click(); await at(25); await idle()
    await page.clock.runFor(32)
    assert.ok(await page.evaluate(() => window.scrollY > 0))
  }
  await config({ count: 40 }); await poll(); await at(40)
  await config({ count: 11 }); await refresh(); await at(11)
  await config({ syncError: 'network' }); await refresh(); await at(11)
  await page.getByText(/同步失败，当前显示上次缓存/).waitFor()
  await config({ syncError: 'auth' }); await refresh(); await at(0)
  await config({ syncError: '', count: 25 }); await refresh(); await at(25)
  await config({ cacheError: 'forbidden' }); await poll(); await at(0)
  await config({ cacheError: '', count: 0 }); await refresh(); await at(0)
  await page.getByText('暂无匹配的执行记录。', { exact: true }).waitFor()
  await screenshot('implementation-continuous-empty', 'light', 360)
  await config({ count: 25, holdSync: true })
  await page.getByRole('button', { name: '刷新执行记录', exact: true }).click()
  await page.waitForFunction(async () => (await orca.host.call('plugin.request', { name: 'fixture.implementationPaginationStats' })).output.value.pending === 1)
  await page.getByRole('tab', { name: '登录', exact: true }).click()
  await call('fixture.implementationPaginationRelease')
  assert.equal(await page.locator('.implementation-table').count(), 0)
  return { checks: ['all 25 cached rows visible without pagination', 'scroll does not read network', 'detail and status entry return preserve scroll', 'poll expands to 40 and refresh shrinks to 11', 'network failure retains marked cache; auth/permission failure clears data', 'empty state and late sync after navigation', 'no repair launch or status writes'], environment: 'Chrome preview + fictional Worker' }
}
