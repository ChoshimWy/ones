import { createHash } from 'node:crypto'
import { requireThat, type Option } from './model.ts'

export type ProjectMapping = { sourceProjectId: string; targetProjectId: string }
export type MappingResult =
  | { kind: 'mapped'; project: Option; via: 'saved' | 'automatic' }
  | { kind: 'manual'; reason: 'missing' | 'ambiguous' | 'target-unavailable'; candidates: Option[] }

// Only normalize presentation differences; never use substring or fuzzy similarity.
export function projectNameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, '').toLowerCase()
}
function undecoratedKey(name: string): string {
  return projectNameKey(name.replace(/(?:\s*【[^【】]+】)+\s*$/u, ''))
}

/** The caller scopes saved mappings by ONES instance, team and authenticated user. */
export function resolveProjectMapping(
  source: Option,
  projects: readonly Option[],
  saved?: ProjectMapping
): MappingResult {
  requireThat(new Set(projects.map(p => p.id)).size === projects.length, 'schema', '本地项目列表存在重复身份。')
  if (saved) {
    requireThat(saved.sourceProjectId === source.id, 'identity', '项目映射不属于当前 ONES 项目。')
    const project = projects.find(p => p.id === saved.targetProjectId)
    // A removed destination must not silently rebind to a namesake.
    return project
      ? { kind: 'mapped', project, via: 'saved' }
      : { kind: 'manual', reason: 'target-unavailable', candidates: [...projects] }
  }
  const key = projectNameKey(source.name)
  const exact = key ? projects.filter(p => projectNameKey(p.name) === key) : []
  const stripped = undecoratedKey(source.name)
  const candidates = exact.length ? exact : stripped
    ? projects.filter(p => undecoratedKey(p.name) === stripped)
    : []
  return candidates.length === 1
    ? { kind: 'mapped', project: candidates[0]!, via: 'automatic' }
    : { kind: 'manual', reason: candidates.length ? 'ambiguous' : 'missing', candidates: candidates.length ? candidates : [...projects] }
}

export function projectMappingKey(scope: string, projectId: string): string {
  return 'repair.mapping.' + createHash('sha256').update(JSON.stringify([scope, projectId])).digest('hex')
}

/** Reverse lookup for the read-only Bug filter; never overwrite a saved association by name. */
export function filterProject(local: Option | null, projects: Option[], bindings: ProjectMapping[]): Option | null {
  if (!local) return null
  const explicit = projects.filter(p => bindings.some(b => b.sourceProjectId === p.id && b.targetProjectId === local.id))
  if (explicit.length) return explicit.length === 1 ? explicit[0]! : null
  const eligible = projects.filter(p => !bindings.some(b => b.sourceProjectId === p.id))
  const result = resolveProjectMapping(local, eligible)
  return result.kind === 'mapped' ? result.project : null
}
