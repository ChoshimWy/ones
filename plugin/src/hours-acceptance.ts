import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPrivatePath, syncDirectory } from './private-files.ts'
import { requireThat } from './domain/model.ts'

/** Local operator permission for one immutable Worker preview, never panel input. */
export type HoursAcceptanceGrant = { previewId: string; identity: string; expiresAt: number }

export class HoursAcceptance {
  constructor(private readonly directory: string) {}

  async consume(expected: HoursAcceptanceGrant): Promise<void> {
    requireThat(process.platform === 'darwin', 'acceptance', '受控工时验收目前仅支持 macOS。')
    requireThat(/^[a-f0-9-]{36}$/.test(expected.previewId) && /^[a-f0-9]{64}$/.test(expected.identity), 'acceptance', '验收身份无效。')
    await assertPrivatePath(this.directory, 'directory', '验收许可目录必须为本人私有目录。')
    const file = await open(join(this.directory, 'permit.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      requireThat(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size <= 4096, 'acceptance', '验收许可文件权限或大小无效。')
      const grant = JSON.parse(await file.readFile('utf8'))
      requireThat(grant && Object.keys(grant).sort().join(',') === 'expiresAt,identity,previewId' &&
        grant.previewId === expected.previewId && grant.identity === expected.identity &&
        grant.expiresAt === expected.expiresAt && expected.expiresAt > Date.now() &&
        expected.expiresAt <= Date.now() + 300000, 'acceptance', '验收许可缺失、不匹配或过期。')
    } finally { await file.close() }
    // Exclusive creation is the cross-worker claim. Never remove it on failure.
    const claim = await open(join(this.directory, 'consumed-' + expected.previewId + '.json'), 'wx', 0o600)
    try {
      await claim.writeFile(JSON.stringify(expected) + '\n')
      await claim.sync()
    } finally { await claim.close() }
    await syncDirectory(this.directory)
  }
}
