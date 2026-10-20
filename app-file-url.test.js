import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {blankScene} from './scene.js';

let moduleInstance=0;
async function appHarness(url,{scenes=['first','second','My Scene'],failLoad=null}={}){
  const dom=new JSDOM(readFileSync(new URL('./index.html',import.meta.url),'utf8'),{url});
  const originals=Object.fromEntries(['window','document','Option','fetch'].map(key=>[key,globalThis[key]]));
  const requests=[];
  const store=new Map(scenes.map(name=>[name,blankScene()]));
  const $=id=>dom.window.document.getElementById(id);
  dom.window.HTMLCanvasElement.prototype.getContext=()=>({});
  $('scene-save-as-dialog').showModal=function(){this.setAttribute('open','');};
  $('scene-save-as-dialog').close=function(){this.removeAttribute('open');};
  globalThis.window=dom.window;
  globalThis.document=dom.window.document;
  globalThis.Option=dom.window.Option;
  globalThis.fetch=async (path,options={})=>{
    requests.push({path,method:options.method??'GET'});
    const json=(data,status=200)=>({ok:status<400,status,json:async()=>data});
    if(path==='/api/backends')return json({backends:[{id:'javascript',label:'JavaScript'}]});
    if(path==='/api/scenes')return json({scenes:[...store.keys()]});
    if(path.startsWith('/api/scenes/')){
      const name=decodeURIComponent(path.slice('/api/scenes/'.length));
      if(options.method==='PUT'){
        const canonical=name.replace(/\.json$/i,'');
        store.set(canonical,JSON.parse(options.body));
        return json({name:canonical});
      }
      if(name===failLoad||!store.has(name))return json({error:'Scene not found'},404);
      return json({name,scene:store.get(name)});
    }
    throw Error('Unexpected fetch '+path);
  };
  try{await import(`./app.js?url-integration-test=${++moduleInstance}`);}
  catch(error){
    for(const [key,value] of Object.entries(originals))globalThis[key]=value;
    dom.window.close();throw error;
  }
  const waitFor=async predicate=>{
    for(let i=0;i<70;i++){
      if(predicate())return;
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    throw Error('Timed out waiting for app to update: '+$('scene-file-status').textContent);
  };
  return {dom,$,requests,store,waitFor,
    cleanup(){for(const [key,value] of Object.entries(originals))globalThis[key]=value;dom.window.close();}
  };
}

test('startup loads saved scene from URL, selector changes update URL, New clears it',async()=>{
  const h=await appHarness('http://localhost/?other=keep&scene=second.json#section');
  try{
    await h.waitFor(()=>h.$('saved-scenes').value==='second');
    expect(h.requests.filter(x=>x.path.startsWith('/api/scenes')).map(x=>x.path)).toEqual(['/api/scenes','/api/scenes/second']);
    expect(h.$('scene-file-status').textContent).toContain('Opened second.json');
    expect(h.dom.window.location.href).toBe('http://localhost/?other=keep&scene=second.json#section');
    const picker=h.$('saved-scenes');
    picker.value='My Scene';
    picker.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));
    await h.waitFor(()=>h.$('scene-file-status').textContent.includes('Opened My Scene.json'));
    expect(h.dom.window.location.href).toBe('http://localhost/?other=keep&scene=My+Scene.json#section');
    h.$('scene-new').click();
    expect(h.$('saved-scenes').value).toBe('');
    expect(h.dom.window.location.href).toBe('http://localhost/?other=keep#section');
  }finally{h.cleanup();}
});

test('Save As assigns scene filename to URL and reload restores it',async()=>{
  const h=await appHarness('http://localhost/?other=keep');
  try{
    await h.waitFor(()=>h.$('saved-scenes').options.length===4);
    h.$('scene-save-as').click();
    expect(h.$('scene-save-as-dialog').open).toBe(true);
    h.$('scene-save-as-name').value='new file';
    h.$('scene-save-as-form').dispatchEvent(new h.dom.window.Event('submit',{cancelable:true,bubbles:true}));
    await h.waitFor(()=>h.$('saved-scenes').value==='new file');
    expect(h.dom.window.location.href).toBe('http://localhost/?other=keep&scene=new+file.json');
    expect(h.requests).toContainEqual({path:'/api/scenes/new%20file',method:'PUT'});
  }finally{h.cleanup();}
});

test('invalid scene parameter is rejected without fetching a scene',async()=>{
  const h=await appHarness('http://localhost/?scene=..%2Fprivate');
  try{
    await h.waitFor(()=>h.$('scene-file-status').textContent.includes('Invalid scene filename'));
    expect(h.requests.filter(x=>x.path.startsWith('/api/scenes')).map(x=>x.path)).toEqual(['/api/scenes']);
    expect(h.$('saved-scenes').value).toBe('');
  }finally{h.cleanup();}
});

test('missing startup scene reports the server failure without changing URL',async()=>{
  const h=await appHarness('http://localhost/?scene=missing.json');
  try{
    await h.waitFor(()=>h.$('scene-file-status').textContent.includes('Open failed:'));
    expect(h.$('saved-scenes').value).toBe('');
    expect(h.dom.window.location.search).toBe('?scene=missing.json');
  }finally{h.cleanup();}
});
