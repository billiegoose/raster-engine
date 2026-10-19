import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {blankScene,canvasSize,WIDTH,HEIGHT} from './scene.js';
import {editableScene,compileScene,setCanvasSize,updateObject,addRectangle} from './scene-model.js';
import {createSceneHistory} from './scene-history.js';
import {validateScene} from './scene-store.js';
import {rasterize,referenceRow,compileY} from './engine.js';
import {runBackend} from './api.js';

const fullHdScene=()=>({
  width:1920,height:1080,
  palette:Array.from({length:64},(_,i)=>i===0?'#060200':'#dd5800'),
  shapes:[{id:1,x:1850,y:1050,w:70,h:30,radius:0,layer:1}],
  paletteEvents:[{y:1079,layer:1,color:'#ff3400'}]
});

test('default, explicit and legacy canvas resolutions are validated',()=>{
  expect(canvasSize({})).toEqual({width:WIDTH,height:HEIGHT});
  expect(canvasSize(blankScene())).toEqual({width:1280,height:720});
  expect(canvasSize({width:1920,height:1080})).toEqual({width:1920,height:1080});
  expect(canvasSize({width:64,height:48})).toEqual({width:64,height:48});
  for(const bad of [{width:1920},{height:1080},{width:0,height:1080},
    {width:1921,height:1080},{width:1920,height:1081},
    {width:1920.5,height:1080},{width:'1920',height:1080},
    {width:NaN,height:1080}])expect(()=>canvasSize(bad)).toThrow();
});

test('changing the canvas is undoable and never resizes or deletes artwork',()=>{
  let scene=editableScene(blankScene());
  const shape=addRectangle(scene);
  const before={...shape};
  const history=createSceneHistory({
    getScene:()=>scene,replaceScene:value=>{scene=editableScene(value);}
  });
  expect(history.transaction(()=>setCanvasSize(scene,1920,1080))).toBe(true);
  expect(canvasSize(scene)).toEqual({width:1920,height:1080});
  expect(scene.shapes[0]).toEqual(before);
  expect(compileScene(scene)).toMatchObject({width:1920,height:1080});
  expect(history.undo()).toBe(true);
  expect(canvasSize(scene)).toEqual({width:1280,height:720});
  expect(scene.shapes[0]).toEqual(before);
  expect(history.redo()).toBe(true);
  expect(canvasSize(scene)).toEqual({width:1920,height:1080});
  expect(scene.shapes[0]).toEqual(before);
  expect(history.transaction(()=>{
    updateObject(scene,'rect',shape.id,'x',1800);
    updateObject(scene,'rect',shape.id,'y',920);
  })).toBe(true);
  expect([scene.shapes[0].x,scene.shapes[0].y]).toEqual([1800,920]);
  expect(history.transaction(()=>setCanvasSize(scene,1280,720))).toBe(true);
  // Objects outside a smaller canvas remain in JSON and can be restored.
  expect([scene.shapes[0].x,scene.shapes[0].y]).toEqual([1800,920]);
  expect(history.undo()).toBe(true);
  expect(canvasSize(scene)).toEqual({width:1920,height:1080});
  expect([scene.shapes[0].x,scene.shapes[0].y]).toEqual([1800,920]);
});

test('1080p JavaScript scanlines extend through lower-right pixel and palette event',()=>{
  const scene=fullHdScene();
  const result=rasterize(scene);
  expect(result.scanlines).toHaveLength(1080);
  expect(result.program.at(-2)).toEqual({op:'WAIT_Y',y:1080});
  expect(result.scanlines[1079].row).toHaveLength(1920);
  expect(result.scanlines[1049].row[1919]).toBe(0);
  expect(result.scanlines[1050].row[1850]).toBe(1);
  expect(result.scanlines[1079].row[1919]).toBe(1);
  expect(result.scanlines[1079].palette[1]).toBe('#ff3400');
  expect(referenceRow(scene,1079)[1919]).toBe(1);
  expect(compileY(scene).some(ins=>ins.op==='SET_PALETTE'&&ins.layer===1)).toBe(true);
});

