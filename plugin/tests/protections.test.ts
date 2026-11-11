import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { attendanceBudget, apiHours, checkAllocations, startSeconds } from '../src/domain/attendance.ts'
import { Submission, type Receipt, type WriteIntent } from '../src/domain/submission.ts'
import { type Worklog, type Attendance, safeFailure } from '../src/domain/model.ts'
import { ONES, COHO, Transport, readJSON, type Fetcher } from '../src/adapters/http.ts'
import { loginOnes } from '../src/adapters/ones-auth.ts'
import { OnesClient } from '../src/adapters/ones.ts'
import { CohoClient, loginCoho } from '../src/adapters/coho.ts'
import { Workbench, type Store, type Vault } from '../src/service.ts'

function json(value: unknown, status = 200, headers: Record<string,string> = {}) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } }) }
function memory() {
  const data = new Map<string, unknown>()
  const store: Store = { get: async key => structuredClone(data.get(key) ?? null), set: async (key,value) => { data.set(key, structuredClone(value)) }, delete: async key => { data.delete(key) } }
  const vault = store as Vault
  return { data, store, vault }
}
const attendance = (start='09:00', end='21:00'): Attendance => ({ date:'2026-01-05', fetchedAt:Date.now(), punches:[start,end].map(time=>({date:'2026-01-05',realDate:'2026-01-05',time,isNext:false,outFence:false})) })
const selected = { start:0,end:1,confirmed:true }
const row = {taskId:'task-fixture',start:'09:00',minutes:480,description:'虚构测试工作说明'}

test('TC-PLUGIN-003: attendance boundaries and no attendance bypass', () => {
  for (const [end,minutes] of [['18:30',480],['19:29',480],['19:30',510],['19:59',510],['20:00',540],['20:29',540],['20:30',570],['21:00',600]] as const) assert.equal(attendanceBudget(attendance('09:00',end),selected),minutes)
  assert.equal(attendanceBudget(attendance('09:15','21:00'),selected),600)
  for (const value of [attendance('09:15','20:00'),attendance('09:00','18:29'),attendance('09:00','21:01'),{...attendance(),punches:[]},{...attendance(),punches:[...attendance().punches,...attendance().punches]}]) assert.throws(()=>attendanceBudget(value,selected))
  assert.throws(()=>attendanceBudget(attendance(),{...selected,confirmed:false}))
  assert.throws(()=>attendanceBudget(attendance(),{...selected,start:1,end:0}))
  for (const changed of [{isNext:true},{outFence:undefined},{outFence:'false'},{realDate:'2026-01-06'}]) {
    const input=attendance();Object.assign(input.punches[0],changed);assert.throws(()=>attendanceBudget(input,selected))
  }
  assert.equal(apiHours(480),800000);assert.equal(apiHours(30),50000);assert.throws(()=>apiHours(1))
  assert.throws(()=>checkAllocations([{...row,description:'  '}],480,0))
  assert.throws(()=>checkAllocations([row],480,30))
  assert.equal(checkAllocations([{...row,minutes:450}],480,30),450)
})

