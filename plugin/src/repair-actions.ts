import { randomUUID } from 'node:crypto'
import { requireThat } from './domain/model.ts'
import type { RepairWorkflow } from './repair.ts'
import type { StatusWorkflow, BusinessPreview } from './status-update.ts'
/// 协调一次业务确认；不拥有第二份状态账本或防重锁。
export class RepairActions {
  /// 仅保存未确认预览，持久结果仍归 StatusJournal 和修复启动账本。
  private plans = new Map<string,{input:{preparationId:string;projectId:string;agent:string};target:Awaited<ReturnType<RepairWorkflow['preflight']>>['target'];status:BusinessPreview}>()
  constructor(private repair: RepairWorkflow, private statuses: StatusWorkflow) {}
  /// 一次展示整条状态路径和所有必填字段，旧启动记录仍阻止重复创建聊天。
  async prepare(detailId: string) {
    const preparation = await this.repair.prepare(detailId)
    return {...preparation,status:preparation.existing ? null : await this.statuses.businessOptions(detailId,'修复中')}
  }
  /// 先预检项目 CLI，再验证整条状态路径；此阶段不写 ONES。
  async preview(input: {preparationId:string;projectId:string;agent:string;fields:Record<string,Record<string,string>>}) {
    const context = await this.repair.preflight(input)
    const status = await this.statuses.businessPreview({detailId:context.detailId,goal:'修复中',fields:input.fields,comment:null})
    requireThat(status.task.id===context.task.id,'identity','修复与状态目标不一致。')
    for (const [key,plan] of this.plans) if (plan.status.expiresAt <= Date.now()) this.plans.delete(key)
    requireThat(this.plans.size<50,'busy','待确认修复过多。')
    const id = randomUUID()
    this.plans.set(id,{input:{preparationId:input.preparationId,projectId:input.projectId,agent:input.agent},target:context.target,status})
    return {id,status,projectName:context.target.name}
  }
  /// 明确确认后先逐步流转；未知结果零 Agent 启动，远端成功不自动回滚。
  async start(id: string, confirmed: boolean) {
    requireThat(confirmed===true,'confirm','请确认开始修复并更新状态。')
    const plan = this.plans.get(id)
    requireThat(plan && plan.status.expiresAt>Date.now(),'stale','开始修复预览已失效，请重新预览。')
    this.plans.delete(id)
    return this.repair.start({...plan.input,confirmed:true},{target:plan.target,targetStatus:plan.status.route.at(-1)?.step.target.id ?? plan.status.task.status.id,beforeCollect:async()=>{
      const result = await this.statuses.businessSubmit(plan.status.id,true,'修复中')
      requireThat(result.state==='verified','pending','状态更新结果待核实，尚未启动 Agent。请先核对状态操作，不要重复提交。')
    }})
  }
}
