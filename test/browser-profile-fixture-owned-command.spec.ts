import {it as test,onTestFinished} from 'vitest';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runOwnedCommand} from '../scripts/browser-profile-fixture-owned-command.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
function fixture(t:any,extra:any={}){
 const child:any=new EventEmitter();child.pid=81234;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};child.kill=()=>{throw Error('must_not_signal')};
 let groupAlive=true,rows=[{pid:child.pid,parent:1,group:child.pid,started:'991122'}],settled=false;
 const result=runOwnedCommand('fixture',['only'],{timeoutMs:1000,spawnImpl:()=>child,sampleImpl:()=>rows,groupAbsentImpl:()=>!groupAlive,...extra});result.then(()=>{settled=true;},()=>{settled=true;});
 const close=(keepGroup=false)=>{child.stdout.emit('end');child.stderr.emit('end');child.stdout.emit('close');child.stderr.emit('close');child.stdin.emit('close');rows=[];groupAlive=keepGroup;child.emit('close',0,null);};
 onTestFinished(async()=>{close();await result.catch(()=>{});});queueMicrotask(()=>child.emit('spawn'));
 return{child,result,close,settled:()=>settled,drainGroup:()=>{groupAlive=false;}};
}
test('normal original close requires both pipe EOF and group ESRCH',async t=>{
 const f=fixture(t);await tick();f.child.stdout.emit('data',Buffer.from('actual-output'));assert.equal(f.settled(),false);f.close();const r=await f.result;assert.equal(r.stdout,'actual-output');assert.equal(r.originalClose,true);assert.equal(r.stdinClosed,true);assert.equal(r.stdoutEnded,true);assert.equal(r.stderrEnded,true);assert.equal(r.groupProof,'signal0_ESRCH');assert.equal(r.noWrapperSignals,true);
});
test('preserves UTF8 split across original stdout and stderr chunks',async t=>{
 const f=fixture(t);await tick();const value=Buffer.from('A\u00e9\ud83d\ude00Z');for(const stream of [f.child.stdout,f.child.stderr]){stream.emit('data',value.subarray(0,2));stream.emit('data',value.subarray(2,5));stream.emit('data',value.subarray(5));}f.close();const r=await f.result;assert.equal(r.stdout,'A\u00e9\ud83d\ude00Z');assert.equal(r.stderr,'A\u00e9\ud83d\ude00Z');
});
test('deadline remains pending until actual close and late exit0 is rejected',async t=>{
 const f=fixture(t,{timeoutMs:5});await tick();assert.equal(f.settled(),false);f.close();await assert.rejects(f.result,error=>error.message==='fixture_child_logical_deadline'&&error.evidence.originalClose&&error.evidence.deadlineExceeded);
});
test('stdout read error latches failure but retains original close',async t=>{
 const f=fixture(t);await tick();f.child.stdout.emit('error',Error('private'));await tick();assert.equal(f.settled(),false);f.close();await assert.rejects(f.result,/fixture_pipe_read_failed/);
});
test('stderr read error latches failure but retains original close',async t=>{
 const f=fixture(t);await tick();f.child.stderr.emit('error',Error('private'));await tick();assert.equal(f.settled(),false);f.close();await assert.rejects(f.result,/fixture_pipe_read_failed/);
});
test('stdin error latches failure but retains original close',async t=>{
 const f=fixture(t);await tick();f.child.stdin.emit('error',Error('private'));await tick();assert.equal(f.settled(),false);f.close();await assert.rejects(f.result,/fixture_pipe_write_failed/);
});
test('caller output write failure remains physically owned',async t=>{
 const f=fixture(t,{onOutput(){throw Error('private')}});await tick();f.child.stdout.emit('data',Buffer.from('x'));await tick();assert.equal(f.settled(),false);f.close();await assert.rejects(f.result,/fixture_pipe_write_failed/);
});
test('post-spawn process error cannot release a live original',async t=>{
 const f=fixture(t);await tick();f.child.emit('error',Error('private'));await tick();assert.equal(f.settled(),false);f.close();await assert.rejects(f.result,/fixture_spawn_or_transport_failed/);
});
test('overflow discards late data and retains original close',async t=>{
 const f=fixture(t,{maxBytes:2});await tick();f.child.stdout.emit('data',Buffer.from('long'));await tick();assert.equal(f.settled(),false);f.close();await assert.rejects(f.result,/fixture_output_bound/);
});
test('leader and observed PID absence are insufficient while original group lives',async t=>{
 const f=fixture(t);await tick();f.close(true);await tick();assert.equal(f.settled(),false);f.drainGroup();const r=await f.result;assert.equal(r.group,81234);assert.equal(r.groupProof,'signal0_ESRCH');
});
test('first deadline error is retained through later transport error',async t=>{
 const f=fixture(t,{timeoutMs:5});await tick();f.child.emit('error',Error('later'));f.close();await assert.rejects(f.result,/fixture_child_logical_deadline/);
});
test('synchronous no-child spawn failure refuses immediately without signals',async()=>{
 await assert.rejects(runOwnedCommand('missing',[],{spawnImpl(){throw Error('private')}}),/fixture_spawn_failed/);
});
