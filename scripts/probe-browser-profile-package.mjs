import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

// Disposable package startup/IPC/stop proof. This does not launch Chromium or
// qualify Linux key storage; dependencies resolve from this workspace fixture.
const root=resolve('.tmp','codex-package-probe-'+randomUUID()),tarball=resolve(process.argv[2]||'.tmp/codex-channel-bgos-0.20.1.tgz')
mkdirSync(root,{recursive:true,mode:0o700})
const extracted=spawnSync('tar',['-xf',tarball,'-C',root],{encoding:'utf8',windowsHide:true});assert.equal(extracted.status,0,extracted.stderr)
const packaged=join(root,'package'),manifest=JSON.parse(readFileSync(join(packaged,'vendor/browser-profile/source.json'))),states=[]
const check=spawnSync(process.execPath,[join(packaged,'dist/cli.js'),'browser-check'],{encoding:'utf8',windowsHide:true});assert.equal(check.status,0,check.stderr)
const setup=JSON.parse(check.stdout);assert.equal(setup.keyServiceAvailability,'not-probed-without-an-enrolled-profile')
const guide=readFileSync(join(packaged,'docs/browser-profile.md'),'utf8');assert.ok(guide.includes('browser-review-peer'))
const hints=await import(pathToFileURL(join(packaged,'dist/agent-hints.js')).href);assert.ok(hints.BGOS_AGENT_HINTS.includes('The plugin ships its own browser companion.'))
const{BrowserProfileHost}=await import(pathToFileURL(join(packaged,'dist/browser-profile-host.js')).href)
const server=createServer((req,res)=>{req.resume();res.writeHead(404,{'content-type':'application/json'});res.end('{"code":"fixture_unavailable"}')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let manager,pid,forcedStop=false,report
try{
 const origin='http://127.0.0.1:'+server.address().port
 manager=new BrowserProfileHost({onState:value=>states.push(value)})
 await manager.synchronize({backendUrl:origin,pairingToken:'SYNTHETIC_PACKAGE_PAIRING_TOKEN_0123456789',pairingId:8,ownerUserId:'user_disposable_package',assistantIds:[42],directory:join(root,'profile'),parentPid:process.pid})
 const deadline=Date.now()+10000
 while(manager.status().state!=='running'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20))
 assert.equal(manager.status().state,'running');assert.equal(manager.status().activeProfiles,0)
 pid=manager.record.child.pid;assert.ok(Number.isSafeInteger(pid)&&pid>0)
 const before=manager.status();await manager.stop();assert.equal(manager.status().state,'stopped');assert.equal(manager.record.stoppedReceipt,true);assert.equal(manager.record.exitCode,0);assert.equal(manager.record.exited,true)
 let alive=true;try{process.kill(pid,0)}catch(error){if(error.code==='ESRCH')alive=false;else throw error}assert.equal(alive,false)
 report={kind:'actual-packaged-node-child-lifecycle',platform:process.platform,node:process.version,tarballSha256:createHash('sha256').update(readFileSync(tarball)).digest('hex'),vendoredSourceCommit:manifest.sourceCommit,vendoredFiles:Object.keys(manifest.files).length,actualPackagedCliCheck:setup,agentInstructionsPresent:true,before,after:manager.status(),originalRequestedStopReceipt:true,actualChildExitCode:0,ownedChildGone:true,forcedStop,states,
  boundaries:['This is the extracted npm package with actual Node fork, private IPC, common BrowserHost constructor/start and guarded stop.','HTTP identity, registration and live browser authorization are not qualified here. The exact loopback endpoint refuses all requests.','No Chromium page is launched. Dependencies resolve from the workspace fixture, not a fresh installation.','Linux provider and full native checkpoint composition are separately required.']}
 writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n')
 writeFileSync('docs/browser-profile-package-proof.json',JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify({proof:join(root,'report.json'),actualChildExitCode:0,originalRequestedStopReceipt:true,ownedChildGone:true,forcedStop:false,chromiumLaunched:false}))
}finally{
 if(manager?.record&&!manager.record.exited){forcedStop=true;manager.record.child.kill('SIGTERM')}
 server.closeAllConnections();await new Promise(resolve=>server.close(()=>resolve()))
}