test('TC-PLUGIN-001: exact origin, OAuth state and password login without browser state', async () => {
  const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}})
  const requests: {path:string;init:RequestInit}[]=[];let state='';let cookieSeen=false
  const fetcher:Fetcher=async (url,init={})=>{
    const path=new URL(String(url)).pathname;requests.push({path,init})
    assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit')
    if(path.endsWith('/login_support'))return json({org_uuid:'org-fixture'})
    if(path.endsWith('/encryption_cert'))return json({public_key:publicKey})
    if(path==='/identity/api/login'){
      const payload=JSON.parse(String(init.body));assert.equal(payload.email,'fixture@example.test');assert.notEqual(payload.password,'fake-password-only');assert.ok(payload.password.length>100)
      return json({org_users:[{org:{org_uuid:'org-fixture',region_uuid:'region-fixture'},org_user:{org_user_uuid:'user-fixture'}}]},200,{'set-cookie':'sid=fixture-cookie; Path=/identity/; HttpOnly'})
    }
    if(path==='/identity/authorize'){
      const body=new URLSearchParams(String(init.body));state=body.get('state')!;assert.equal(body.get('scope'),'openid offline_access ones:org:region-fixture:org-fixture:user-fixture');assert.equal(body.get('code_challenge_method'),'S256')
      cookieSeen=new Headers(init.headers).get('cookie')==='sid=fixture-cookie'
      return new Response(null,{status:302,headers:{location:`${ONES}/auth/authorize/callback?code=fake-code&state=${state}`}})
    }
    if(path==='/identity/oauth/token')return json({access_token:'fixture-access',refresh_token:'fixture-refresh',token_type:'Bearer',expires_in:172800})
    assert.equal(new Headers(init.headers).get('cookie'),null)
    if(path.endsWith('/users/me'))return json({uuid:'user-fixture',email:'fixture@example.test',name:'虚构用户'})
    if(path.endsWith('/auth/token_info'))return json({teams:[{uuid:'team-fixture',name:'虚构团队'}]})
    throw new Error('unexpected fixture endpoint')
  }
  const transport=new Transport(ONES,fetcher)
  const session=await loginOnes(transport,'fixture@example.test','fake-password-only',true)
  assert.equal(session.refreshToken,'fixture-refresh')
  assert.ok(session.expiresAt > Date.now() + 86400000);assert.equal(session.userId,'user-fixture');assert.ok(cookieSeen);assert.equal(requests.length,7)
  const before=requests.length
  await assert.rejects(()=>transport.json('https://untrusted.example.test/steal'))
  await assert.rejects(()=>loginOnes(transport,'fixture@example.test','fake-password-only',false))
  assert.equal(requests.length,before)
  const wrongState:Fetcher=async(url,init)=>new URL(String(url)).pathname==='/identity/authorize'?new Response(null,{status:302,headers:{location:`https://untrusted.example.test/?code=fake&state=${state}`}}):fetcher(url,init)
  await assert.rejects(()=>loginOnes(new Transport(ONES,wrongState),'fixture@example.test','fake-password-only',true))
  assert.deepEqual(safeFailure(new Error('Authorization: secret fixture')), {code:'unavailable',message:'操作未完成，请检查连接后重试；写入结果需先核实。'})
  await assert.rejects(()=>new Transport(COHO,async()=>new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}})).json('/gateway/test'))
})

test('TC-PLUGIN-004: uncertain write fences retries and readback guards fields', async () => {
  let records:Receipt[]=[];let adds=0;const intent:WriteIntent={scope:'scope',date:'2026-01-05',task:'task-fixture',owner:'user-fixture',hours:800000,startTime:startSeconds('2026-01-05','09:00'),description:'虚构描述'}
  const ledger={load:async()=>structuredClone(records),save:async(rows:Receipt[])=>{records=structuredClone(rows)}}
  const expected:Worklog={key:'log-fixture',task:intent.task,owner:intent.owner,hours:intent.hours,startTime:intent.startTime,description:intent.description,type:'recorded'}
  const success=new Submission(ledger,{add:async()=>{adds++;return expected.key},get:async()=>expected})
  assert.equal((await success.add(intent,'fingerprint-1',[])).state,'verified')
  assert.equal((await success.add(intent,'fingerprint-1',[])).state,'verified');assert.equal(adds,1)
  const unknown=new Submission(ledger,{add:async()=>{adds++;throw Error('lost reply')},get:async()=>expected})
  await assert.rejects(()=>unknown.add(intent,'fingerprint-2',[]));assert.equal(records[1].state,'unknown')
  const restarted=new Submission(ledger,{add:async()=>{adds++;return expected.key},get:async()=>expected})
  await assert.rejects(()=>restarted.add(intent,'fingerprint-2',[]));await assert.rejects(()=>restarted.add(intent,'fingerprint-3',[]));assert.equal(adds,2)
  records=[]
  const mismatch=new Submission(ledger,{add:async()=>{adds++;return expected.key},get:async()=>({...expected,hours:1600000})})
  await assert.rejects(()=>mismatch.add(intent,'fingerprint-4',[]));assert.equal(records[0].state,'unknown')
  const count=adds
  const failedDisk=new Submission({load:async()=>[],save:async()=>{throw Error('disk')}},{add:async()=>{adds++;return expected.key},get:async()=>expected})
  await assert.rejects(()=>failedDisk.add(intent,'fingerprint-5',[]));assert.equal(adds,count)
})

