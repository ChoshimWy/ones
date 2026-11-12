import type { RepairActions } from '../repair-actions.ts'
import { repairProgress, repairValidationSummary, repairAcceptance, isNotApplicable, repairComment } from '../domain/repair-report.ts'
import type { RepairWorkflow, RepairRecord, RepairListItem } from '../repair.ts'
import { button, card, el, message, notice, request, row, select, text, input } from './dom.ts'

export class RepairView {
  readonly element = el('div')
  private disposed = false
  private busy = false
  private record: RepairRecord | null = null
  private result: RepairListItem | null = null
  private readFailed = false
  constructor(private detailId: string, private changed: (busy: boolean, hasRecord: boolean) => void, private updated?: (warning?: string) => Promise<void>) {}
  async load() {
    if (this.busy || this.disposed) return
    this.setBusy(true)
    this.element.replaceChildren(notice('正在读取执行记录…'))
    try {
      const record = await request<RepairRecord | null>('repair.read', { detailId: this.detailId })
      this.result = await request<RepairListItem | null>('repair.result', { detailId: this.detailId })
      if (this.disposed) return
      this.readFailed = false
      this.record = record
      if (record) this.showRecord(record)
      else this.element.replaceChildren()
    } catch (error) {
      if (!this.disposed) {
        this.readFailed = true
        this.element.replaceChildren(notice('执行记录读取失败，暂不可启动修复。' + message(error), true),
          button('重试读取记录', () => this.load()))
      }
    } finally { this.setBusy(false) }
  }
  dispose() { this.disposed = true }
  async open() {
    if (this.busy || this.disposed) return
    if (this.readFailed) { await this.load(); return }
    if (this.record) { this.showRecord(this.record); this.element.scrollIntoView({ block: 'nearest' }); return }
    this.setBusy(true)
    this.element.replaceChildren(notice('正在匹配已有本地项目及检查修复会话…'))
    this.element.scrollIntoView({ block: 'nearest' })
    try {
      const preparation = await request<Awaited<ReturnType<RepairActions['prepare']>>>('repair.prepare', { detailId: this.detailId })
      if (this.disposed) return
      if (preparation.existing) { this.showRecord(preparation.existing); return }
      this.form(preparation)
    } catch (error) {
      if (!this.disposed) this.element.replaceChildren(notice(message(error), true))
    } finally { this.setBusy(false) }
  }
  private setBusy(busy: boolean) {
    this.busy = busy
    if (!this.disposed) this.changed(busy || this.readFailed, this.record !== null)
  }
  /// 表单点击即确认；内部预检成功后串行流转与启动，不再展示二次确认。
  private form(preparation: Awaited<ReturnType<RepairActions['prepare']>>) {
    const mapping=preparation.mapping,status=preparation.status
    let projectId=mapping.kind==='mapped'?mapping.project.id:''
    let agent='codex'
    const fields=Object.fromEntries(status?.route.map(edge=>[edge.step.id,Object.fromEntries(edge.step.fields.map(field=>[field.id,field.value]))])??[])
    const confirmation=el('div','stack')
    const clear=()=>confirmation.replaceChildren()
    const blocked=!status?.writeEnabled||!!(status?.operation&&status.operation.state!=='verified')
    const preview=button('开始修复并更新状态',async()=>{
      if(this.busy||!projectId||this.disposed||blocked)return
      this.setBusy(true)
      // 冻结点击时的字段，并移除可变表单，避免预检期间改变已授权内容。
      const input={preparationId:preparation.id,projectId,agent,fields:structuredClone(fields)}
      this.element.replaceChildren(notice('正在校验并开始修复，请勿重复操作。'))
      let submitting=false
      try{
        const value=await request<Awaited<ReturnType<RepairActions['preview']>>>('repair.previewStart',input)
        if(this.disposed)return
        submitting=true
        const result=await request<RepairRecord>('repair.start',{previewId:value.id,confirmed:true})
        if(!this.disposed){this.showRecord(result);await this.updated?.()}
      }catch(error){
        if(!this.disposed){
          if(submitting){
            const warning=message(error)+' 已成功的远端步骤保留，不会自动回滚或重发未知操作。'
            this.element.replaceChildren(notice(warning,true))
            await this.updated?.(warning)
          }else{
            this.form(preparation)
            this.element.prepend(notice(message(error),true))
          }
        }
      }finally{this.setBusy(false)}
    },!projectId||blocked,'primary')
    const mappingUI=mapping.kind==='mapped'?text(`目标项目：${mapping.project.name}`):select('本地项目','',[{value:'',label:'请选择本地项目'},...mapping.candidates.map(p=>({value:p.id,label:p.name}))],value=>{projectId=value;clear();preview.disabled=!value||blocked})
    const content=card('开始修复并更新状态',mappingUI,select('修复 Agent',agent,[{value:'codex',label:'Codex'},{value:'claude',label:'Claude Code'}],value=>{agent=value;clear()}),text(status?[status.snapshot.task.status.name,...status.route.map(x=>x.step.target.name)].join(' → '):''),notice('状态流转不提交评论。将向 Agent 发送完整 Bug 正文、已有评论与媒体引用；不授权自动提交代码或改变其它状态。核对表单后点击即执行，不再二次确认。'))
    if(status?.operation&&status.operation.state!=='verified'){
      content.append(notice('已有状态结果待核实，不能再次开始修复。',true),button('核对状态结果',async()=>{
        try{await request('bugs.transitionReconcile',{detailId:this.detailId,operationId:status.operation!.id});await this.open()}catch(error){confirmation.replaceChildren(notice(message(error),true))}
      }))
    }
    for(const edge of status?.route??[])for(const field of edge.step.fields){
      const label=`${edge.step.name} · ${field.name}${field.required?' *（必填）':''}`
      const change=(value:string)=>{fields[edge.step.id]![field.id]=value;clear()}
      content.append(field.type===1?select(label,fields[edge.step.id]![field.id]??'',[{value:'',label:'请选择'},...field.options.map(o=>({value:o.id,label:o.name}))],change):input(label,fields[edge.step.id]![field.id]??'',change))
    }
    content.append(preview,confirmation,button('取消',()=>this.element.replaceChildren()))
    this.element.replaceChildren(content)
  }
  private async inspectRestart() {
    if (this.busy || this.disposed) return
    this.setBusy(true)
    const content = card('核对原 Agent 会话', notice('正在核对执行记录…'))
    this.element.replaceChildren(content)
    try {
      const inspection = await request<Awaited<ReturnType<RepairWorkflow['inspectRestart']>>>('repair.inspectRestart', { detailId: this.detailId })
      if (this.disposed) return
      const observation = inspection.observation
      const details = el('details', 'stack', el('summary', '', '历史执行轮次'))
      for (const item of inspection.history) details.append(text(new Date(item.record.createdAt).toLocaleString() + ' · ' + item.record.state), ...(item.record.sessionId ? [text('Session：' + item.record.sessionId)] : []), ...(item.report ? [text(repairComment(item.report))] : []))
      content.replaceChildren(el('h2', '', '核对原 Agent 会话'), notice(observation.reason, observation.state !== 'stopped'), text('项目：' + inspection.record.projectName), ...(inspection.record.sessionId ? [text('Session：' + inspection.record.sessionId)] : []), details)
      if (observation.state === 'running') {
        content.append(notice('原 Agent 仍在运行，请返回原会话；不能重新执行。', true))
      } else {
        let agent = 'codex', reason = '', stoppedConfirmed = observation.state === 'stopped'
        const confirmation = el('div', 'stack')
        const clear = () => confirmation.replaceChildren()
        const check = el('input')
        check.type = 'checkbox'
        check.addEventListener('change', () => { stoppedConfirmed = check.checked; clear() })
        if (observation.state === 'unknown') content.append(
          notice('宿主未自动核实。请在 Orca 中确认原 Agent 已停止或终止；仅关闭窗口不够。同时运行可能造成代码冲突。', true),
          el('label', 'row', check, '我已人工确认原 Agent 停止，不会继续修改项目'),
          input('人工核实依据（至少 4 字）', '', value => { reason = value; clear() }, { maxLength: 500 }))
        content.append(select('重新执行的 Agent', agent, [{value:'codex',label:'Codex'},{value:'claude',label:'Claude Code'}], value => { agent = value; clear() }),
          button('重新执行修复', () => {
            if (this.busy) return
            if (!stoppedConfirmed || observation.state === 'unknown' && reason.trim().length < 4) {
              confirmation.replaceChildren(notice('请确认原 Agent 已停止，并填写人工核实依据。', true)); return
            }
            confirmation.replaceChildren(card('确认重新执行', notice('将创建新会话，保留旧记录和已有代码；重新下载原单附件。新 Agent 必须先检查已有修改。仅在 Bug 仍为“修复中”时继续，不重复更新 ONES 状态。'),
              button('确认创建新修复会话', async () => {
                if (this.busy || this.disposed) return
                this.setBusy(true)
                confirmation.replaceChildren(notice('正在准备新的执行轮次，请勿重复操作。'))
                try {
                  const result = await request<RepairRecord>('repair.restart', { inspectionId: inspection.id, agent, confirmed:true, stoppedConfirmed, reason })
                  if (!this.disposed) { this.result = null; this.showRecord(result); await this.updated?.() }
                } catch (error) {
                  if (!this.disposed) confirmation.replaceChildren(notice(message(error) + ' 请重新读取执行记录；未知启动结果不会自动重发。', true), button('重新读取执行记录', () => this.load()))
                } finally { this.setBusy(false) }
              }, false, 'primary')))
          }, false, 'primary'), confirmation)
      }
      content.append(button('重新核对', () => this.inspectRestart()), button('返回执行记录', () => this.load()))
    } catch (error) {
      if (!this.disposed) content.replaceChildren(notice(message(error),true),button('重新核对',()=>this.inspectRestart()),button('返回执行记录',()=>this.load()))
    } finally { this.setBusy(false) }
  }
  private showRecord(record: RepairRecord) {
    this.record = record
    const status = record.phase === 'failed' ? '上轮准备失败，未调用 Agent；可核对后重新执行。' : record.state === 'sent'
      ? '聊天已创建，消息已写入会话；不代表修复或媒体分析已完成。'
      : record.state === 'terminal'
        ? 'Orca 实际返回了终端而非聊天，可能已发送任务。请到项目核实，不会自动重试。'
        : '启动或消息结果待核实，已阻止重复发送。请到目标项目检查会话。'
    const report=this.result?.report
    const acceptance=repairAcceptance(report)
    const alternative=isNotApplicable(acceptance)?[acceptance.reason,...acceptance.checks.flatMap(check=>[`${check.name}：${check.status}`,...check.evidence])]:[]
    const technical=el('details','stack',el('summary','','技术信息'),...alternative.map(value=>text(value,true)),...(report?.acceptanceEvidence?[text(report.acceptanceEvidence.note,true)]:[]),text(`执行时间：${new Date(record.createdAt).toLocaleString()}`),text(`项目：${record.projectName}`),...(record.sessionId?[text(`Session：${record.sessionId}`)]:[]),...(record.directory?[text(`媒体目录：${record.directory}`,true)]:[]),...(report?[text(`源码身份：${report.sourceIdentity}`,true),...('reportVersion' in report?[report.validation.reason,...report.validation.remaining,report.delivery.note,...report.validation.evidence]:report.evidence).map(value=>text(value,true))]:[]))
    this.element.replaceChildren(card('修复进度',notice(report?repairProgress(report):status,record.state!=='sent'),text(repairValidationSummary(report)),...(report?.acceptanceEvidence?.state==='pending'?[notice(report.acceptanceEvidence.note,true)]:[]),...(report?[text(repairComment(report))]:[]),...(this.result?.reportError?[notice(this.result.reportError,true)]:[]),technical,...(record.phase === 'failed' ? [button('重新准备修复',()=>{this.record=null;return this.open()})] : []),button('核对会话 / 重新执行',()=>this.inspectRestart())))
  }
}
