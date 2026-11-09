import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProjectMapping } from '../src/domain/project-mapping.ts'
const source = { id: 'ones-project', name: 'Sidus Link Pro 【IPOT】' }
const local = { id: 'local-project', name: 'SidusLinkPro' }

test('project mapping: unique normalized and decorated names map automatically', () => {
  assert.deepEqual(resolveProjectMapping(source, [local]), { kind: 'mapped', project: local, via: 'automatic' })
  assert.equal(resolveProjectMapping({ ...source, name: ' ＳＩＤＵＳ Link Pro ' }, [local]).kind, 'mapped')
})
test('project mapping: ambiguous, empty and fuzzy-only matches require manual mapping', () => {
  const ambiguous = resolveProjectMapping(source, [local, { id: 'other', name: 'Sidus Link Pro' }])
  assert.equal(ambiguous.kind, 'manual')
  if (ambiguous.kind === 'manual') assert.equal(ambiguous.reason, 'ambiguous')
  for (const name of ['', '【IPOT】', 'Sidus Link', 'Sidus Link Pro Extra'])
    assert.equal(resolveProjectMapping({ ...source, name }, [local]).kind, 'manual')
})
test('project mapping: exact decorated name takes precedence over stripped names', () => {
  const exact = { id: 'exact', name: source.name }
  assert.deepEqual(resolveProjectMapping(source, [local, exact]), { kind: 'mapped', project: exact, via: 'automatic' })
})
test('project mapping: saved stable ids survive renames and do not silently rebind', () => {
  const saved = { sourceProjectId: source.id, targetProjectId: local.id }
  const renamed = { ...local, name: 'Renamed' }
  assert.deepEqual(resolveProjectMapping(source, [renamed], saved), { kind: 'mapped', project: renamed, via: 'saved' })
  const result = resolveProjectMapping(source, [{ ...local, id: 'replacement' }], saved)
  assert.equal(result.kind, 'manual')
  if (result.kind === 'manual') assert.equal(result.reason, 'target-unavailable')
  assert.throws(() => resolveProjectMapping({ ...source, id: 'another-project' }, [local], saved))
})
test('project mapping: duplicate destination ids are rejected', () => {
  assert.throws(() => resolveProjectMapping(source, [local, local]))
})