test('TC-PLUGIN-003/004: service authority survives stale preview and refuses direct submit', async () => {
  const mem=memory();const now=Date.now()
  mem.data.set('session.ones',JSON.stringify({token:'fixture-access',userId:'user-fixture',label:'虚构',teams:[{id:'team-fixture',name:'虚构团队'}],expiresAt:now+600000}))
  mem.data.set('session.coho',JSON.stringify({token:'fixture-coho',principal:'principal-fixture',label:'虚构',expiresAt:now+600000}))
  let mutated=0;let total=0;let dayEnd='21:00'
  const fetcher:Fetcher=async(url,init={})=>{
    const path=new URL(String(url)).pathname
    if(path.endsWith('/users/me'))return json({uuid:'user-fixture'})
    if(path.endsWith('/info'))return json({timezone:'Asia/Shanghai',workhours_unit:'hour',configs:[{type:'manhour_mode',data:'simple'}]})
    if(path.endsWith('/getCurrentUser'))return json({code:200,data:{tenantCode:'ATS',globalId:'principal-fixture'}})
    if(path.endsWith('/getInfoByDateAndUser'))return json({code:200,data:{kqqsId:'period-fixture',kqqs:'period-label'}})
    if(path.endsWith('/attCalendar'))return json({code:200,data:{dateList:[{date:'2026-01-05'}],dkList:attendance('09:00',dayEnd).punches}})
    const {query}=JSON.parse(String(init.body))
    if(query.includes('mutation')){mutated++;throw Error('test must not write')}
    if(query.includes('PluginTask'))return json({data:{tasks:[{uuid:'task-fixture',number:1,name:'虚构任务',project:{uuid:'project-fixture',name:'项目'},issueType:{uuid:'type-fixture',name:'缺陷'},status:{uuid:'status-fixture',name:'待处理'}}]}})
    return json({data:{buckets:[{manhours:total?[{key:'existing',hours:total,owner:{uuid:'user-fixture'},task:{uuid:'task-fixture'},startTime:startSeconds('2026-01-05','09:00'),type:'recorded',description:'已有'}]:[],pageInfo:{hasNextPage:false,endCursor:'',unstable:false}}]}})
  }
  const deps={store:mem.store,vault:mem.vault,protection:async()=>true,fetcher}
  const service=new Workbench(deps)
  await assert.rejects(()=>service.submit('invented',true))
  await assert.rejects(()=>service.makePreview({dayId:'invented',selection:selected,allocations:[row]}))
  const input={team:'team-fixture',date:'2026-01-05',mappingConfirmed:true}
  const day=await service.readDay(input)
  const preview=await service.makePreview({dayId:day.id,selection:selected,allocations:[row]})
  assert.equal(preview.budget,600);assert.equal(preview.remaining,120)
  await assert.rejects(()=>service.submit(preview.id,true));assert.equal(mutated,0)
  // The test-only write gate exposes the real write-time revalidation, without a mutation.
  const verified=new Workbench({...deps,writesVerified:true})
  const day2=await verified.readDay(input);const preview2=await verified.makePreview({dayId:day2.id,selection:selected,allocations:[row]})
  total=300000
  await assert.rejects(()=>verified.submit(preview2.id,true));assert.equal(mutated,0)
  total=0
  const day3=await verified.readDay(input);const preview3=await verified.makePreview({dayId:day3.id,selection:selected,allocations:[row]})
  dayEnd='20:00'
  await assert.rejects(()=>verified.submit(preview3.id,true));assert.equal(mutated,0)
  await service.logout('coho')
  await assert.rejects(()=>service.readDay(input));assert.equal((await service.status()).ones.connected,true)
})

