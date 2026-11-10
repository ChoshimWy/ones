import type { StatusWorkflow, BusinessPreview, BusinessResult, StatusResult } from '../status-update.ts'
import { button, card, check, el, input, message, notice, request, row, select, text } from './dom.ts'

/// 面向“更新为已修复”的单次业务确认，不要求用户逐步提交工作流。
export class StatusView {
  readonly element = el('div', 'stack')
  private options?: Awaited<ReturnType<StatusWorkflow['businessOptions']>>
  private fields: Record<string,Record<string,string>> = {}
  private comment = ''
  private noUnitTestsConfirmed = false
  private preview?: BusinessPreview
  private expanded = false
  private busy = false
  private disposed = false
  private error = ''
  constructor(private detailId: string, private availability: (disabled:boolean,reason:string)=>void, private updated:()=>Promise<void>,private closed:()=>void) {}
  dispose(): void {this.disposed=true;this.element.replaceChildren()}
  /// 结构化三项填入可编辑评论；验证门槛仍由 Worker 原始报告决定。
  async load(): Promise<void> {
    this.busy=true
    this.options=undefined
    try {
      const options = await request<Awaited<ReturnType<StatusWorkflow['businessOptions']>>>('bugs.businessOptions',{detailId:this.detailId})
      if(this.disposed) return
      this.options=options
      this.fields=Object.fromEntries(options.route.map(edge=>[edge.step.id,Object.fromEntries(edge.step.fields.map(field=>[field.id,field.value]))]))
      this.comment=options.comment??''
      this.noUnitTestsConfirmed=false
      this.availability(false,'')
      this.error=''
    } catch(error) { if(!this.disposed){this.error=message(error);this.availability(false,'状态配置暂不可用，可打开查看原因。')} }
    finally {if(!this.disposed){this.busy=false;this.render()}}
  }
  open(): void {this.expanded=true;this.render();this.element.querySelector<HTMLElement>('select,textarea,button')?.focus()}
  private invalidate(): void {this.preview=undefined;this.element.querySelector('[data-status-preview]')?.remove()}
  private async act(action:()=>Promise<void>):Promise<void>{
    if(this.busy||this.disposed)return
    this.busy=true;this.error='';this.render()
    try{await action()}catch(error){if(!this.disposed)this.error=message(error)}
    finally{if(!this.disposed){this.busy=false;this.render()}}
  }
  /// 字段按每步真实 ID 分组，不把三项说明擅自映射到 custom 字段。
  private render():void{
    this.element.replaceChildren()
    if(!this.expanded)return
    if(this.error)this.element.append(notice(this.error,true),button('重新读取',()=>this.load(),this.busy))
    if(!this.options)return
    const options=this.options, operation=options.operation
    const content=card('更新为已修复',text(`当前：${options.snapshot.task.status.name}`),text(options.route.length ? [options.snapshot.task.status.name,...options.route.map(x=>x.step.target.name)].join(' → ') : '已处于目标状态，无需流转'))
    if(operation){
      content.append(notice(operation.state==='verified' ? `已核实${operation.business ? `第 ${operation.business.index}/${operation.business.total} 步` : '上次状态操作'}` : '上次状态操作结果待核实，不会自动重发。',operation.state!=='verified'))
      if(operation.state!=='verified')content.append(button('核对结果',()=>this.act(async()=>{
        const result=await request<StatusResult>('bugs.transitionReconcile',{detailId:this.detailId,operationId:operation.id})
        if(result.state==='verified')await this.updated()
        else this.error=result.evidence?.message??'结果仍待核实，禁止重发。'
      }),this.busy))
    }
    content.append(notice(options.validationSummary,!!options.completionBlocker))
    if(options.completionBlocker.startsWith('代码修复'))content.append(notice(options.completionBlocker,true))
    if(options.acceptanceNote)content.append(el('details','stack',el('summary','','验收依据'),text(options.acceptanceNote,true)))
    if(options.noUnitTestsConfirmationRequired){
      const acceptance=options.acceptance
      if(acceptance && 'applicability' in acceptance)content.append(text(`不适用原因：${acceptance.reason}`,true),el('details','stack',el('summary','','替代检查记录'),...acceptance.checks.flatMap(item=>[text(`${item.name}：${item.status}`,true),...item.evidence.map(value=>text(value,true))])))
      content.append(check('我确认本次无需单元测试，替代检查已完成',this.noUnitTestsConfirmed,value=>{this.noUnitTestsConfirmed=value;this.invalidate();this.render()},this.busy || !!options.completionBlocker))
    }
    content.append(text('三项简述自动填入评论，可编辑；不会覆盖原始描述。单元测试或替代检查结果独立保留，完成并确认后才可更新为已修复。',true))
    for(const edge of options.route){
      if(edge.step.fields.length)content.append(text(`${edge.source.name} → ${edge.step.target.name} 所需字段`))
      for(const field of edge.step.fields){
        const label=`${edge.step.name} · ${field.name}${field.required?' *（必填）':''}`
        const change=(value:string)=>{this.fields[edge.step.id]![field.id]=value;this.invalidate()}
        content.append(field.type===1?select(label,this.fields[edge.step.id]![field.id]??'',[{value:'',label:'请选择'},...field.options.map(x=>({value:x.id,label:x.name}))],change,this.busy):input(label,this.fields[edge.step.id]![field.id]??'',change,{disabled:this.busy}))
      }
    }
    const summary = input('修复说明（三项，可编辑）',this.comment,value=>{this.comment=value;this.invalidate()},{multiline:true,disabled:this.busy,maxLength:12000})
    summary.classList.add('repair-summary')
    content.append(summary)
    content.append(button('预览状态更新',()=>this.act(async()=>{
      this.preview=await request<BusinessPreview>('bugs.businessPreview',{detailId:this.detailId,fields:this.fields,comment:this.comment,noUnitTestsConfirmed:this.noUnitTestsConfirmed})
    }),this.busy||!!options.completionBlocker||(options.noUnitTestsConfirmationRequired&&!this.noUnitTestsConfirmed)||!!(operation&&operation.state!=='verified')||!options.route.length))
    if(this.preview){
      const preview=this.preview
      const confirmation=card('确认一次完成状态更新',text([preview.task.status.name,...preview.route.map(x=>x.step.target.name)].join(' → ')),...preview.route.flatMap(x=>x.step.fields.map(f=>text(`${x.step.name} · ${f.name}：${f.options.find(o=>o.id===f.value)?.name??(f.value||'（空）')} → ${f.options.find(o=>o.id===preview.fields[x.step.id]![f.id])?.name??(preview.fields[x.step.id]![f.id]||'（空）')}`))),text(preview.comment??''),notice('每步回读成功才继续；部分成功保留，未知结果停止，不回滚已成功步骤。'),button('确认更新为已修复',()=>this.act(async()=>{
        this.preview=undefined
        try{
          const result=await request<BusinessResult>('bugs.businessSubmit',{previewId:preview.id,confirmed:true})
          if(result.state==='verified')await this.updated()
          else {await this.load();this.error='状态结果待核实，已停止后续步骤。'}
        }catch(error){await this.load();throw error}
      }),this.busy||!options.writeEnabled,'primary'))
      confirmation.dataset.statusPreview='true'
      content.append(confirmation)
    }
    if(this.busy)content.append(notice('正在处理；离页不会撤销已发送步骤。'))
    content.append(row(button('收起状态表单',()=>{this.expanded=false;this.render();this.closed()},this.busy)))
    this.element.append(content)
  }
}
