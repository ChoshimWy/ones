import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDirectory, assertPrivatePath, syncDirectory } from '../src/private-files.ts'
import { RepairCache } from '../src/repair-cache.ts'

test('private files: Windows ACL or POSIX mode protects new data, hard links are refused', async () => {
  const root=await mkdtemp(join(tmpdir(),'ones-private-'))
  try {
    await ensurePrivateDirectory(root,'private root')
    const file=join(root,'receipt.json')
    await writeFile(file,'{}',{mode:0o600})
    await assertPrivatePath(file,'file','private receipt')
    await syncDirectory(root)
    await link(file,join(root,'alias.json'))
    await assert.rejects(assertPrivatePath(file,'file','hard link refused'),/hard link refused/)
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('Windows: public read ACL is rejected without rewriting existing data permissions', {skip:process.platform!=='win32'}, async () => {
  const root=await mkdtemp(join(tmpdir(),'ones-acl-'))
  try {
    await ensurePrivateDirectory(root,'private root')
    const file=join(root,'receipt.json')
    await writeFile(file,'{}')
    execFileSync(join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',String.raw`
      $p=$env:ONES_TEST_FILE
      $acl=Get-Acl -LiteralPath $p
      $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
      $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow')
      $acl.AddAccessRule($rule)
      [IO.File]::SetAccessControl($p,$acl)
    `],{windowsHide:true,env:{...process.env,ONES_TEST_FILE:file}})
    await assert.rejects(assertPrivatePath(file,'file','private receipt'),/Windows 本地资料权限不安全/)
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('Windows: repair receipt persists across cache reopen with ACL checks', async () => {
  const root=await mkdtemp(join(tmpdir(),'ones-receipt-'))
  const cache=new RepairCache(join(root,'cache'))
  try {
    const directory=join(root,'run')
    await ensurePrivateDirectory(directory,'private run')
    const task={id:'task',number:1,name:'fixture',project:{id:'p',name:'p'},issueType:{id:'bug',name:'bug'},status:{id:'open',name:'open'}}
    const receipt={state:'sent' as const,projectName:'p',projectId:'p',createdAt:1}
    const {resultFile,...binding}=await cache.register('owner',task,receipt,'revision',directory)
    await writeFile(resultFile,JSON.stringify({...binding,reportVersion:3,reportSequence:1,rootCause:'fixture cause',solution:'fixture fix',impact:'fixture only',sourceIdentity:'fixture sha',repair:{state:'fixed',workspace:'isolated_worktree'},validation:{status:'passed',reason:'fixture tests',remaining:[],evidence:['fixture test result'],unitTests:{status:'passed',passed:1,failed:0,skipped:0,notRun:0,total:1}},delivery:{state:'uncommitted',note:'fixture'}}),{mode:0o600})
    await cache.consume('owner',()=>{})
    cache.close()
    const result=await cache.read('owner')
    const report=result.items[0]?.report
    assert.ok(report && 'repair' in report)
    assert.equal(report.repair.state,'fixed')
    assert.equal(result.items[0]?.reportError,undefined)
    assert.equal((await cache.read('another-owner')).items.length,0)
  } finally { cache.close(); await rm(root,{recursive:true,force:true}) }
})
