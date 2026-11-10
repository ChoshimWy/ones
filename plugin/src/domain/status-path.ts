import { requireThat, type Option } from './model.ts'
import type { TransitionSnapshot, TransitionStep } from '../adapters/ones-transitions.ts'
/// 业务目标仅限定状态名称；具体 ID、路径和字段来自权威项目配置。
export type StatusGoal = '修复中' | '已修复'
export type StatusRoute = { source: Option; step: TransitionStep }[]
/// 选择最短且唯一的可达合法路径；首步必须实时允许，未知约束不绕过。
export function statusPath(snapshot: TransitionSnapshot, goal: StatusGoal): StatusRoute {
  requireThat(snapshot.graph && snapshot.configurationStamp, 'schema', '缺少完整工作流，不能规划业务状态操作。')
  const targets = new Set(snapshot.graph.flatMap(x => [x.source,x.step.target]).filter(x => x.name === goal).map(x=>x.id))
  requireThat(targets.size === 1, 'schema', `无法唯一定位“${goal}”目标状态。`)
  const target = [...targets][0]
  if (snapshot.task.status.id === target) return []
  const paths: StatusRoute[] = []
  const visit = (source: string, path: StatusRoute, seen: Set<string>) => {
    if (path.length >= 8 || paths.length > 100) return
    for (const edge of snapshot.graph!) {
      if (edge.source.id !== source || edge.step.blockers.length || seen.has(edge.step.target.id)) continue
      if (!path.length && !snapshot.steps.some(x=>x.id===edge.step.id && !x.blockers.length)) continue
      const next = [...path,edge]
      if (edge.step.target.id === target) paths.push(next)
      else visit(edge.step.target.id,next,new Set([...seen,edge.step.target.id]))
    }
  }
  visit(snapshot.task.status.id,[],new Set([snapshot.task.status.id]))
  requireThat(paths.length > 0 && paths.length <= 100, 'schema', `没有可安全执行到“${goal}”的完整路径；请检查权限、条件和字段配置。`)
  const shortest = Math.min(...paths.map(x=>x.length))
  const choices = paths.filter(x=>x.length===shortest)
  requireThat(choices.length === 1, 'schema', '存在多条同长度业务路径，不能自动选择。')
  return choices[0]!
}
