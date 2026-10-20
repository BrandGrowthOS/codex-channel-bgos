import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),destination=join(root,'vendor/browser-profile')
const value=name=>{const index=process.argv.indexOf(name);if(index<0||!process.argv[index+1])throw Error(`Required ${name}`);return process.argv[index+1]}
const source=resolve(value('--source')),ref=value('--ref'),write=process.argv.includes('--write')
const git=args=>{const result=spawnSync('git',['-C',source,...args],{windowsHide:true,maxBuffer:32*1024*1024});if(result.status!==0)throw Error('Committed browser runtime source unavailable');return result.stdout}
const sourceCommit=git(['rev-parse','--verify',`${ref}^{commit}`]).toString().trim()
if(!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('Exact committed browser runtime required')
const inventory=new Set(git(['ls-tree','-r','--name-only',sourceCommit]).toString().trim().split('\n'))
const read=name=>git(['show',`${sourceCommit}:${name}`]),files={},queue=['bin/hoai-browser-host.mjs'],inventoried=new Set()
const locate=(from,specifier)=>{
  const target=posix.normalize(posix.join(posix.dirname(from),specifier))
  if(target.startsWith('../')||posix.isAbsolute(target))throw Error('Runtime dependency escapes source repository')
  for(const candidate of [target,target+'.js',target+'.mjs',posix.join(target,'index.js')])if(inventory.has(candidate))return candidate
  throw Error(`Missing committed runtime dependency: ${from} -> ${specifier}`)
}
for(let cursor=0;cursor<queue.length;cursor++){
  const name=queue[cursor];if(files[name])continue
  if(Object.keys(files).length>=256||queue.length>65536||!/^((bin|lib)\/.*\.(mjs|cjs|js|json)|package\.json)$/.test(name))throw Error(`Unexpected browser runtime dependency: ${name}`)
  if(name==='package.json')continue
  const bytes=read(name);if(bytes.length>2*1024*1024||bytes.includes(13))throw Error(`Runtime source must be bounded LF bytes: ${name}`)
  files[name]={sha256:createHash('sha256').update(bytes).digest('hex')}
  if(write){const target=join(destination,name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes)}
  else if(!readFileSync(join(destination,name)).equals(bytes))throw Error(`Runtime source differs: ${name}`)
  if(!name.endsWith('.json')){
    const expression=/\b(?:from|import)\s*(?:\(\s*)?['"](\.\.?\/[^'"]+)['"]|\b(?:[A-Za-z_$][\w$]*Require|require)\(\s*['"](\.\.?\/[^'"]+)['"]|\bnew URL\(\s*['"](\.\.?\/[^'"]+\.(?:json|js|cjs|mjs))['"]/g
    for(const match of bytes.toString('utf8').matchAll(expression))queue.push(locate(name,match[1]||match[2]||match[3]))
    for(const boundary of ['lib/browser-host-core','lib/browser-profile-core'])if(name.startsWith(boundary+'/')){
      for(const file of ['package.json','vendor.json'])if(inventory.has(boundary+'/'+file))queue.push(boundary+'/'+file)
      // Worker entry points may be constructed with path.join(__dirname, ...).
      // Their committed core manifest is the authoritative dependency list.
      if(boundary==='lib/browser-profile-core'&&inventory.has(boundary+'/vendor.json')&&!inventoried.has(boundary)){
        inventoried.add(boundary)
        const declared=JSON.parse(read(boundary+'/vendor.json'))
        if(declared?.version!==1||!declared.files||typeof declared.files!=='object'||Array.isArray(declared.files)||Object.keys(declared.files).length<1||Object.keys(declared.files).length>128)throw Error('Invalid committed profile core inventory')
        for(const [file,pin]of Object.entries(declared.files)){
          if(!/^[a-z][a-z0-9-]*\.js$/.test(file)||!pin||typeof pin!=='object'||!/^[a-f0-9]{64}$/.test(pin.sha256)||!inventory.has(boundary+'/'+file))throw Error('Invalid committed profile core dependency')
          if(createHash('sha256').update(read(boundary+'/'+file)).digest('hex')!==pin.sha256)throw Error('Committed profile core pin differs')
          queue.push(boundary+'/'+file)
        }
      }
    }
  }
}
const packageSource=JSON.parse(read('package.json')),boundary=JSON.stringify({private:true,type:'module',version:packageSource.version,license:'Apache-2.0'},null,2)+'\n'
const manifest={version:1,repository:'BrandGrowthOS/bgos-claude-plugin',sourceCommit,entry:'bin/hoai-browser-host.mjs',why:'The same reviewed browser host, profile runtime, encryption and authorization execute for Claude and Codex. Only the Codex daemon launcher is different.',files:Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)))}
if(write){mkdirSync(destination,{recursive:true});writeFileSync(join(destination,'package.json'),boundary);writeFileSync(join(destination,'source.json'),JSON.stringify(manifest,null,2)+'\n')}
else if(readFileSync(join(destination,'package.json'),'utf8')!==boundary||JSON.stringify(JSON.parse(readFileSync(join(destination,'source.json'),'utf8')))!==JSON.stringify(manifest))throw Error('Browser runtime manifest or ESM boundary differs')
console.log(JSON.stringify({mode:write?'copied-committed-runtime':'verified',sourceCommit,files:Object.keys(files).length}))
