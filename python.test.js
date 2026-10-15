import {test, expect} from 'bun:test';
import {demoScene} from './scene.js';
import {compileY, rasterize} from './engine.js';
import {listBackends, runBackend} from './api.js';
import {readFileSync} from 'node:fs';

function comparePythonAndJS(scene) {
  const js=rasterize(scene);
  const py=runBackend({backend:'python',scene});
  expect(py.backend).toBe('python');
  expect(py.width).toBe(1280);
  expect(py.height).toBe(720);
  expect(py.program).toEqual(js.program);
  expect(py.logs).toEqual(js.logs);
  expect(py.totalEvents).toBe(js.totalEvents);
  expect(py.totalEdits).toBe(js.totalEdits);
  expect(py.scanlines.length).toBe(js.scanlines.length);
  for(let y=0;y<js.scanlines.length;y++){
    const a=js.scanlines[y],b=py.scanlines[y];
    expect(Buffer.compare(Buffer.from(a.row),Buffer.from(b.row))).toBe(0);
    const {row:_ar,...aj}=a;
    const {row:_br,...bj}=b;
    expect(bj).toEqual(aj);
  }
}

test('Python backend is selectable alongside JavaScript',()=>{
  expect(listBackends()).toContainEqual({id:'python',label:'Python reference'});
});

test('checked-in demo-scene snapshot matches JavaScript source exactly',()=>{
  const snapshot=JSON.parse(readFileSync(new URL('./demo-scene.json',import.meta.url),'utf8'));
  expect(snapshot).toEqual(demoScene());
});

test('Python exactly matches JavaScript pixels, Y program, X lists, palette and traces in 720p demo',()=>{
  comparePythonAndJS(demoScene());
});

test('Python matches Javascript on overlaps, palette updates, clipped shapes and asymmetric corners',()=>{
  let seed=12754;
  const rng=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  for(let trial=0;trial<3;trial++){
    const scene={palette:demoScene().palette,shapes:[],paletteEvents:[
      {y:0,layer:3,color:'#123456'},
      {y:250,layer:8,color:'#654321'},
      {y:500,layer:3,color:'#aabbcc'}
    ]};
    for(let id=1;id<=20;id++){
      const r=n=>Math.floor(rng()*n);
      scene.shapes.push({id,x:r(1350)-35,y:r(690),w:r(270)+1,h:r(185)+1,
        radius:id%4===0?[r(100),r(80),r(110),r(120)]:r(75),layer:r(14)+1});
    }
    comparePythonAndJS(scene);
  }
});

test('Python standalone Y bytecode compiler agrees with JS on mixed dimensions',()=>{
  const scene={palette:demoScene().palette,shapes:[
    {id:3,x:9.5,y:3.5,w:71,h:32,radius:[12,4,9,3],layer:2},
    {id:2,x:20,y:3.5,w:20,h:14,radius:'4 8',layer:4},
    {id:1,x:0,y:20,w:100,h:30,radius:999,layer:5},
  ],paletteEvents:[{y:3,layer:4,color:'#abcdef'}]};
  comparePythonAndJS(scene);
  expect(compileY(scene).some(instruction=>instruction.op==='ROUND_RECT')).toBe(true);
});