test('API returns actual 1080p dimensions from both backends',()=>{
  const scene=fullHdScene();
  for(const backend of ['javascript','python']){
    const result=runBackend({backend,scene});
    expect([result.width,result.height]).toEqual([1920,1080]);
    expect(result.scanlines).toHaveLength(1080);
    expect(result.scanlines[1079].row).toHaveLength(1920);
    expect(result.scanlines[1079].row[1919]).toBe(1);
    expect(result.scanlines[1079].palette[1]).toBe('#ff3400');
    expect(result.program.at(-2)).toEqual({op:'WAIT_Y',y:1080});
  }
});

test('scene validation uses the saved canvas height for palette events',()=>{
  const scene=blankScene();
  scene.paletteEvents=[{y:1079,layerId:'layer-1',color:'#ff3400'}];
  expect(()=>validateScene(scene)).toThrow();
  setCanvasSize(scene,1920,1080);
  expect(validateScene(scene)).toBe(scene);
  scene.paletteEvents[0].y=1080;
  expect(()=>validateScene(scene)).toThrow();
  scene.paletteEvents[0].y=1079;
  for(const bad of [{width:1920},{width:0,height:720},{width:2500,height:1080}]){
    const copy={...scene,...bad};
    if(!('height' in bad))delete copy.height;
    expect(()=>validateScene(copy)).toThrow();
  }
});

test('Amber component atlas uses native 1080p pixels and four aligned vertical columns',()=>{
  const scene=JSON.parse(readFileSync(new URL('./scenes/amber-components.json',import.meta.url),'utf8'));
  expect(validateScene(scene)).toBe(scene);
  expect(canvasSize(scene)).toEqual({width:1920,height:1080});
  expect(scene.shapes).toHaveLength(60);
  expect(scene.texts).toHaveLength(36);
  const shapes=new Map(scene.shapes.map(o=>[o.id,o]));
  const texts=new Map(scene.texts.map(o=>[o.id,o]));
  const label=id=>scene.textBuffers[String(texts.get(id).buffer_ptr)];
  const columns=[265,675,1085,1495];
  expect([25,46,61,96].map(id=>shapes.get(id).x)).toEqual(columns);
  expect([25,46,61,96].map(id=>shapes.get(id).w)).toEqual([390,390,390,390]);
  expect([27,48,63,99].map(label)).toEqual(['BUTTONS','TEXT FIELDS','CHOICES','VALUES']);
  expect([29,31,34,37].map(id=>[shapes.get(id).x,shapes.get(id).y,shapes.get(id).w]))
    .toEqual([[285,168,350],[285,298,350],[285,428,350],[285,558,350]]);
  expect([30,33,36,39].map(label)).toEqual(['PRIMARY','STANDARD','INACTIVE','ALERT']);
  expect([50,53,57].map(id=>[shapes.get(id).x,shapes.get(id).y,shapes.get(id).w]))
    .toEqual([[695,168,350],[695,298,350],[695,428,350]]);
  expect([52,55,59].map(label)).toEqual(['INACTIVE','STANDARD','REQUIRED']);
  expect([85,40,76,79,89,93].map(id=>shapes.get(id).y))
    .toEqual([170,300,430,560,690,820]);
  expect([75,42,78,81,88,92].map(label))
    .toEqual(['CHECKED','UNCHECKED','SELECTED','UNSELECTED','OFF','ON']);
  expect([texts.get(45).x,texts.get(45).y,label(45)]).toEqual([1110,632,'TOGGLES']);
  expect([13,17,15,18,19].map(label)).toEqual(['PALETTE','BASE','DIM','PRIMARY','ALERT']);
  expect([100,101,102,103].map(id=>shapes.get(id).layerId))
    .toEqual(['layer-7','layer-3','layer-6','layer-9']);
  expect([20,22,23,24].map(label)).toEqual(['RENDERER','RECTANGLES','TEXT MASKS','64 LAYERS']);
  for(const obj of [...scene.shapes,...scene.texts]){
    expect(obj.x).toBeGreaterThanOrEqual(0);
    expect(obj.y).toBeGreaterThanOrEqual(0);
    expect(obj.x+obj.w).toBeLessThanOrEqual(1920);
    expect(obj.y+obj.h).toBeLessThanOrEqual(1080);
  }
  expect(shapes.get(1).w).toBe(1920);
  expect(label(9)).toBe('RED2 / 1080P');
  expect(texts.get(9).y).toBe(1045);
  expect(compileScene(scene)).toMatchObject({width:1920,height:1080});
});
