import {test,expect} from 'bun:test';
import {demoScene,blankScene} from './scene.js';
import {editableScene,sceneObjects,getLayerName,setLayerName,addLayer,setLayerColor,addRectangle,addText,getObject,removeObject,duplicateObject,updateObject,moveObject,resizeObject,radiusCss,rectangleThumbnail} from './scene-model.js';

test('scene editing retains original scene schema and creates independent text buffers',()=>{
  const scene=editableScene(demoScene());
  expect(scene.texts).toEqual([]);
  const rect=addRectangle(scene);
  const text=addText(scene);
  expect(new Set(sceneObjects(scene).map(({object})=>object.id)).size).toBe(sceneObjects(scene).length);
  expect(getObject(scene,'rect',rect.id)).toBe(rect);
  expect(getObject(scene,'text',text.id)).toBe(text);
  expect(scene.textBuffers[String(text.buffer_ptr)]).toBe('HELLO, WORLD!');
  const extra=addText(scene);
  expect(text.buffer_ptr).not.toBe(extra.buffer_ptr);
  scene.textBuffers[String(text.buffer_ptr)]='FIRST';
  expect(scene.textBuffers[String(extra.buffer_ptr)]).toBe('HELLO, WORLD!');
});

test('duplicating text creates a genuinely separate buffer',()=>{
  const scene=editableScene(demoScene());
  const original=addText(scene);
  const clone=duplicateObject(scene,'text',original.id);
  expect(clone.buffer_ptr).not.toBe(original.buffer_ptr);
  expect(scene.textBuffers[String(clone.buffer_ptr)]).toBe('HELLO, WORLD!');
  scene.textBuffers[String(clone.buffer_ptr)]='SECOND';
  expect(scene.textBuffers[String(original.buffer_ptr)]).toBe('HELLO, WORLD!');
  expect(removeObject(scene,'text',original.id)).toBe(true);
  expect(scene.textBuffers[String(original.buffer_ptr)]).toBeUndefined();
  expect(scene.textBuffers[String(clone.buffer_ptr)]).toBe('SECOND');
});

test('drag and resize preserve bounds while exposing CSS-equivalent radii',()=>{
  const scene=editableScene(demoScene());
  const rect=addRectangle(scene);
  moveObject(scene,'rect',rect.id,340,210,-22,37);
  resizeObject(scene,'rect',rect.id,240,150,-500,43);
  expect([rect.x,rect.y,rect.w,rect.h]).toEqual([318,247,1,193]);
  updateObject(scene,'rect',rect.id,'radius','4 8 12 16');
  expect(rect.radius).toEqual([4,8,12,16]);
  expect(radiusCss(rect.radius)).toBe('4px 8px 12px 16px');
  const layer=addLayer(scene,{name:'Shapes'});
  expect(updateObject(scene,'rect',rect.id,'layerId',layer.id)).toBe(true);
  expect(rect.layerId).toBe(layer.id);
  expect(updateObject(scene,'rect',rect.id,'layerId','background')).toBe(false);
});

test('rectangle duplication copies independent radius arrays',()=>{
  const scene=editableScene(demoScene());
  const original=addRectangle(scene);
  updateObject(scene,'rect',original.id,'radius','4 8');
  const copy=duplicateObject(scene,'rect',original.id);
  copy.radius[0]=20;
  expect(original.radius).toEqual([4,8]);
});


test('object thumbnails preserve rectangle proportions and CSS corner radii',()=>{
  expect(rectangleThumbnail({w:400,h:200,radius:[40,20,10,30]})).toEqual({
    width:124,height:62,borderRadius:'12.4px 6.2px 3.1px 9.3px'
  });
  expect(rectangleThumbnail({w:80,h:400,radius:20})).toEqual({
    width:15.6,height:78,borderRadius:'3.9px'
  });
  const tiny=rectangleThumbnail({w:1,h:1,radius:0});
  expect(tiny.width).toBe(tiny.height);
});


test('blank scenes start empty with independent palette and text data',()=>{
  const first=blankScene(),second=blankScene();
  expect(first.shapes).toEqual([]);
  expect(first.texts).toEqual([]);
  expect(first.textBuffers).toEqual({});
  expect(first.paletteEvents).toEqual([]);
  expect(first.layers).toHaveLength(2);
  expect(first.layers[0]).toEqual({id:'background',name:'',color:'#101827'});
  first.layers[1].color='#123456';
  first.shapes.push({id:1,x:0,y:0,w:1,h:1,layerId:first.layers[1].id});
  expect(second.layers[1].color).toBe('#92d0e1');
  expect(second.shapes).toEqual([]);
});

test('new objects use a requested layer without changing its palette color',()=>{
  const scene=editableScene(demoScene());
  expect(setLayerColor(scene,'layer-12','#5a70ef')).toBe(true);
  const rect=addRectangle(scene,'layer-12');
  const text=addText(scene,'layer-12');
  expect(rect.layerId).toBe('layer-12');
  expect(text.layerId).toBe('layer-12');
  expect(scene.layers.find(layer=>layer.id==='layer-12').color).toBe('#5a70ef');
  expect(scene.textBuffers[String(text.buffer_ptr)]).toBe('HELLO, WORLD!');
});

test('layer names support background, empty layers, removal and legacy scenes',()=>{
  const scene=editableScene(demoScene());
  expect(getLayerName(scene,'layer-10')).toBe('');
  expect(setLayerName(scene,'layer-10','  Bricks  ')).toBe(true);
  expect(getLayerName(scene,'layer-10')).toBe('Bricks');
  expect(setLayerName(scene,'background','Background')).toBe(true);
  expect(getLayerName(scene,'background')).toBe('Background');
  expect(setLayerName(scene,'layer-99','Out of range')).toBe(false);
  expect(setLayerName(scene,'layer-10','')).toBe(true);
  expect(scene.layers.find(layer=>layer.id==='layer-10').name).toBe('');
  const second=editableScene(demoScene());
  expect(getLayerName(second,'layer-10')).toBe('');
});
