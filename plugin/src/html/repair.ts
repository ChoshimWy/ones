import type { RepairActions } from '../repair-actions.ts'
import { repairProgress, repairComment } from '../domain/repair-report.ts'
import type { RepairRecord, RepairListItem } from '../repair.ts'
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
  /// 先预览全部必填条件与项目，唯一确认按钮同时授权合法状态路径与 Agent 启动。
  private form(preparation: Awaited<ReturnType<RepairActions['prepare']>>) {
    const mapping=preparation.mapping,status=preparation.status
    let projectId=mapping.kind==='mapped'?mapping.project.id:''
    let agent='codex'
    const fields=Object.fromEntries(status?.route.map(edge=>[edge.step.id,Object.fromEntries(edge.step.fields.map(field=>[field.id,field.value]))])??[])
    const confirmation=el('div','stack')
    const clear=()=>confirmation.replaceChildren()
    const preview=button('预览开始修复',async()=>{
      if(this.busy||!projectId||this.disposed)return
      this.setBusy(true)
      preview.disabled=true
      try{
        const value=await request<Awaited<ReturnType<RepairActions['preview']>>>('repair.previewStart',{preparationId:preparation.id,projectId,agent,fields})
        if(this.disposed)return
        confirmation.replaceChildren(card('确认开始修复',text(`项目：${value.projectName}`),text([value.status.task.status.name,...value.status.route.map(x=>x.step.target.name)].join(' → ')),...value.status.route.flatMap(x=>x.step.fields.map(f=>text(`${x.step.name} · ${f.name}：${f.options.find(o=>o.id===value.status.fields[x.step.id]![f.id])?.name??(value.status.fields[x.step.id]![f.id]||'（空）')}`))),notice('逐步更新并回读到“修复中”后才创建聊天。状态未知时停止；已成功的远端状态不因聊天启动失败回滚。'),button('开始修复并更新状态',async()=>{
          if(this.busy||this.disposed)return
          this.setBusy(true)
          this.element.replaceChildren(notice('正在执行已确认状态路径，成功后收集最新 Bug 并创建聊天。请勿重复操作。'))
          try{
            const result=await request<RepairRecord>('repair.start',{previewId:value.id,confirmed:true})
            if(!this.disposed){this.showRecord(result);await this.updated?.()}
          }catch(error){if(!this.disposed){const warning=message(error)+' 已成功的远端步骤保留，不会自动回滚或重发未知操作。';this.element.replaceChildren(notice(warning,true));await this.updated?.(warning)}}
          finally{this.setBusy(false)}
        },false,'primary')))
      }catch(error){if(!this.disposed)confirmation.replaceChildren(notice(message(error),true))}
      finally{this.setBusy(false);preview.disabled=!projectId}
    },!projectId||!status?.writeEnabled||!!(status?.operation&&status.operation.state!=='verified'),'primary')
    const mappingUI=mapping.kind==='mapped'?text(`目标项目：${mapping.project.name}`):select('本地项目','',[{value:'',label:'请选择本地项目'},...mapping.candidates.map(p=>({value:p.id,label:p.name}))],value=>{projectId=value;clear();preview.disabled=!value})
    const content=card('开始修复并更新状态',mappingUI,select('修复 Agent',agent,[{value:'codex',label:'Codex'},{value:'claude',label:'Claude Code'}],value=>{agent=value;clear()}),text(status?[status.snapshot.task.status.name,...status.route.map(x=>x.step.target.name)].join(' → '):''),notice('将发送完整 Bug 正文、评论与媒体引用；不授权自动提交代码或改变其它状态。'))
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
  private showRecord(record: RepairRecord) {
    this.record = record
    const status = record.state === 'sent'
      ? '聊天已创建，消息已写入会话；不代表修复或媒体分析已完成。'
      : record.state === 'terminal'
        ? 'Orca 实际返回了终端而非聊天，可能已发送任务。请到项目核实，不会自动重试。'
        : '启动或消息结果待核实，已阻止重复发送。请到目标项目检查会话。'
    const report=this.result?.report
    const technical=el('details','stack',el('summary','','技术信息'),text(`执行时间：${new Date(record.createdAt).toLocaleString()}`),text(`项目：${record.projectName}`),...(record.sessionId?[text(`Session：${record.sessionId}`)]:[]),...(record.directory?[text(`媒体目录：${record.directory}`,true)]:[]),...(report?[text(`源码身份：${report.sourceIdentity}`,true),...('reportVersion' in report?report.validation.evidence:report.evidence).map(value=>text(value,true))]:[]))
    this.element.replaceChildren(card('修复进度',notice(report?repairProgress(report):status,record.state!=='sent'),...(report?[text(repairComment(report))]:[]),...(this.result?.reportError?[notice(this.result.reportError,true)]:[]),technical))
  }
}
