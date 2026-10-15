import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
// Run only in an isolated, quiescent worktree. Every direct executable edit is
// restored in finally and checked byte-for-byte before its green rerun.
const drills=[
 {name:'synchronous-revoke-generation',file:'src/browser-profile-host.ts',before:'revoke():Promise<void>{this.generation++;',after:'revoke():Promise<void>{this.generation+=0;',test:'test/browser-profile-host.spec.ts',pattern:'invalidates authorization awaiting'},
 {name:'same-config-confirmed-reconnect',file:'src/browser-profile-host.ts',before:'this.record?.hash===hash&&this.record.state!=="stopped"',after:'this.record?.hash===hash',test:'test/browser-profile-host.spec.ts',pattern:'allows a fresh authorized'},
 {name:'positive-receipt-after-exit',file:'src/browser-profile-host.ts',before:'),row.receipt])',after:'),Promise.resolve()])',test:'test/browser-profile-host.spec.ts',pattern:'waits for the requested receipt'},
 {name:'private-host-environment',file:'src/browser-profile-host.ts',before:'const env=await this.environment();current();',after:'const env=this.options.environment??process.env;current();',test:'test/browser-profile-host.spec.ts',pattern:'sanitized child environment'},
 {name:'retain-partial-start-ownership',file:'runtime/browser-profile-host.mjs',before:'host=create({config,environment,log:()=>{}});host.start();',after:'host=create({config,environment,log:()=>{}}).start();',test:'test/browser-profile-child.spec.ts',pattern:'partial start failure'},
 {name:'parent-process-binding',file:'runtime/browser-profile-host.mjs',before:'if(config.parentPid!==process.ppid)throw fail()',after:'if(false)throw fail()',test:'test/browser-profile-child.spec.ts',pattern:'unrelated parent'},
 {name:'retained-legacy-stop',file:'runtime/browser-profile-host.mjs',before:'slot.starting||slot.stopping||slot.stopError',after:'slot.starting||slot.stopping',test:'test/browser-profile-child.spec.ts',pattern:'real legacy starts'},
 {name:'configuration-data-properties',file:'runtime/browser-profile-configuration.mjs',before:"if(fields.some(key=>!data[key]?.enumerable||!Object.hasOwn(data[key],'value')))throw fail()",after:'if(false)throw fail()',test:'test/browser-profile-host.spec.ts',pattern:'does not forward arbitrary'},
 {name:'real-adapter-configure',file:'src/adapter.ts',before:'await this.synchronizeBrowserProfiles();',after:'await Promise.resolve();',test:'test/browser-profile-adapter.spec.ts',pattern:'starts the common child'},
 {name:'late-identity-response',file:'src/adapter.ts',before:'if (this.fatalLatched || generation !== this.browserScopeGeneration || token !== this.currentToken) return false;',after:'if (false) return false;',test:'test/browser-profile-adapter.spec.ts',pattern:'stale whoami response'},
 {name:'unsuccessful-daemon-shutdown',file:'src/daemon-shutdown.ts',before:'report("daemon_cleanup_unconfirmed");return 1',after:'report("daemon_cleanup_unconfirmed");return 0',test:'test/browser-profile-child.spec.ts',pattern:'does not report exit zero'},
 {name:'bounded-public-pin-document',file:'src/browser-profile-setup.ts',before:'info.size>8192',after:'info.size>1048576',test:'test/browser-profile-setup.spec.ts',pattern:'bounded absolute public peer'},
 {name:'committed-runtime-byte-pin',file:'vendor/browser-profile/lib/browser-bootstrap.mjs',before:'export function bundledChromium()',after:'export function bundledChromium_BROKEN()',test:'test/browser-profile-vendor.spec.ts',pattern:'pins the exact complete'},
 {name:'registered-catalog-unbind',file:'src/adapter.ts',before:'this.assistantToRoute.delete(p.assistantId);\n      void this.synchronizeBrowserProfiles();',after:'this.assistantToRoute.delete(p.assistantId);\n      void Promise.resolve();',test:'test/browser-profile-adapter.spec.ts',pattern:'real registered bind and unbind'},
]
const sha=b=>createHash('sha256').update(b).digest('hex'),only=process.argv[2]
const results=only?JSON.parse(readFileSync('docs/browser-profile-mutations.json')).results.filter(value=>value.name!==only):[]
mkdirSync('.tmp/browser-profile-mutations',{recursive:true})
for(const drill of drills){
 if(only&&drill.name!==only)continue
 const bytes=readFileSync(drill.file),source=bytes.toString();if(source.split(drill.before).length!==2)throw Error('Expected one executable fragment: '+drill.name)
 const changed=source.replace(drill.before,drill.after);let shared=0;while(shared<Math.min(drill.before.length,drill.after.length)&&drill.before[shared]===drill.after[shared])shared++
 const offset=source.indexOf(drill.before)+shared,line=changed.slice(0,offset).split('\n').length,changedLine=changed.split('\n')[line-1].trim()
 const run=label=>{const child=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',drill.test,'-t',drill.pattern],{encoding:'utf8',timeout:45000,windowsHide:true});if(child.error)throw child.error;const output=child.stdout+child.stderr;writeFileSync(`.tmp/browser-profile-mutations/${drill.name}.${label}.txt`,output);return{exitCode:child.status,assertionFailed:/AssertionError|expected|AssertionError/.test(output),output}}
 let red
 try{writeFileSync(drill.file,changed);if(readFileSync(drill.file,'utf8')!==changed)throw Error('Mutation not on disk');console.log(`MUTATED EXECUTABLE LINE ${drill.file}:${line}: ${changedLine}`);red=run('red');if(red.exitCode!==1||!red.assertionFailed)throw Error('No assertion red: '+drill.name)}finally{writeFileSync(drill.file,bytes)}
 if(sha(readFileSync(drill.file))!==sha(bytes))throw Error('Restoration hash mismatch')
 const green=run('restore');if(green.exitCode!==0)throw Error('Restore failed: '+drill.name)
 results.push({name:drill.name,file:drill.file,line,changedLine,before:drill.before,after:drill.after,sourceSha256:sha(bytes),restoredSha256:sha(readFileSync(drill.file)),red,green})
 console.log(`${drill.name}: red=${red.exitCode}, restored=${green.exitCode}`)
 writeFileSync('docs/browser-profile-mutations.json',JSON.stringify({kind:'direct-executable-mutations',results},null,2)+'\n')
}
console.log('QUALIFIED_MUTATIONS '+results.length)