test('TC-PLUGIN-001: unavailable protected storage never sends a password', async () => {
  const mem=memory();let requests=0
  const service=new Workbench({store:mem.store,vault:mem.vault,protection:async()=>false,fetcher:async()=>{requests++;throw Error('network')}})
  const input={site:'ones' as const,account:'fixture@example.test',password:'fake-password-only',httpAcknowledged:true}
  await assert.rejects(()=>service.login(input));assert.equal(input.password,'');assert.equal(requests,0)
})

test('TC-PLUGIN-001-cancel: cancelled login cannot revive a stored session', async () => {
  const mem=memory();let started!:()=>void;const storing=new Promise<void>(resolve=>{started=resolve});let finish!:()=>void;const wait=new Promise<void>(resolve=>{finish=resolve})
  const vault:Vault={...mem.vault,set:async(key,value)=>{started();await wait;await mem.vault.set(key,value)}}
  const controller=new AbortController()
  const service=new Workbench({store:mem.store,vault,protection:async()=>true,fetcher:async(url)=>String(url).endsWith('requestToken')?json({code:200,data:{token:'fixture-coho'}}):json({code:200,data:{tenantCode:'ATS',globalId:'principal-fixture'}})})
  const login=service.login({site:'coho',account:'fixture',password:'fake-password-only',httpAcknowledged:false},controller.signal)
  const rejected=assert.rejects(()=>login)
  await storing;controller.abort();finish();await rejected
  assert.equal((await service.status()).coho.connected,false)
  assert.equal(await mem.vault.get('session.coho'),null)
})

test('TC-PLUGIN-004-positive: confirmed synthetic batch writes and reads each original date', async () => {
  const mem=memory();const until=Date.now()+600000
  mem.data.set('session.ones',JSON.stringify({token:'fixture-access',userId:'user-fixture',label:'虚构',teams:[{id:'team-fixture',name:'虚构团队'}],expiresAt:until}))
  mem.data.set('session.coho',JSON.stringify({token:'fixture-coho',principal:'principal-fixture',label:'虚构',expiresAt:until}))
  const logs:Record<string,unknown>[]=[];let writes=0
  const fetcher:Fetcher=async(url,init={})=>{
    const path=new URL(String(url)).pathname
    if(path.endsWith('/users/me'))return json({uuid:'user-fixture'})
    if(path.endsWith('/info'))return json({timezone:'Asia/Shanghai',workhours_unit:'hour',configs:[{type:'manhour_mode',data:'simple'}]})
    if(path.endsWith('/getCurrentUser'))return json({code:200,data:{tenantCode:'ATS',globalId:'principal-fixture'}})
    if(path.endsWith('/getInfoByDateAndUser'))return json({code:200,data:{kqqsId:'period-fixture',kqqs:'period-label'}})
    if(path.endsWith('/attCalendar'))return json({code:200,data:{dateList:[{date:'2026-01-05'}],dkList:attendance().punches}})
    const {query,variables:v}=JSON.parse(String(init.body))
    if(query.includes('PluginAdd')){
      writes++;const key=`log-${writes}`;logs.push({key,hours:v.hours,startTime:v.start_time,type:v.type,description:v.description,owner:{uuid:v.owner},task:{uuid:v.task}})
      return json({data:{addManhour:{key}}})
    }
    if(query.includes('PluginReadback'))return json({data:{manhours:logs.filter(r=>r.key===v.filter.key_equal)}})
    if(query.includes('PluginTask'))return json({data:{tasks:[{uuid:'task-fixture',number:1,name:'虚构任务',project:{uuid:'project-fixture',name:'项目'},issueType:{uuid:'type-fixture',name:'缺陷'},status:{uuid:'status-fixture',name:'待处理'}}]}})
    return json({data:{buckets:[{manhours:logs,pageInfo:{hasNextPage:false,endCursor:'',unstable:false}}]}})
  }
  const service=new Workbench({store:mem.store,vault:mem.vault,protection:async()=>true,fetcher,writesVerified:true})
  const day=await service.readDay({team:'team-fixture',date:'2026-01-05',mappingConfirmed:true})
  const preview=await service.makePreview({dayId:day.id,selection:selected,allocations:[row,{...row,minutes:120,start:'19:00',description:'另一条虚构描述'}]})
  assert.deepEqual(await service.submit(preview.id,true),{count:2})
  assert.equal(writes,2)
  assert.equal(logs[0].startTime,startSeconds('2026-01-05','09:00'))
  assert.equal(logs[1].startTime,startSeconds('2026-01-05','19:00'))
  assert.equal((await mem.store.get('receipts') as Receipt[]).filter(r=>r.state==='verified').length,2)
  await assert.rejects(()=>service.submit(preview.id,true));assert.equal(writes,2)
})


