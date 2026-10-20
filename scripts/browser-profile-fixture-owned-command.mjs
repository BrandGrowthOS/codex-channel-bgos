import {spawn} from 'node:child_process';
import fs from 'node:fs';
const info=pid=>{try{const s=fs.readFileSync('/proc/'+pid+'/stat','utf8'),v=s.slice(s.lastIndexOf(')')+2).split(' ');return{pid,parent:Number(v[1]),group:Number(v[2]),started:v[19]};}catch(e){if(['ENOENT','ESRCH'].includes(e.code))return null;throw e;}};
const sample=()=>fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)).map(n=>info(Number(n))).filter(Boolean);
const absent=group=>{try{process.kill(-group,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}};

// A fixture-only original process owner. A logical deadline never resolves physical ownership.
export function runOwnedCommand(executable,args,{env,cwd,input,timeoutMs=240000,maxBytes=512*1024,acceptedExitCodes=[0],onOutput=()=>{},onDeadline=()=>{},spawnImpl=spawn,sampleImpl=sample,groupAbsentImpl=absent}={}){
 let child;
 try{child=spawnImpl(executable,args,{env,cwd,stdio:['pipe','pipe','pipe'],detached:true});}catch{ return Promise.reject(Error('fixture_spawn_failed')); }
 return new Promise((resolve,reject)=>{
  let first=null,deadlineExceeded=false,closed=false,code=null,signal=null,stdoutEnded=false,stderrEnded=false,stdoutClosed=false,stderrClosed=false,stdinClosed=false,group=null,bytes=0,stdout='',stderr='',settled=false;
  const stdoutChunks=[],stderrChunks=[],observed=new Map(),latch=message=>{first ||= Error(message);};
  const take=()=>{try{
   if(!child.pid)return;const rows=sampleImpl(),owned=new Set([child.pid]);for(let i=0;i<8;i++)for(const row of rows)if(owned.has(row.parent))owned.add(row.pid);
   for(const row of rows)if(owned.has(row.pid)){observed.set(row.pid,row);if(row.pid===child.pid){if(group!==null&&group!==row.group)latch('fixture_original_group_changed');group ??=row.group;}}
   if(group!==null&&(!Number.isSafeInteger(group)||group<=0||group!==child.pid))latch('fixture_original_group_invalid');
  }catch{latch('fixture_process_inventory_unknown');}};
  const drain=()=>{if(settled||!closed||!stdoutClosed||!stderrClosed||!stdinClosed)return;
   try{
    // The detached original PID is the group leader; only signal0/ESRCH is a positive group absence proof.
    const originalGroup=group??child.pid;
    if(child.pid&&(!Number.isSafeInteger(originalGroup)||originalGroup<=0||!groupAbsentImpl(originalGroup)))return;
    const now=sampleImpl();if([...observed.values()].some(row=>now.some(p=>p.pid===row.pid&&p.started===row.started)))return;
    settled=true;clearInterval(poll);clearTimeout(deadline);
    if(child.pid&&(!observed.has(child.pid)||group!==child.pid))latch('fixture_original_identity_unobserved');
    if(!stdoutEnded||!stderrEnded)latch('fixture_pipe_eof_unconfirmed');
    if(!acceptedExitCodes.includes(code)||signal!==null)latch('fixture_original_exit_failed');
    stdout=Buffer.concat(stdoutChunks).toString('utf8');stderr=Buffer.concat(stderrChunks).toString('utf8');
    const evidence={code,signal,stdout,stderr,originalPid:child.pid??null,observedPidStarts:[...observed.values()],originalClose:true,stdinClosed,stdoutEnded,stderrEnded,stdoutClosed,stderrClosed,group:child.pid?(group??child.pid):null,groupProof:child.pid?'signal0_ESRCH':'no_pid',allObservedPidStartsGone:true,deadlineExceeded,noWrapperSignals:true};
    if(first){first.evidence=evidence;reject(first);}else resolve(evidence);
   }catch{latch('fixture_physical_cleanup_unknown');}
  };
  const receive=(kind,chunk)=>{try{bytes+=chunk.length;if(bytes>maxBytes){latch('fixture_output_bound');return;}(kind==='stdout'?stdoutChunks:stderrChunks).push(Buffer.from(chunk));onOutput(kind,chunk);}catch{latch('fixture_pipe_write_failed');}};
  for(const[kind,stream]of [['stdout',child.stdout],['stderr',child.stderr]]){
   stream.on('data',chunk=>receive(kind,chunk));stream.on('error',()=>latch('fixture_pipe_read_failed'));
   stream.once('end',()=>{if(kind==='stdout')stdoutEnded=true;else stderrEnded=true;});
   stream.once('close',()=>{if(kind==='stdout')stdoutClosed=true;else stderrClosed=true;drain();});
  }
  child.stdin.on('error',()=>latch('fixture_pipe_write_failed'));child.stdin.once('close',()=>{stdinClosed=true;drain();});
  child.once('spawn',take);child.on('error',()=>latch('fixture_spawn_or_transport_failed'));
  child.once('close',(c,s)=>{closed=true;code=c;signal=s;drain();});
  const poll=setInterval(()=>{if(!closed)take();drain();},10);
  const deadline=setTimeout(()=>{deadlineExceeded=true;latch('fixture_child_logical_deadline');try{onDeadline();}catch{latch('fixture_deadline_report_failed');}},timeoutMs);
  try{child.stdin.end(input);}catch{latch('fixture_pipe_write_failed');}
 });
}
