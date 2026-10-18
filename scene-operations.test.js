import {test,expect} from 'bun:test';
import {demoScene} from './scene.js';
import {editableScene,addRectangle,addText,getObject,getLayer,resolveSelection,selectionUnits,
  moveSelection,moveSelectionToLayer,objectsFullyInsideRect,alignSelection,distributeSelection,groupSelection,ungroupSelection,
  copySelection,pasteSelection,deleteSelection} from './scene-model.js';
import {createSceneHistory} from './scene-history.js';

function sample(){
  const scene=editableScene(demoScene());
  scene.shapes=[];
  const a=addRectangle(scene),b=addRectangle(scene),c=addRectangle(scene);
  Object.assign(a,{x:10,y:10,w:40,h:30});
  Object.assign(b,{x:90,y:30,w:20,h:20});
  Object.assign(c,{x:200,y:60,w:60,h:50});
  return {scene,refs:[a,b,c].map(obj=>({type:'rect',id:obj.id})),a,b,c};
}
test('multi-selection aligns and evenly distributes bounding boxes',()=>{
  const {scene,refs,a,b,c}=sample();
  expect(alignSelection(scene,refs,'top')).toBe(true);
  expect([a.y,b.y,c.y]).toEqual([10,10,10]);
  expect(distributeSelection(scene,refs,'horizontal')).toBe(true);
  expect([a.x,b.x,c.x]).toEqual([10,115,200]);
  expect(alignSelection(scene,refs,'bottom')).toBe(true);
  expect([a.y,b.y,c.y]).toEqual([30,40,10]);
  expect(distributeSelection(scene,refs.slice(0,2),'vertical')).toBe(false);
});
test('groups move and align as units without moving their internal offsets',()=>{
  const {scene,refs,a,b,c}=sample();
  const groupId=groupSelection(scene,refs.slice(0,2));
  expect(groupId).toBeGreaterThan(0);
  expect(resolveSelection(scene,[refs[0]])).toHaveLength(2);
  expect(selectionUnits(scene,refs)).toHaveLength(2);
  moveSelection(scene,[refs[0]],15,-5);
  expect([a.x,a.y,b.x,b.y]).toEqual([25,5,105,25]);
  alignSelection(scene,refs,'right');
  expect([a.x,b.x,c.x]).toEqual([160,240,200]);
  expect(ungroupSelection(scene,[refs[0]])).toBe(true);
  expect(a.group_id).toBeUndefined();expect(b.group_id).toBeUndefined();
});
test('copy paste remaps ids and groups while preserving independent text buffers',()=>{
  const {scene,refs,a}=sample();
  const text=addText(scene);scene.textBuffers[String(text.buffer_ptr)]='P.O.\nSECOND';
  const textRef={type:'text',id:text.id};
  groupSelection(scene,[refs[0],textRef]);
  const clipboard=copySelection(scene,[refs[0]]);
  expect(clipboard).toHaveLength(2);
  const pasted=pasteSelection(scene,clipboard,20);
  expect(pasted).toHaveLength(2);
  const duplicateRect=getObject(scene,'rect',pasted.find(ref=>ref.type==='rect').id);
  const duplicateText=getObject(scene,'text',pasted.find(ref=>ref.type==='text').id);
  expect(duplicateRect.group_id).toBe(duplicateText.group_id);
  expect(duplicateRect.group_id).not.toBe(a.group_id);
  expect(duplicateRect.x).toBe(a.x+20);
  expect(duplicateText.buffer_ptr).not.toBe(text.buffer_ptr);
  expect(scene.textBuffers[String(duplicateText.buffer_ptr)]).toBe('P.O.\nSECOND');
  scene.textBuffers[String(duplicateText.buffer_ptr)]='INDEPENDENT';
  expect(scene.textBuffers[String(text.buffer_ptr)]).toBe('P.O.\nSECOND');
  expect(deleteSelection(scene,[pasted[0]])).toBe(2);
  expect(scene.textBuffers[String(duplicateText.buffer_ptr)]).toBeUndefined();
  expect(scene.textBuffers[String(text.buffer_ptr)]).toBe('P.O.\nSECOND');
});
test('scene history round-trips groups, deletes, palettes, and text; new edits clear redo',()=>{
  let scene=sample().scene;
  const changed=[];
  const history=createSceneHistory({getScene:()=>scene,replaceScene:value=>{scene=value;},
    onChange:()=>changed.push('changed'),limit:4});
  const refs=[{type:'rect',id:scene.shapes[0].id},{type:'rect',id:scene.shapes[1].id}];
  history.transaction(()=>groupSelection(scene,refs));
  expect(history.state()).toMatchObject({canUndo:true,canRedo:false});
  history.transaction(()=>{getLayer(scene,'layer-1').color='#aabbcc';deleteSelection(scene,refs);});
  expect(scene.shapes).toHaveLength(1);
  expect(history.undo()).toBe(true);
  expect(scene.shapes).toHaveLength(3);
  expect(scene.shapes[0].group_id).toBeTruthy();
  expect(history.undo()).toBe(true);
  expect(scene.shapes[0].group_id).toBeUndefined();
  expect(history.redo()).toBe(true);
  expect(scene.shapes[0].group_id).toBeTruthy();
  history.transaction(()=>{getLayer(scene,'layer-2').color='#112233';});
  expect(history.state().canRedo).toBe(false);
  history.begin();getLayer(scene,'layer-2').color='#445566';history.commit({notify:false});
  expect(history.undo()).toBe(true);
  expect(getLayer(scene,'layer-2').color).toBe('#112233');
  history.reset();expect(history.state().canUndo).toBe(false);
  expect(changed.length).toBeGreaterThan(4);
});