test('TC-PLUGIN-001-diagnostics: auth failures expose only stage and HTTP code', async () => {
  await assert.rejects(
    () => readJSON(json({secret:'fixture-not-for-display'}, 400), 'ONES 令牌交换'),
    (error: Error) => {
      assert.match(error.message, /ONES 令牌交换/)
      assert.match(error.message, /HTTP 400/)
      assert.doesNotMatch(error.message, /fixture-not-for-display/)
      return true
    }
  )
  await assert.rejects(
    () => new Transport(COHO, async () => new Response(null, {status:302,headers:{location:'https://untrusted.example.test/?token=fixture-not-for-display'}})).json('/gateway/auth/account/requestToken'),
    (error: Error) => {
      assert.match(error.message, /Coho 密码认证/)
      assert.match(error.message, /HTTP 302/)
      assert.doesNotMatch(error.message, /untrusted|fixture-not-for-display/)
      return true
    }
  )
})


test('TC-PLUGIN-001-finalize: organization authorization preserves scope and callback state', async () => {
  const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}})
  let state='';let mode='valid';let finalizations=0;let exchanges=0
  const scopes=['openid','offline_access','ones:org:region-fixture:org-fixture:user-fixture']
  const fetcher:Fetcher=async(url,init={})=>{
    const path=new URL(String(url)).pathname
    if(path.endsWith('/login_support'))return json({org_uuid:'org-fixture'})
    if(path.endsWith('/encryption_cert'))return json({public_key:publicKey})
    if(path==='/identity/api/login')return json({org_users:[{org:{org_uuid:'org-fixture',region_uuid:'region-fixture'},org_user:{org_user_uuid:'user-fixture'}}]},200,{'set-cookie':'sid=fixture-cookie; Path=/identity/; HttpOnly'})
    if(path==='/identity/authorize'){
      state=new URLSearchParams(String(init.body)).get('state')!
      return new Response(null,{status:302,headers:{location:'/identity/organization_select?id=request-fixture'}})
    }
    if(path==='/identity/api/auth_request/request-fixture')return json({scopes:mode==='scope'?['openid','wrong-scope']:scopes})
    if(path==='/identity/api/auth_request/finalize'){
      assert.equal(new Headers(init.headers).get('cookie'),'sid=fixture-cookie')
      assert.deepEqual(JSON.parse(String(init.body)),{auth_request_id:'request-fixture',region_uuid:'region-fixture',org_uuid:'org-fixture',org_user_uuid:'user-fixture'})
      finalizations++
      return json({callback_url:mode==='origin'?'https://untrusted.example.test/steal':'/authorize/continue?opaque=fixture-only'})
    }
    if(path==='/identity/authorize/continue')return new Response(null,{status:303,headers:{location:`${ONES}/auth/authorize/callback?code=fake-code&state=${mode==='state'?'wrong':state}`}})
    if(path==='/identity/oauth/token'){exchanges++;return json({access_token:'fixture-access',token_type:'Bearer',expires_in:60})}
    if(path.endsWith('/users/me'))return json({uuid:'user-fixture',email:'fixture@example.test'})
    if(path.endsWith('/token_info'))return json({teams:[]})
    throw Error('unexpected request')
  }
  const login=()=>loginOnes(new Transport(ONES,fetcher),'fixture@example.test','fake-password-only',true)
  assert.equal((await login()).userId,'user-fixture');assert.equal(exchanges,1)
  mode='scope';await assert.rejects(login);assert.equal(finalizations,1)
  mode='origin';await assert.rejects(login)
  mode='state';await assert.rejects(login);assert.equal(exchanges,1)
})


