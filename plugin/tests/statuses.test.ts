import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTask } from '../src/adapters/ones.ts'
import { Workbench, type Store, type Vault } from '../src/service.ts'
import type { Fetcher } from '../src/adapters/http.ts'

function fixture() {
  const data = new Map<string, unknown>([['session.ones', JSON.stringify({token:'fixture-access',userId:'owner-fixture',label:'虚构用户',teams:[{id:'team-fixture',name:'虚构团队'}],expiresAt:Date.now()+600000})]])
  const store: Store = {get:async key => structuredClone(data.get(key) ?? null),set:async(key,value) => {data.set(key,structuredClone(value))},delete:async key => {data.delete(key)}}
  const bug = {uuid:'bug-type',name:'缺陷',built_in:true,type:0,detail_type:3,default_configs:{default_task_status_configs:[{status_uuid:'status-2'},{status_uuid:'status-4'}]}}
  let types: unknown = {issue_types:[bug,{uuid:'normal-type',name:'任务'}]}
  let payload: unknown = {task_statuses:Array.from({length:77},(_,index) => ({uuid:`status-${index}`,name:`虚构状态-${index}`}))}
  let responseStatus = 200
  let onRead: (() => Promise<void>) | undefined
  let wrongType = false
  const paths: string[] = []
  const filters: Record<string,unknown>[] = []
  const fetcher: Fetcher = async (url, init = {}) => {
    const path = new URL(String(url)).pathname
    paths.push(path)
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-access')
    if (path.endsWith('/items/graphql')) {
      const {query,variables} = JSON.parse(String(init.body))
      assert.ok(!query.includes('mutation'))
      assert.ok(query.includes('owner{uuid name}'))
      filters.push(variables.filter)
      const type = wrongType || !variables.filter.issueType_in ? 'normal-type' : 'bug-type'
      return Response.json({data:{buckets:[{tasks:[{uuid:'item-fixture',number:1,name:'虚构工作项',project:{uuid:'project-fixture',name:'项目'},issueType:{uuid:type,name:type === 'bug-type' ? '缺陷' : '任务'},status:{uuid:'status-2',name:'虚构状态-2'}}],pageInfo:{hasNextPage:false,endCursor:'',unstable:false}}]}})
    }
    assert.equal(init.method ?? 'GET', 'GET')
    assert.equal(init.body, undefined)
    if (path.endsWith('/users/me')) return Response.json({uuid:'owner-fixture'})
    if (path.endsWith('/issue_types')) return Response.json(types)
    assert.equal(path, '/project/api/project/team/team-fixture/task_statuses')
    if (onRead) {const action=onRead;onRead=undefined;await action()}
    return Response.json(payload,{status:responseStatus})
  }
  const service = new Workbench({store,vault:store as Vault,protection:async()=>true,fetcher})
  return {service,paths,filters,bug,set payload(value:unknown){payload=value},set types(value:unknown){types=value},set code(value:number){responseStatus=value},set wrongType(value:boolean){wrongType=value},set nextRead(action:()=>Promise<void>){onRead=action}}
}

test('TC-PLUGIN-002-statuses: defect metadata excludes unrelated team states without task pages', async () => {
  const env=fixture()
  const rows=await env.service.bugStatuses('team-fixture')
  assert.deepEqual(rows.map(row=>row.id),['status-2','status-4'])
  assert.equal(env.paths.length,3)
  assert.equal(env.filters.length,0)
  const before=env.paths.length
  await assert.rejects(()=>env.service.bugStatuses('other-team'))
  assert.equal(env.paths.length,before)
})

test('TC-PLUGIN-002-statuses: missing or ambiguous defect config fails without broad fallback', async () => {
  const env=fixture()
  for(const types of [{},{issue_types:[]},{issue_types:[env.bug,env.bug]},{issue_types:[{...env.bug,detail_type:0}]},{issue_types:[{...env.bug,default_configs:{}}]}]) {
    env.types=types
    await assert.rejects(()=>env.service.bugStatuses('team-fixture'))
    await assert.rejects(()=>env.service.bugs('team-fixture'))
  }
  assert.equal(env.filters.length,0)
  env.types={issue_types:[env.bug]}
  for(const payload of [{},{task_statuses:null},{task_statuses:[]},{task_statuses:[{uuid:'status-2',name:'状态'},{uuid:'status-2',name:'重复'}]}]) {
    env.payload=payload
    await assert.rejects(()=>env.service.bugStatuses('team-fixture'))
  }
})

test('TC-PLUGIN-002-statuses: expired and changed identities cannot publish metadata', async () => {
  const expired=fixture()
  expired.code=401
  await assert.rejects(()=>expired.service.bugStatuses('team-fixture'))
  assert.equal((await expired.service.status()).ones.connected,false)
  const changed=fixture()
  changed.nextRead=()=>changed.service.logout('ones').then(()=>{})
  await assert.rejects(()=>changed.service.bugStatuses('team-fixture'))
  assert.equal((await changed.service.status()).ones.connected,false)
})

test('TC-PLUGIN-002-bugs: server filter is mandatory and allocation tasks remain independent', async () => {
  const env=fixture()
  const bugs=await env.service.bugs('team-fixture')
  assert.equal(bugs.items[0].issueType.id,'bug-type')
  assert.deepEqual(env.filters[0],{assign_in:['owner-fixture'],issueType_in:['bug-type']})
  await env.service.bugs('team-fixture','next-fixture')
  assert.deepEqual(env.filters[1],env.filters[0])
  const tasks=await env.service.tasks('team-fixture')
  assert.equal(tasks.items[0].issueType.id,'normal-type')
  assert.deepEqual(env.filters[2],{assign_in:['owner-fixture']})
  env.wrongType=true
  await assert.rejects(()=>env.service.bugs('team-fixture'))
})

// 创建者独立于负责人；缺失关系不捏造用户，非法关系沿用严格 schema 检查。
test('task creator is read from owner, not assignee', () => {
  const task = { uuid: 'bug', number: 1, name: '示例缺陷', project: { uuid: 'project', name: '项目' }, issueType: { uuid: 'bug-type', name: '缺陷' }, status: { uuid: 'pending', name: '待处理' }, assign: { uuid: 'assignee', name: '负责人' } }
  assert.deepEqual(parseTask({ ...task, owner: { uuid: 'creator', name: '创建者' } }).creator, { id: 'creator', name: '创建者' })
  assert.equal(parseTask(task).creator, null)
  assert.equal(parseTask({ ...task, owner: null }).creator, null)
  assert.throws(() => parseTask({ ...task, owner: { uuid: 'creator' } }))
})
