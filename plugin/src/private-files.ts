import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { requireThat } from './domain/model.ts'

// Resolve Orca's storage junction so receipt paths point at the actual data disk.
export function privateDataRoot(): string {
  if (process.platform !== 'win32') return join(homedir(), 'Library', 'Application Support', 'ones-workbench')
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  requireThat(appData && isAbsolute(appData), 'storage', '无法确定 Orca 插件数据目录。')
  return join(realpathSync(join(appData, 'Orca', 'plugins-data')), 'local.ones-workbench', 'runtime')
}

// Windows mode/uid values do not represent NTFS permissions. Check the actual DACL
// instead; never treat a missing getuid() or a successful chmod() as protection.
const aclScript = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:ONES_PRIVATE_PATH
$item = Get-Item -LiteralPath $path -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $path
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) { throw 'owner' }
$allowed = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')
function IsPrivate($candidate) {
  foreach ($rule in $candidate.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) { return $false }
  }
  return $true
}
if (-not (IsPrivate $acl)) {
  # Only initialize an empty, caller-owned directory. Existing unsafe data is
  # rejected rather than silently changing permissions and accepting it.
  if ($env:ONES_PRIVATE_INIT -ne '1' -or -not $item.PSIsContainer -or @(Get-ChildItem -LiteralPath $path -Force).Count -ne 0) { throw 'acl' }
  $secure = New-Object Security.AccessControl.DirectorySecurity
  $secure.SetAccessRuleProtection($true, $false)
  foreach ($sid in $allowed) {
    $principal = New-Object Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $secure.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($path, $secure)
  if (-not (IsPrivate (Get-Acl -LiteralPath $path))) { throw 'acl' }
}
[Console]::Write('private')
`

async function checkWindowsAcl(path: string, initialize: boolean): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  requireThat(systemRoot && isAbsolute(systemRoot), 'storage', '无法核对 Windows 文件权限。')
  const safe = await new Promise<boolean>(resolve => {
    execFile(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', aclScript],
      { windowsHide: true, timeout: 15000, maxBuffer: 32768, encoding: 'utf8', env: { ...process.env, SystemRoot: systemRoot, ONES_PRIVATE_PATH: path, ONES_PRIVATE_INIT: initialize ? '1' : '0' } },
      (error, stdout) => resolve(!error && stdout === 'private'))
  })
  requireThat(safe, 'storage', 'Windows 本地资料权限不安全，无法安全读取或写入。')
}

export async function assertPrivatePath(path: string, kind: 'file' | 'directory', message: string): Promise<void> {
  const st = await lstat(path)
  requireThat(!st.isSymbolicLink() && (kind === 'directory' ? st.isDirectory() : st.isFile() && st.nlink === 1), 'storage', message)
  if (process.platform === 'win32') await checkWindowsAcl(path, false)
  else requireThat(st.uid === process.getuid?.() && (st.mode & 0o077) === 0, 'storage', message)
}

export async function ensurePrivateDirectory(path: string, message: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const st = await lstat(path)
  requireThat(st.isDirectory() && !st.isSymbolicLink(), 'storage', message)
  if (process.platform === 'win32') await checkWindowsAcl(path, true)
  else requireThat(st.uid === process.getuid?.() && (st.mode & 0o077) === 0, 'storage', message)
}

export async function syncDirectory(path: string): Promise<void> {
  // Node cannot open/fsync a directory on Windows. File handles are still synced
  // before each rename, and the journals retain the same no-resend semantics.
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