test('TC-PLUGIN-001-coho-context: tenant context accompanies identity read without redirect', async () => {
  let calls=0
  const fetcher:Fetcher=async(url,init={})=>{
    calls++
    const h=new Headers(init.headers)
    assert.equal(h.get('Cookie'),'sso_tenant_code=ATS')
    assert.equal(h.get('Origin'),COHO)
    assert.equal(h.get('COHO-language'),'zh-CN')
    assert.equal(init.redirect,'manual')
    if(String(url).endsWith('requestToken'))return json({code:200,data:{token:'fixture-coho'}})
    assert.equal(h.get('Authorization'),'Bearer fixture-coho')
    return json({code:200,data:{tenantCode:'ATS',globalId:'principal-fixture'}})
  }
  const session=await loginCoho(new Transport(COHO,fetcher),'fixture','fake-password-only')
  assert.equal(session.principal,'principal-fixture');assert.equal(calls,2)
})


test('TC-PLUGIN-002-page: task reads remain bounded with explicit continuation', async () => {
  let page=0;let bad=false
  const client=new OnesClient(new Transport(ONES,async(url,init={})=>{
    const {query,variables}=JSON.parse(String(init.body))
    assert.deepEqual(variables.filter,{assign_in:['user-fixture']})
    assert.doesNotMatch(query,/tasks\([^)]*limit:/)
    if(page===1)assert.ok(query.includes('after:"cursor-fixture"'))
    const value={uuid:`task-${page}`,number:page+1,name:'虚构',project:{uuid:'project-fixture',name:'项目'},issueType:{uuid:'type-fixture',name:'缺陷'},status:{uuid:'status-fixture',name:'待处理'}}
    page++
    return json({data:{buckets:[{tasks:[value],pageInfo:{unstable:bad,hasNextPage:page===1,endCursor:page===1?'cursor-fixture':''}}]}})
  }),{token:'fixture-access',userId:'user-fixture',label:'虚构',teams:[{id:'team-fixture',name:'团队'}],expiresAt:Date.now()+60000},'team-fixture')
  const first=await client.tasks();assert.equal(page,1);assert.equal(first.nextCursor,'cursor-fixture')
  const second=await client.tasks(first.nextCursor!);assert.equal(second.nextCursor,null);assert.equal(page,2)
  bad=true;await assert.rejects(()=>client.tasks())
})


test('TC-PLUGIN-003-self-attendance: ATS binds employee and period to authoritative reads', async () => {
  let missingPeriod=false
  const client=new CohoClient(new Transport(COHO,async(url,init={})=>{
    assert.equal(new Headers(init.headers).get('cookie'),'sso_tenant_code=ATS')
    const path=new URL(String(url)).pathname
    if(path.endsWith('getCurrentUser'))return json({code:200,data:{tenantCode:'ATS',globalId:'principal-fixture'}})
    const {data}=JSON.parse(String(init.body))
    if(path.endsWith('getInfoByDateAndUser')){
      assert.deepEqual(data,{curDate:'2026-01-05',empId:'principal-fixture'})
      return json({code:200,data:missingPeriod?{}:{kqqs:'period-fixture'}})
    }
    assert.deepEqual(data,{userId:'principal-fixture',kqqsId:'period-fixture',kqqs:'period-fixture'})
    return json({code:200,data:{dateList:[{date:'2026-01-05'}],dkList:attendance().punches}})
  }),{token:'fixture-coho',principal:'principal-fixture',label:'虚构',expiresAt:Date.now()+60000})
  assert.equal((await client.attendance('2026-01-05')).punches.length,2)
  missingPeriod=true;await assert.rejects(()=>client.attendance('2026-01-05'))
})
