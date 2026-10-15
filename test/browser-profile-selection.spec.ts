import {it as test} from 'vitest'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {PlaywrightEngine,loadPlaywright} from '../vendor/browser-profile/bin/hoai-browser-host.mjs'

async function fixture(){
  const selected:unknown[]=[],browser=new EventEmitter(),first:any=new EventEmitter(),second:any=new EventEmitter(),native:any=new EventEmitter()
  for(const page of [first,second])Object.assign(page,{consoleMessages:async()=>[],pageErrors:async()=>[],requests:async()=>[],bringToFront:async()=>{selected.push(page)}})
  native.pages=()=>[first,second];native.browser=()=>browser;native.newPage=()=>{throw Error('must not create a replacement page')}
  const {tools}=loadPlaywright(),backend=new tools.BrowserBackend({},native,[]);await backend.initialize({cwd:process.cwd(),name:'fixture',version:'1'})
  let current=true;const engine:any=new PlaywrightEngine({endpoint:null,caps:[],outputDir:process.cwd(),clientName:'fixture',clientVersion:'1',managedRuntime:{assertCurrent(){if(!current)throw Error('fixture_authority_revoked')}}})
  engine._backend=backend;engine._context=native
  return{engine,backend,first,second,selected,revoke:()=>{current=false},dispose:()=>backend.dispose()}
}

test('selects the exact restored page through the actual lazy pinned MCP backend without creating a page',async()=>{
  const f=await fixture();try{assert.deepEqual(f.backend._context.tabs(),[]);await f.engine.selectPage(f.first);assert.equal(f.engine.selectedPage(),f.first);assert.deepEqual(f.selected,[f.first]);assert.deepEqual(f.backend._context.tabs().map((tab:any)=>tab.page),[f.first,f.second]);await f.engine.selectPage(f.second);assert.equal(f.engine.selectedPage(),f.second);assert.deepEqual(f.selected,[f.first,f.second])}finally{await f.dispose()}
})

test('rejects a foreign page after actual lazy inventory initialization without selecting another page',async()=>{
  const f=await fixture();try{await assert.rejects(f.engine.selectPage(new EventEmitter()),/Browser tab is unavailable/);assert.deepEqual(f.selected,[])}finally{await f.dispose()}
})

test('refuses an inactive managed authority before initializing the backend',async()=>{
  const f=await fixture();try{f.revoke();await assert.rejects(f.engine.selectPage(f.first),/fixture_authority_revoked/);assert.deepEqual(f.backend._context.tabs(),[]);assert.deepEqual(f.selected,[])}finally{await f.dispose()}
})

test('does not select after authority is revoked while actual lazy initialization is held',async()=>{
  const f=await fixture();let release!:()=>void;try{const original=f.backend._context.ensureBrowserContext.bind(f.backend._context);f.backend._context.ensureBrowserContext=async()=>{await new Promise<void>(resolve=>{release=resolve});return original()};const pending=f.engine.selectPage(f.first);f.revoke();release();await assert.rejects(pending,/fixture_authority_revoked/);assert.deepEqual(f.selected,[])}finally{await f.dispose()}
})

test('refuses a replaced backend after original lazy initialization settles',async()=>{
  const f=await fixture();let release!:()=>void;try{const original=f.backend._context.ensureBrowserContext.bind(f.backend._context);f.backend._context.ensureBrowserContext=async()=>{await new Promise<void>(resolve=>{release=resolve});return original()};const pending=f.engine.selectPage(f.first);f.engine._backend={_context:{}};release();await assert.rejects(pending,/Browser tab is unavailable/);assert.deepEqual(f.selected,[])}finally{await f.dispose()}
})

test('refuses lost authority after the exact native tab selection settles',async()=>{
  const f=await fixture();let release!:()=>void;try{f.first.bringToFront=()=>new Promise<void>(resolve=>{release=resolve});const pending=f.engine.selectPage(f.first);await new Promise(resolve=>setImmediate(resolve));f.revoke();release();await assert.rejects(pending,/fixture_authority_revoked/)}finally{await f.dispose()}
})

test('does not report success if the backend selects a different page',async()=>{
  const f=await fixture();try{const original=f.backend._context.selectTab.bind(f.backend._context);f.backend._context.selectTab=()=>original(1);await assert.rejects(f.engine.selectPage(f.first),/Browser tab is unavailable/);assert.deepEqual(f.selected,[f.second])}finally{await f.dispose()}
})
