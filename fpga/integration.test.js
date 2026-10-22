import {test,expect} from 'bun:test';
import {unlink} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {createFpgaApi} from './api.js';
import {createFpgaControls} from './controls.js';
import {blankScene} from '../scene.js';

const scene=()=>({...blankScene(),width:1920,height:1080});
const request=(path,source=scene(),extra={})=>new Request('http://localhost'+path,{
  method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify({scene:source})
});

test('real Python export writes a downloadable binary with the fixed ROM ABI',async()=>{
  const handle=createFpgaApi();
  const response=await handle(request('/api/fpga/export'),'/api/fpga/export');
  expect(response.status).toBe(200);
  const data=await response.json();
  try{
    expect(data.flashAddress).toBe(0x220000);
    expect(data.runs).toBe(1);
    const download=await handle(new Request('http://localhost'+data.downloadUrl),data.downloadUrl);
    const bytes=Buffer.from(await download.arrayBuffer());
    expect(bytes.subarray(0,4).toString()).toBe('RX01');
    expect(bytes.readUInt16LE(4)).toBe(1920);
    expect(bytes.readUInt16LE(6)).toBe(1080);
    expect(bytes.length).toBe(4099);
    expect(download.headers.get('content-disposition')).toContain(data.filename);
  }finally{await unlink(data.path);}
},10000);

test('upload failure retains a download link and unsupported scenes never invoke Python',async()=>{
  const calls=[];
  const handle=createFpgaApi({runPython:async(action,source)=>{
    calls.push({action,source});
    return {ok:false,error:'No board detected',path:'/saved.bin',filename:'x-programs-test.bin'};
  }});
  const failed=await handle(request('/api/fpga/program'),'/api/fpga/program');
  expect(failed.status).toBe(502);
  expect((await failed.json()).downloadUrl).toBe('/api/fpga/files/x-programs-test.bin');
  expect(calls).toHaveLength(1);
  expect(calls[0].action).toBe('program');
  const unsupported=await handle(request('/api/fpga/program',blankScene()),'/api/fpga/program');
  expect(unsupported.status).toBe(400);
  expect(calls).toHaveLength(1);
  const crossOrigin=await handle(request('/api/fpga/program',scene(),{origin:'http://untrusted.example'}),'/api/fpga/program');
  expect(crossOrigin.status).toBe(403);
  expect(calls).toHaveLength(1);
});

test('concurrent FPGA programming is serialized',async()=>{
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const handle=createFpgaApi({runPython:async()=>{started();await gate;return {ok:true};}});
  const first=handle(request('/api/fpga/program'),'/api/fpga/program');
  await entered;
  const second=await handle(request('/api/fpga/program'),'/api/fpga/program');
  expect(second.status).toBe(409);
  release();expect((await first).status).toBe(200);
});

test('simulator upload snapshots unsaved edits, reports changes and restores the button',async()=>{
  const dom=new JSDOM('<button id="fpga-program"></button><span id="fpga-status"></span><a id="fpga-download" hidden></a>');
  const previous={document:globalThis.document,fetch:globalThis.fetch};
  globalThis.document=dom.window.document;
  let current=scene(),complete,captured;
  globalThis.fetch=async(_path,options)=>{
    captured=JSON.parse(options.body);
    return new Promise(resolve=>{complete=resolve;});
  };
  try{
    const controls=createFpgaControls({getScene:()=>current});
    const button=document.getElementById('fpga-program');
    button.click();
    expect(button.disabled).toBe(true);
    expect(captured.scene.width).toBe(1920);
    current=structuredClone(current);current.shapes.push({id:123});controls.markDirty();
    expect(captured.scene.shapes).toHaveLength(0);
    complete({ok:true,json:async()=>({ok:true,runs:1,bytes:4099,downloadUrl:'/saved.bin'})});
    for(let n=0;n<20&&button.disabled;n++)await new Promise(resolve=>setTimeout(resolve,0));
    expect(button.disabled).toBe(false);
    expect(document.getElementById('fpga-status').textContent).toContain('Scene changed');
    expect(document.getElementById('fpga-download').hidden).toBe(false);
    current=blankScene();controls.markDirty();expect(button.disabled).toBe(true);
  }finally{globalThis.document=previous.document;globalThis.fetch=previous.fetch;dom.window.close();}
});
