import {test,expect} from 'bun:test';
import {demoScene,WIDTH,HEIGHT} from './scene.js';
import {rasterize} from './engine.js';
import {listBackends,runBackend,handleApiRequest} from './api.js';

test('JavaScript backend is discoverable',()=>{
  expect(listBackends()).toContainEqual({id:'javascript',label:'JavaScript reference'});
});

test('server response preserves program, X trace, palettes, and pixel data',()=>{
  const scene=demoScene();
  const expected=rasterize(scene);
  const result=runBackend({backend:'javascript',scene});
  expect(result.backend).toBe('javascript');
  expect(result.width).toBe(WIDTH);
  expect(result.height).toBe(HEIGHT);
  expect(result.program).toEqual(expected.program);
  expect(result.totalEvents).toBe(expected.totalEvents);
  expect(result.totalEdits).toBe(expected.totalEdits);
  expect(result.frames).toHaveLength(HEIGHT);
  for(let y=0;y<HEIGHT;y++){
    expect(result.frames[y].row).toEqual(Array.from(expected.frames[y].row));
    expect(result.frames[y].edges).toEqual(expected.frames[y].edges);
    expect(result.frames[y].palette).toEqual(expected.frames[y].palette);
    expect(result.frames[y].pc).toBe(expected.frames[y].pc);
  }
  expect(JSON.parse(JSON.stringify(result)).frames[0].row).toHaveLength(WIDTH);
});

test('API exposes backends and returns a JSON execution result',async()=>{
  const response=await handleApiRequest(new Request('http://localhost/api/backends'),'/api/backends');
  expect(response.status).toBe(200);
  expect((await response.json()).backends).toEqual(listBackends());
  const request=new Request('http://localhost/api/run',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({backend:'javascript',scene:demoScene()})
  });
  const runResponse=await handleApiRequest(request,'/api/run');
  expect(runResponse.status).toBe(200);
  const run=await runResponse.json();
  expect(run.backend).toBe('javascript');
  expect(run.frames).toHaveLength(HEIGHT);
  expect(run.program.some(ins=>ins.op==='ROUND_RECT')).toBe(true);
  expect(run.frames[120].row[250]).toBe(19);
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
