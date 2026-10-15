import {test,expect} from 'bun:test';
import {demoScene} from './scene.js';
import {editableScene,sceneObjects,addRectangle,addText,getObject,removeObject,duplicateObject,updateObject,moveObject,resizeObject,radiusCss} from './scene-model.js';

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
  updateObject(scene,'rect',rect.id,'layer',250);
  expect(rect.layer).toBe(63);
});

test('rectangle duplication copies independent radius arrays',()=>{
  const scene=editableScene(demoScene());
  const original=addRectangle(scene);
  updateObject(scene,'rect',original.id,'radius','4 8');
  const copy=duplicateObject(scene,'rect',original.id);
  copy.radius[0]=20;
  expect(original.radius).toEqual([4,8]);
});
