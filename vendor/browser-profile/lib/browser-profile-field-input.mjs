import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'

const require=createRequire(import.meta.url),policy=require('./browser-host-core/policy.js')
const fail=code=>Object.assign(new Error(code),{code})
const METHODS=new Set(['browser_type','browser_fill_form']),MAX_FIELDS=32,MAX_VALUE=16384,MAX_TOTAL=65536,GLOBAL_LIMIT=8
const BUNDLE='829521b67ed7be90c7d6d6098ff39f2241562d47e4ad7ccab13710924a56001d'
const leases=new Set()
let qualified=false
const synchronous=callback=>{const result=callback();if(result?.then){void Promise.resolve(result).catch(()=>{});throw fail('profile_field_context_changed')}if(result===false)throw fail('profile_field_context_changed')}
function exact(value,required,optional=[]){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)throw fail('profile_field_arguments_invalid')
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors)
  if(required.some(key=>!Object.hasOwn(descriptors,key))||keys.some(key=>typeof key!=='string'||![...required,...optional].includes(key)||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value')))throw fail('profile_field_arguments_invalid')
}
function argumentsFor(name,args){
  if(!METHODS.has(name))throw fail('profile_field_handover_required')
  let fields
  if(name==='browser_type'){
    exact(args,['target','text'],['element','submit','slowly'])
    if(['submit','slowly'].some(key=>Object.hasOwn(args,key)&&args[key]!==false))throw fail('profile_field_handover_required')
    fields=[{target:args.target,element:args.element,value:args.text}]
  }else{
    exact(args,['fields'])
    const array=args.fields
    if(!Array.isArray(array)||array.length<1||array.length>MAX_FIELDS||Reflect.ownKeys(array).length!==array.length+1)throw fail('profile_field_arguments_invalid')
    fields=[]
    for(let index=0;index<array.length;index++){
      const descriptor=Object.getOwnPropertyDescriptor(array,String(index));if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw fail('profile_field_arguments_invalid')
      const field=descriptor.value;exact(field,['target','name','type','value'],['element'])
      if(field.type!=='textbox'||typeof field.name!=='string'||field.name.length>512)throw fail('profile_field_handover_required')
      fields.push({target:field.target,element:field.element??field.name,value:field.value})
    }
  }
  if(fields.some(field=>typeof field.target!=='string'||!/^(?:f[0-9]{1,8})?e[0-9]{1,8}$/.test(field.target)||field.element!==undefined&&(typeof field.element!=='string'||field.element.length>512)||typeof field.value!=='string'||Buffer.byteLength(field.value)>MAX_VALUE||field.value.includes('\0'))||new Set(fields.map(field=>field.target)).size!==fields.length||fields.reduce((sum,field)=>sum+Buffer.byteLength(field.value),0)>MAX_TOTAL)throw fail('profile_field_arguments_invalid')
  if(policy.isCredential(name,args))throw fail('profile_field_handover_required')
  return{fields,wire:JSON.stringify(args)}
}
function qualify(){
  if(qualified)return
  const bundle=require.resolve('playwright-core/lib/coreBundle')
  if(require('playwright-core/package.json').version!=='1.64.1'||createHash('sha256').update(readFileSync(bundle)).digest('hex')!==BUNDLE)throw fail('profile_field_native_unqualified')
  qualified=true
}

// These fixed functions execute only in Playwright's clean utility world. No
// caller expression or arbitrary script enters this lane.
export function preparePlaintextTicket({documentURL,fields,remainingMs}){
  const native={tag:Object.getOwnPropertyDescriptor(Element.prototype,'tagName').get,type:Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'type').get,get:Element.prototype.getAttribute,rects:Element.prototype.getClientRects,byId:Document.prototype.getElementById,elements:Object.getOwnPropertyDescriptor(HTMLFormElement.prototype,'elements').get,connected:Object.getOwnPropertyDescriptor(Node.prototype,'isConnected').get,owner:Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get,text:Object.getOwnPropertyDescriptor(Node.prototype,'textContent').get,inputSet:Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set,areaSet:Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set,dispatch:EventTarget.prototype.dispatchEvent,Event,now:Date.now}
  const denied=/(?:password|passwd|passcode|one[-_ ]?time|\botp\b|\btotp\b|verification|security.?code|\bpin\b|\bcvv\b|\bcvc\b|payment|\bcard\b|credit.?card|card.?number|\bcc-|token|secret|recovery|seed.?phrase|mnemonic)/i
  const known=/^(?:q|query|search(?: query)?|title|subject|description|notes?|comments?|message|(?:first |last |full )?name|company|city)(?: (?:text|field|input))?$/
  const attribute=(node,name)=>native.get.call(node,name)||''
  const formOf=node=>node.form||null
  const labelsOf=node=>{
    const labels=node.labels||[];if(labels.length>8)return null
    const labelledBy=attribute(node,'aria-labelledby');if(labelledBy.length>2048)return null
    const text=[...labels].map(label=>native.text.call(label)||''),ids=labelledBy.trim().split(/\s+/).filter(Boolean)
    if(ids.length>8)return null
    for(const id of ids){const label=native.byId.call(document,id);if(!label)return null;text.push(native.text.call(label)||'')}
    return text.some(value=>value.length>256)?null:text
  }
  const classify=node=>{
    if(!node||native.owner.call(node)!==document||!native.connected.call(node)||node.disabled||node.readOnly||!native.rects.call(node).length)return null
    const tag=native.tag.call(node),type=tag==='INPUT'?native.type.call(node):null,attrs=['id','name','autocomplete','aria-label','placeholder','is'].map(key=>attribute(node,key))
    if(!['INPUT','TEXTAREA'].includes(tag)||attrs.some(value=>value.length>256)||attrs[5]||tag==='INPUT'&&!['text','search','email','url','tel'].includes(type))return null
    const labelText=labelsOf(node);if(!labelText)return null
    const form=formOf(node),formAttrs=form?['id','name','aria-label'].map(key=>attribute(form,key)):[]
    if(attrs.some(value=>value.length>256)||labelText.some(value=>value.length>256)||formAttrs.some(value=>value.length>256)||attrs[5]||denied.test([...attrs,...labelText,...formAttrs].join(' ')))return null
    if(form){const controls=native.elements.call(form);if(controls.length>128)return null;for(const field of controls){const properties=['id','name','autocomplete','aria-label','placeholder'].map(key=>attribute(field,key));const labels=labelsOf(field);if(!labels||properties.some(value=>value.length>256)||native.tag.call(field)==='INPUT'&&native.type.call(field)==='password'||denied.test([...properties,...labels].join(' ')))return null}}
    if(!['search','email','url','tel'].includes(type)&&![attrs[0],attrs[1],attrs[3],attrs[4],...labelText].some(value=>known.test(value.trim().toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' '))))return null
    return JSON.stringify([tag,type,attrs,labelText,formAttrs])
  }
  if(location.href!==documentURL||window.top!==window||fields.length<1||fields.length>32||!Number.isSafeInteger(remainingMs)||remainingMs<1||remainingMs>60000)return null
  const rows=fields.map(node=>({node,form:formOf(node),signature:classify(node)}))
  if(rows.some(row=>!row.signature)||new Set(fields).size!==fields.length)return null
  const started=native.now();return{document,documentURL,rows,native,classify,formOf,started,expiresAt:started+remainingMs,consumed:false}
}
export function applyPlaintextTicket(ticket,values){
  if(!ticket||ticket.consumed)return{state:'refused'}
  ticket.consumed=true
  let dispatched=false
  try{
    const check=()=>ticket.native.now()>=ticket.started&&ticket.native.now()<ticket.expiresAt&&ticket.document===document&&location.href===ticket.documentURL&&ticket.rows.every(row=>row.form===ticket.formOf(row.node)&&row.signature===ticket.classify(row.node))
    if(!check()||values.length!==ticket.rows.length||values.some(value=>typeof value!=='string'||value.length>16384))return{state:'refused'}
    for(let index=0;index<ticket.rows.length;index++){
      const node=ticket.rows[index].node,setter=ticket.native.tag.call(node)==='INPUT'?ticket.native.inputSet:ticket.native.areaSet
      dispatched=true;setter.call(node,values[index])
    }
    for(const row of ticket.rows){
      if(!check())return{state:'outcome-unknown'}
      ticket.native.dispatch.call(row.node,new ticket.native.Event('input',{bubbles:true}))
      if(!check())return{state:'outcome-unknown'}
      ticket.native.dispatch.call(row.node,new ticket.native.Event('change',{bubbles:true}))
      if(!check())return{state:'outcome-unknown'}
    }
    return{state:'applied',fields:ticket.rows.length}
  }catch{return{state:dispatched?'outcome-unknown':'refused'}}
}

