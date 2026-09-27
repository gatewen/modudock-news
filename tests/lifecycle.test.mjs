import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {createLifecycle} from '../front/lifecycle.js';
import mount from '../front/front.js';

function clock() {
  let seq=0;
  const timeouts=new Map(),intervals=new Map(),cleared=[];
  return {timeouts,intervals,cleared,
    setTimeout(fn){const id=++seq;timeouts.set(id,fn);return id;},
    clearTimeout(id){cleared.push(id);timeouts.delete(id);},
    setInterval(fn){const id=++seq;intervals.set(id,fn);return id;},
    clearInterval(id){cleared.push(id);intervals.delete(id);}};
}

test('lifecycle removes capture and bubble listeners with the original capture value',()=>{
  const c=clock(),life=createLifecycle(c),active=[];
  const target={addEventListener(type,fn,opts){active.push({type,fn,capture:typeof opts==='boolean'?opts:!!opts?.capture});},
    removeEventListener(type,fn,capture){const i=active.findIndex(x=>x.type===type&&x.fn===fn&&x.capture===capture);if(i>=0)active.splice(i,1);}};
  const fn=()=>{},opts={capture:true,passive:true};
  life.on(target,'click',fn,opts);opts.capture=false;
  life.on(target,'click',fn,false);life.on(target,'wheel',fn,{passive:true});
  assert.equal(active.length,3);life.dispose();assert.equal(active.length,0);
  life.on(target,'click',fn);assert.equal(active.length,0);
});

test('lifecycle cancels both timer kinds and prevents already queued callbacks after disposal',()=>{
  const c=clock(),life=createLifecycle(c);let calls=0;
  life.timeout(()=>calls++,10);life.interval(()=>calls++,10);
  const callbacks=[...c.timeouts.values(),...c.intervals.values()];
  life.dispose();assert.equal(c.timeouts.size,0);assert.equal(c.intervals.size,0);
  callbacks.forEach(fn=>fn());assert.equal(calls,0);
  assert.equal(life.timeout(()=>calls++,1),null);assert.equal(life.interval(()=>calls++,1),null);
  assert.equal(c.timeouts.size+c.intervals.size,0);
});

test('lifecycle forgets fired and explicitly cancelled timers, retains repeating intervals until cancelled',()=>{
  const c=clock(),life=createLifecycle(c);let calls=0;
  const fired=life.timeout(()=>calls++,1),fn=c.timeouts.get(fired);c.timeouts.delete(fired);fn();
  assert.equal(calls,1);
  const cancelled=life.timeout(()=>calls++,1);life.clearTimeout(cancelled);
  const repeating=life.interval(()=>calls++,1);c.intervals.get(repeating)();c.intervals.get(repeating)();
  assert.equal(calls,3);life.clearInterval(repeating);
  assert.equal(c.timeouts.size+c.intervals.size,0);
  c.cleared.length=0;life.dispose();assert.deepEqual(c.cleared,[]);
});

test('lifecycle disconnects registered observers once and immediately disconnects late registrations',()=>{
  const life=createLifecycle(clock());let calls=0;const observer={disconnect(){calls++;}};
  assert.equal(life.observer(observer),observer);life.observer(observer);
  life.dispose();life.dispose();assert.equal(calls,1);
  life.observer(observer);assert.equal(calls,2);
});

test('100 mounts return DOM/window listeners, timers and observers to baseline on every unmount',async()=>{
  const window=new Window(),container=window.document.createElement('div');window.document.body.append(container);
  let proto=container;while(!Object.hasOwn(proto,'addEventListener'))proto=Object.getPrototypeOf(proto);
  const owners=[proto,window],originals=owners.map(p=>[p,p.addEventListener,p.removeEventListener]);
  const listeners=[],observers=new Set(),c=clock();let tracking=false;
  const capture=opts=>typeof opts==='boolean'?opts:!!opts?.capture;
  for(const [owner,add,remove] of originals) {
    owner.addEventListener=function(type,fn,opts){if(tracking&&!listeners.some(x=>x.target===this&&x.type===type&&x.fn===fn&&x.capture===capture(opts)))listeners.push({target:this,type,fn,capture:capture(opts)});return add.call(this,type,fn,opts);};
    owner.removeEventListener=function(type,fn,opts){const i=listeners.findIndex(x=>x.target===this&&x.type===type&&x.fn===fn&&x.capture===capture(opts));if(i>=0)listeners.splice(i,1);return remove.call(this,type,fn,opts);};
  }
  window.setTimeout=c.setTimeout;window.clearTimeout=c.clearTimeout;
  window.setInterval=c.setInterval;window.clearInterval=c.clearInterval;
  window.ResizeObserver=class {observe(){observers.add(this);}disconnect(){observers.delete(this);}};
  try {
    for(let i=0;i<100;i++) {
      let message,up;tracking=true;
      const handle=mount({container,channel:{onMessage(fn){message=fn;},send(){}},onUp(fn){up=fn;},report(){}});
      tracking=false;
      assert.equal(listeners.length,40);assert.equal(observers.size,1);
      up();message({op:'list',at:'2026-09-27T01:00:00Z',items:[],sources:[],model:{state:'working'},classify:{enabled:true,pending:1}});
      container.querySelector('.nw-refresh').click();assert.equal(c.timeouts.size,2);
      const stale=[...c.timeouts.values()];handle.unmount();handle.unmount();
      assert.equal(listeners.length,0,`listeners mount ${i}`);assert.equal(c.timeouts.size,0);assert.equal(observers.size,0);
      stale.forEach(fn=>fn());up();message({op:'list',items:[]});assert.equal(container.children.length,0);
    }
  } finally {for(const [owner,add,remove] of originals){owner.addEventListener=add;owner.removeEventListener=remove;}await window.happyDOM.close();}
});