test('undo/redo restores selection of pasted grouped objects',()=>{
  let scene=sample().scene;
  let selection=[];
  const history=createSceneHistory({
    getScene:()=>scene,replaceScene:value=>{scene=value;},
    getSelection:()=>selection,replaceSelection:refs=>{selection=refs;}
  });
  const refs=scene.shapes.slice(0,2).map(object=>({type:'rect',id:object.id}));
  groupSelection(scene,refs);
  selection=refs;
  const clipboard=copySelection(scene,refs);
  let pasted=[];
  history.transaction(()=>{pasted=pasteSelection(scene,clipboard);});
  selection=pasted;
  expect(selection).toEqual(pasted);
  expect(history.undo()).toBe(true);
  expect(selection).toEqual(refs);
  expect(scene.shapes).toHaveLength(3);
  expect(history.redo()).toBe(true);
  expect(selection).toEqual(pasted);
  expect(scene.shapes).toHaveLength(5);
  expect(ungroupSelection(scene,selection)).toBe(true);
  expect(scene.shapes.at(-1).group_id).toBeUndefined();
});

test('moving a tile between layers moves its complete group and is undoable',()=>{
  let scene=sample().scene;
  const refs=scene.shapes.slice(0,2).map(object=>({type:'rect',id:object.id}));
  const groupId=groupSelection(scene,refs);
  const third=scene.shapes[2];
  const thirdLayer=third.layerId;
  const originalLayers=refs.map(ref=>getObject(scene,ref.type,ref.id).layerId);
  const history=createSceneHistory({getScene:()=>scene,replaceScene:value=>{scene=value;}});
  expect(history.transaction(()=>moveSelectionToLayer(scene,[refs[0]],'layer-10'))).toBe(true);
  expect(refs.map(ref=>getObject(scene,ref.type,ref.id).layerId)).toEqual(['layer-10','layer-10']);
  expect(third.layerId).toBe(thirdLayer);
  expect(getObject(scene,refs[0].type,refs[0].id).group_id).toBe(groupId);
  expect(history.undo()).toBe(true);
  expect(refs.map(ref=>getObject(scene,ref.type,ref.id).layerId)).toEqual(originalLayers);
  expect(history.redo()).toBe(true);
  expect(refs.map(ref=>getObject(scene,ref.type,ref.id).layerId)).toEqual(['layer-10','layer-10']);
  expect(moveSelectionToLayer(scene,refs,'background')).toBe(0);
  expect(moveSelectionToLayer(scene,refs,'layer-64')).toBe(0);
  expect(moveSelectionToLayer(scene,refs,'layer-10')).toBe(0);
});

test('layer palette changes are shared and undoable without editing geometry',()=>{
  let scene=sample().scene;
  const original=getLayer(scene,'layer-12').color;
  const originalX=scene.shapes[0].x;
  const history=createSceneHistory({getScene:()=>scene,replaceScene:value=>{scene=value;}});
  expect(history.transaction(()=>{getLayer(scene,'layer-12').color='#123456';})).toBe(true);
  expect(getLayer(scene,'layer-12').color).toBe('#123456');
  expect(history.undo()).toBe(true);
  expect(getLayer(scene,'layer-12').color).toBe(original);
  expect(scene.shapes[0].x).toBe(originalX);
});


test('marquee includes only fully contained objects, not partial overlaps',()=>{
  const {scene,refs,a,b}=sample();
  expect(objectsFullyInsideRect(scene,{left:0,top:0,right:52,bottom:42})).toEqual([refs[0]]);
  expect(objectsFullyInsideRect(scene,{left:0,top:0,right:45,bottom:42})).toEqual([]);
  expect(objectsFullyInsideRect(scene,{left:10,top:10,right:50,bottom:40})).toEqual([refs[0]]);
  groupSelection(scene,refs.slice(0,2));
  expect(objectsFullyInsideRect(scene,{left:0,top:0,right:52,bottom:42})).toEqual([]);
  expect(objectsFullyInsideRect(scene,{left:0,top:0,right:120,bottom:60})).toEqual(refs.slice(0,2));
  expect(objectsFullyInsideRect(scene,{left:0,top:0,right:52,bottom:42}).length).toBe(0);
});