/** Trusted agent main only. A capability never crosses an RPC or renderer. */
export class AgentProfileFieldInput{
  #records=new Map()
  #physical=new Set()
  #disposed=false
  #cleanupUnknown=false
  #writeUnknown=false
  constructor({engine,runtime,assertCurrent,now=Date.now}){
    if(!engine||!runtime||typeof assertCurrent!=='function'||typeof now!=='function')throw fail('profile_field_configuration_invalid')
    Object.defineProperties(this,{engine:{value:engine},runtime:{value:runtime},assertCurrent:{value:assertCurrent},now:{value:now}})
  }
  activity(){return{pendingPhysicalOperations:this.#physical.size+[...this.#records.values()].filter(record=>record.lease).length,cleanupUnknown:this.#cleanupUnknown,outcomeUnknown:this.#writeUnknown}}
  /** @template T @param {()=>T|Promise<T>} callback @returns {Promise<T>} */
  #track(callback){const task=Promise.resolve().then(callback);this.#physical.add(task);void task.finally(()=>this.#physical.delete(task)).catch(()=>{});return task}
  #check(record){
    synchronous(this.assertCurrent);record.signal.throwIfAborted();const now=this.now()
    if(this.#disposed||this.#cleanupUnknown||this.#writeUnknown||record.cancelled||!Number.isSafeInteger(now)||now<record.started||now>=record.deadline||record.changed||this.runtime!==record.runtime||this.engine!==record.engine||this.engine.selectedPage()!==record.page||record.page.isClosed()||record.page.url()!==record.url||this.engine._backend!==record.backend||record.backend._context!==record.context||record.context.currentTab()!==record.tab||record.tab.page!==record.page)throw fail('profile_field_context_changed')
  }
  async #cleanup(record){
    if(record.cleaning)return record.cleaning
    const task=this.#track(async()=>{
      await Promise.allSettled([record.producer,record.execution].filter(Boolean))
      const work=[]
      if(record.ticket)work.push(()=>record.ticket.dispose())
      for(const handle of record.handles)work.push(()=>handle.dispose())
      for(const event of record.listeners)work.push(()=>synchronous(()=>record.page.removeListener(event,record.changedListener)))
      const results=await Promise.allSettled(work.map(callback=>Promise.resolve().then(callback)));record.values.length=0;record.wire=''
      if(results.some(result=>result.status==='rejected')){this.#cleanupUnknown=true;throw fail('profile_field_cleanup_unconfirmed')}
      if(record.lease){leases.delete(record.lease);record.lease=null}this.#records.delete(record.token)
    });record.cleaning=task;void task.catch(()=>{});return task
  }
  async prepare({name,args,signal,deadlineAt}){
    const parsed=argumentsFor(name,args),started=this.now(),deadline=Math.min(started+60000,Date.parse(deadlineAt))
    if(typeof signal?.throwIfAborted!=='function'||!Number.isSafeInteger(started)||started<0||!Number.isSafeInteger(deadline)||deadline<=started)throw fail('profile_field_context_changed')
    synchronous(this.assertCurrent);signal.throwIfAborted()
    if(this.#disposed||this.#cleanupUnknown||this.#writeUnknown||this.#records.size||leases.size>=GLOBAL_LIMIT)throw fail('profile_field_unavailable')
    qualify()
    const page=this.engine.selectedPage(),backend=this.engine._backend,context=backend?._context,tab=context?.currentTab()
    if(!page||tab?.page!==page||typeof page.url!=='function'||typeof page.isClosed!=='function'||typeof page.on!=='function'||typeof page.removeListener!=='function'||typeof tab.targetLocator!=='function')throw fail('profile_field_native_unqualified')
    const token=Object.freeze(Object.create(null)),lease={},record={token,lease,name,wire:parsed.wire,values:parsed.fields.map(field=>field.value),started,deadline,signal,page,url:page.url(),backend,context,tab,runtime:this.runtime,engine:this.engine,handles:[],ticket:null,listeners:[],changed:false,changedListener:null,used:false,cancelled:false,cleaning:null,producer:null,execution:null}
    record.changedListener=()=>{record.changed=true};leases.add(lease);this.#records.set(token,record)
    const producer=this.#track(async()=>{
        for(const event of ['framenavigated','close','crash']){record.listeners.push(event);synchronous(()=>page.on(event,record.changedListener))}
        this.#check(record)
        for(const field of parsed.fields){const target=await tab.targetLocator({target:field.target,...(field.element!==undefined?{element:field.element}:{})});this.#check(record);const handle=await target.locator.elementHandle({timeout:Math.min(5000,Math.max(1,deadline-this.now()))});if(handle)record.handles.push(handle);this.#check(record);if(!handle)throw fail('profile_field_native_unqualified')}
        const connection=page._connection
        if(typeof connection?.toImpl!=='function')throw fail('profile_field_native_unqualified')
        const nativePage=connection.toImpl(page),nativeFrame=nativePage?.mainFrame?.()
        if(!nativeFrame)throw fail('profile_field_native_unqualified')
        const fields=record.handles.map(handle=>{if(handle._connection!==connection)throw fail('profile_field_native_unqualified');const native=connection.toImpl(handle);if(native?._page!==nativePage||native?._frame!==nativeFrame)throw fail('profile_field_native_unqualified');return native})
        const utility=await nativeFrame.utilityContext();this.#check(record)
        if(utility?.world!=='utility'||typeof utility.evaluateHandle!=='function')throw fail('profile_field_native_unqualified')
        record.ticket=await utility.evaluateHandle(preparePlaintextTicket,{documentURL:record.url,fields,remainingMs:Math.max(1,Math.min(60000,deadline-this.now()))});this.#check(record)
        if(!record.ticket||await record.ticket.evaluate(value=>value===null)){this.#check(record);throw fail('profile_field_handover_required')}
        this.#check(record);return token
    });record.producer=producer
    try{return await producer}catch(error){await this.#cleanup(record);if(error?.code?.startsWith('profile_field_'))throw error;throw fail('profile_field_unavailable')}
  }
  async execute({capability,name,args,signal}){
    const record=this.#records.get(capability)
    if(!record||record.used||record.name!==name||record.signal!==signal)throw fail('profile_field_context_changed')
    record.used=true
    try{if(argumentsFor(name,args).wire!==record.wire)throw fail('profile_field_context_changed')}catch{await this.cancel(capability);throw fail('profile_field_context_changed')}
    const execution=this.#track(async()=>{
      let dispatched=false
      try{
        this.#check(record);dispatched=true
        const result=await record.ticket.evaluate(applyPlaintextTicket,record.values)
        if(result?.state==='outcome-unknown'||!['applied','refused'].includes(result?.state)){this.#writeUnknown=true;throw fail('profile_field_outcome_unknown')}
        if(result.state==='refused')throw fail('profile_field_handover_required')
        if(result.fields!==record.values.length){this.#writeUnknown=true;throw fail('profile_field_outcome_unknown')}
        this.#check(record)
        return{content:[{type:'text',text:record.name==='browser_type'?'Entered text in the approved page field.':`Filled ${result.fields} approved page fields.`}]}
      }catch(error){if(dispatched&&error?.code!=='profile_field_handover_required'){this.#writeUnknown=true;throw fail('profile_field_outcome_unknown')}if(error?.code?.startsWith('profile_field_'))throw error;throw fail('profile_field_context_changed')}
    });record.execution=execution
    try{return await execution}finally{await this.#cleanup(record)}
  }
  async cancel(capability){const record=this.#records.get(capability);if(record){record.used=true;record.cancelled=true;await this.#cleanup(record)}}
  async whenDrained(){
    while(this.#physical.size)await Promise.allSettled([...this.#physical]);if(this.#cleanupUnknown||[...this.#records.values()].some(record=>record.lease))throw fail('profile_field_cleanup_unconfirmed')
  }
  async dispose(){
    this.#disposed=true;const results=await Promise.allSettled([...this.#records.values()].map(record=>{record.used=true;record.cancelled=true;return this.#cleanup(record)}));await this.whenDrained();if(results.some(result=>result.status==='rejected'))throw fail('profile_field_cleanup_unconfirmed')
  }
}
