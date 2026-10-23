import {test,expect} from 'bun:test';
import {demoScene,WIDTH,HEIGHT} from './scene.js';
import {rasterize} from './engine.js';
import {listBackends,runBackend,handleApiRequest} from './api.js';

test('Python is the only available simulation backend',()=>{
  expect(listBackends()).toEqual([{id:'python',label:'Python reference'}]);
});

test('server response preserves program, X trace, palettes, and pixel data',()=>{
  const scene=demoScene();
  const expected=rasterize(scene);
  const result=runBackend({scene});
  expect(result.backend).toBe('python');
  expect(result.width).toBe(WIDTH);
  expect(result.height).toBe(HEIGHT);
  expect(result.program).toEqual(expected.program);
  expect(result.totalEvents).toBe(expected.totalEvents);
  expect(result.totalEdits).toBe(expected.totalEdits);
  expect(result.scanlines).toHaveLength(HEIGHT);
  for(let y=0;y<HEIGHT;y++){
    expect(result.scanlines[y].row).toEqual(Array.from(expected.scanlines[y].row));
    expect(result.scanlines[y].edges).toEqual(expected.scanlines[y].edges);
    expect(result.scanlines[y].palette).toEqual(expected.scanlines[y].palette);
    expect(result.scanlines[y].pc).toBe(expected.scanlines[y].pc);
  }
  expect(JSON.parse(JSON.stringify(result)).scanlines[0].row).toHaveLength(WIDTH);
});

test('API exposes backends and returns a JSON execution result',async()=>{
  const response=await handleApiRequest(new Request('http://localhost/api/backends'),'/api/backends');
  expect(response.status).toBe(200);
  expect((await response.json()).backends).toEqual(listBackends());
  const request=new Request('http://localhost/api/run',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({scene:demoScene()})
  });
  const runResponse=await handleApiRequest(request,'/api/run');
  expect(runResponse.status).toBe(200);
  const run=await runResponse.json();
  expect(run.backend).toBe('python');
  expect(run.scanlines).toHaveLength(HEIGHT);
  expect(run.program.some(ins=>ins.op==='ROUND_RECT')).toBe(true);
  expect(run.scanlines[111].row[250]).toBe(19);
});

test('API rejects invalid requests and unsupported backends',async()=>{
  const invalid=await handleApiRequest(new Request('http://localhost/api/run',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({backend:'pypeline',scene:demoScene()})
  }),'/api/run');
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).error).toContain('Unknown backend');
  const invalidScene=await handleApiRequest(new Request('http://localhost/api/run',{
    method:'POST',headers:{'Content-Type':'application/json'},body:'{}'
  }),'/api/run');
  expect(invalidScene.status).toBe(400);
  const wrongMethod=await handleApiRequest(new Request('http://localhost/api/run'),'/api/run');
  expect(wrongMethod.status).toBe(405);
});


test('removed JavaScript backend is rejected; Python resolves TEXT buffer pointers',()=>{
  const scene=demoScene();
  scene.texts=[{id:94,x:350,y:220,w:300,h:36,layer:30,buffer_ptr:8192}];
  scene.textBuffers={'8192':'HELLO'};
  expect(()=>runBackend({backend:'javascript',scene})).toThrow('Unknown backend: javascript');
  const result=runBackend({backend:'python',scene});
  expect(result.program.some(ins=>ins.op==='TEXT')).toBe(true);
  expect(result.scanlines[225].edges.some(e=>e.op==='START_MASK'&&e.buffer_ptr===8192)).toBe(true);
  expect(result.scanlines.some(row=>row.row.includes(30))).toBe(true);
});
