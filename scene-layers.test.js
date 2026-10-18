import {test,expect} from 'bun:test';
import {blankScene,demoScene,LAYERS} from './scene.js';
import {editableScene,addLayer,addLayerGroup,deleteLayer,addRectangle,addText,reorderLayer,compileScene,
  layerIndex,setLayerName,setLayerColor,getLayer,getLayerNode,getLayerName,layerTree,layerSubtree,drawingLayers} from './scene-model.js';
import {validateScene,SceneStoreError} from './scene-store.js';
import {createSceneHistory} from './scene-history.js';
import {rasterize} from './engine.js';

test('moving a layer changes order, not stable object IDs or layer metadata',()=>{
  const scene=blankScene();
  setLayerName(scene,'layer-1','Base');
  setLayerColor(scene,'layer-1','#112233');
  const a=addRectangle(scene,'layer-1');
  const middle=addLayer(scene,{name:'Middle',color:'#445566'});
  const b=addRectangle(scene,middle.id);
  const top=addLayer(scene,{name:'Top',color:'#778899'});
  const c=addText(scene,top.id);
  scene.paletteEvents.push({y:10,layerId:middle.id,color:'#abcdef'});
  const before=structuredClone(scene);
  expect(reorderLayer(scene,'layer-1',middle.id,'above')).toBe(true);
  expect(scene.layers.map(l=>l.id)).toEqual(['background',middle.id,'layer-1',top.id]);
  expect([a.layerId,b.layerId,c.layerId]).toEqual(['layer-1',middle.id,top.id]);
  expect([a.id,b.id,c.id]).toEqual([1,2,3]);
  expect(getLayerName(scene,'layer-1')).toBe('Base');
  expect(getLayer(scene,'layer-1').color).toBe('#112233');
  expect(scene.paletteEvents[0].layerId).toBe(middle.id);
  expect(before.shapes).toEqual(scene.shapes);
  expect(before.texts).toEqual(scene.texts);
  const compiled=compileScene(scene);
  expect(compiled.shapes.map(o=>o.layer)).toEqual([2,1]);
  expect(compiled.texts[0].layer).toBe(3);
  expect(compiled.palette[2]).toBe('#112233');
  expect(compiled.paletteEvents[0]).toEqual({y:10,layer:1,color:'#abcdef'});
  expect(scene.shapes[0].layer).toBeUndefined();
  expect(reorderLayer(scene,top.id,'background','below')).toBe(false);
  expect(reorderLayer(scene,'background',middle.id,'above')).toBe(false);
});

test('layer moves are undoable including background, colors, names and palette events',()=>{
  let scene=blankScene();
  const second=addLayer(scene,{name:'Second',color:'#abcdef'});
  const third=addLayer(scene,{name:'Third',color:'#123456'});
  const shape=addRectangle(scene,third.id);
  const history=createSceneHistory({getScene:()=>scene,replaceScene:value=>{scene=value;}});
  const original=structuredClone(scene);
  expect(history.transaction(()=>reorderLayer(scene,third.id,'layer-1','below'))).toBe(true);
  expect(scene.layers.map(x=>x.id)).toEqual(['background',third.id,'layer-1',second.id]);
  expect(shape.layerId).toBe(third.id);
  expect(history.undo()).toBe(true);
  expect(scene).toEqual(original);
  expect(history.redo()).toBe(true);
  expect(scene.layers[1].id).toBe(third.id);
  expect(compileScene(scene).shapes[0].layer).toBe(1);
});

test('the editor enforces at most 64 layers with background anchored to bottom',()=>{
  const scene=blankScene();
  for(let i=scene.layers.length;i<LAYERS;i++)expect(addLayer(scene)).not.toBeNull();
  expect(scene.layers).toHaveLength(64);
  expect(addLayer(scene)).toBeNull();
  expect(compileScene(scene).palette).toHaveLength(64);
  expect(validateScene(scene)).toBe(scene);
  expect(()=>validateScene({...scene,layers:[...scene.layers, {id:'layer-999',name:'',color:'#ffffff'}]})).toThrow(SceneStoreError);
  expect(()=>validateScene({...scene,layers:[...scene.layers.slice(1),scene.layers[0]]})).toThrow(SceneStoreError);
  expect(()=>validateScene({...scene,layers:[scene.layers[0],scene.layers[0]]})).toThrow(SceneStoreError);
});

test('old numbered scenes migrate on open without losing colors, names or palette-event identity',()=>{
  const legacy=demoScene();
  legacy.layerNames={'0':'Backdrop','4':'Window','34':'Unused custom'};
  legacy.palette[34]='#a1b2c3';
  legacy.paletteEvents.push({y:33,layer:4,color:'#998877'});
  const original=structuredClone(legacy);
  const editor=editableScene(legacy);
  expect(editor.layers[0]).toEqual({id:'background',name:'Backdrop',color:original.palette[0]});
  expect(getLayerName(editor,'layer-4')).toBe('Window');
  expect(getLayerName(editor,'layer-34')).toBe('Unused custom');
  expect(editor.shapes.find(x=>x.id===4).layerId).toBe('layer-4');
  expect(editor.paletteEvents[0].layerId).toBe('layer-4');
  expect(editor.palette).toBeUndefined();
  expect(validateScene(editor)).toBe(editor);
  const result=compileScene(editor);
  expect(result.palette[layerIndex(editor,'layer-34')]).toBe('#a1b2c3');
  expect(result.paletteEvents[0].layer).toBe(layerIndex(editor,'layer-4'));
  expect(compileScene(original)).toEqual(original);
  const a=rasterize(original),b=rasterize(result);
  for(const y of [0,33,34,95,147,260,331,580,719]){
    for(const x of [0,220,320,501,731,912,1279]){
      const before=a.scanlines[y],after=b.scanlines[y];
      expect(after.palette[after.row[x]]).toBe(before.palette[before.row[x]]);
    }
  }
});

test('validator rejects dangling shape/event references and noncanonical ordered layers',()=>{
  const scene=blankScene();
  scene.shapes.push({id:1,x:0,y:0,w:5,h:5,radius:0,layerId:'unknown'});
  expect(()=>validateScene(scene)).toThrow(SceneStoreError);
  scene.shapes[0].layerId='layer-1';
  scene.paletteEvents.push({y:30,layerId:'invalid',color:'#ffffff'});
  expect(()=>validateScene(scene)).toThrow(SceneStoreError);
  scene.paletteEvents[0].layerId='background';
  expect(validateScene(scene)).toBe(scene);
  const wrong=structuredClone(scene);wrong.layers[1].name=' newline\n';
  expect(()=>validateScene(wrong)).toThrow(SceneStoreError);
});

test('deleting a populated layer removes its rectangles, text and palette events as one undoable edit',()=>{
  let scene=blankScene();
  const removable=addLayer(scene,{name:'Delete me',color:'#f13251'});
  const survivor=addRectangle(scene,'layer-1');
  const rect=addRectangle(scene,removable.id);
  const text=addText(scene,removable.id);
  const ptr=String(text.buffer_ptr);
  scene.textBuffers[ptr]='SAVE THIS ON UNDO';
  scene.paletteEvents.push({y:36,layerId:removable.id,color:'#1a2b3c'});
  const original=structuredClone(scene);
  const history=createSceneHistory({getScene:()=>scene,replaceScene:value=>{scene=value;}});
  expect(history.transaction(()=>deleteLayer(scene,removable.id))).toBe(true);
  expect(scene.layers.map(layer=>layer.id)).toEqual(['background','layer-1']);
  expect(scene.shapes).toEqual([survivor]);
  expect(scene.texts).toEqual([]);
  expect(scene.textBuffers[ptr]).toBeUndefined();
  expect(scene.paletteEvents).toEqual([]);
  expect(validateScene(scene)).toBe(scene);
  expect(compileScene(scene).shapes.map(item=>item.layer)).toEqual([1]);
  expect(history.undo()).toBe(true);
  expect(scene).toEqual(original);
  expect(scene.shapes.find(item=>item.id===rect.id).layerId).toBe(removable.id);
  expect(scene.textBuffers[ptr]).toBe('SAVE THIS ON UNDO');
  expect(history.redo()).toBe(true);
  expect(scene.layers.some(layer=>layer.id===removable.id)).toBe(false);
  expect(scene.shapes.some(item=>item.id===survivor.id)).toBe(true);
});

test('delete layer does not cascade across groups or delete a shared text buffer',()=>{
  const scene=blankScene();
  const other=addLayer(scene,{name:'Another layer'});
  const a=addText(scene,'layer-1');
  const b=addText(scene,other.id);
  const shared=String(a.buffer_ptr),unneeded=String(b.buffer_ptr);
  delete scene.textBuffers[unneeded];
  b.buffer_ptr=a.buffer_ptr;
  a.group_id=42;b.group_id=42;
  expect(deleteLayer(scene,'layer-1')).toEqual({objects:1,events:0});
  expect(scene.texts).toHaveLength(1);
  expect(scene.texts[0].id).toBe(b.id);
  expect(scene.texts[0].group_id).toBe(42);
  expect(scene.textBuffers[shared]).toBe('HELLO, WORLD!');
  expect(validateScene(scene)).toBe(scene);
});

test('empty layers delete immediately; the background cannot be deleted',()=>{
  const scene=blankScene();
  const empty=addLayer(scene,{name:'Unused',color:'#235678'});
  expect(deleteLayer(scene,empty.id)).toEqual({objects:0,events:0});
  expect(getLayer(scene,empty.id)).toBeNull();
  expect(deleteLayer(scene,'background')).toBe(false);
  expect(deleteLayer(scene,'nonexistent')).toBe(false);
  expect(scene.layers[0].id).toBe('background');
  expect(validateScene(scene)).toBe(scene);
});

test('deleting the final drawing layer allows inserting fresh objects again',()=>{
  const scene=blankScene();
  expect(deleteLayer(scene,'layer-1')).toEqual({objects:0,events:0});
  expect(scene.layers.map(layer=>layer.id)).toEqual(['background']);
  expect(validateScene(scene)).toBe(scene);
  const text=addText(scene);
  expect(scene.layers).toHaveLength(2);
  expect(text.layerId).toBe(scene.layers[1].id);
  expect(text.layerId).not.toBe('background');
  deleteLayer(scene,text.layerId);
  const rect=addRectangle(scene);
  expect(rect.layerId).toBe(scene.layers[1].id);
  expect(compileScene(scene).shapes[0].layer).toBe(1);
  expect(validateScene(scene)).toBe(scene);
});

test('folder nodes are freely nestable and never consume raster palette slots',()=>{
  const scene=blankScene();
  const group=addLayerGroup(scene,{name:'Windows'});
  const nested=addLayerGroup(scene,{name:'Toolbar',parentId:group.id});
  const accent=addLayer(scene,{name:'Accent',color:'#cc2266',parentId:nested.id});
  const second=addLayer(scene,{name:'Window frame',color:'#22aabb',parentId:group.id});
  const frame=addRectangle(scene,second.id);
  const title=addText(scene,accent.id);
  const top=addLayer(scene,{name:'Top chrome',color:'#101010'});
  expect(scene.layers.map(n=>n.id)).toEqual(['background','layer-1',group.id,nested.id,accent.id,second.id,top.id]);
  expect(layerSubtree(scene,group.id).map(n=>n.id)).toEqual([group.id,nested.id,accent.id,second.id]);
  expect(layerTree(scene).map(branch=>branch.node.id)).toEqual(['background','layer-1',group.id,top.id]);
  expect(layerTree(scene)[2].children[0].children[0].node.id).toBe(accent.id);
  expect(getLayer(scene,group.id)).toBeNull();
  expect(getLayerNode(scene,group.id).name).toBe('Windows');
  expect(drawingLayers(scene)).toHaveLength(5);
  expect(compileScene(scene).palette).toHaveLength(64);
  expect(compileScene(scene).shapes[0].layer).toBe(3);
  expect(compileScene(scene).texts[0].layer).toBe(2);
  expect(frame.layerId).toBe(second.id);
  expect(title.layerId).toBe(accent.id);
  expect(validateScene(scene)).toBe(scene);
});

test('moving a nested folder moves its complete subtree and can reparent into another folder',()=>{
  let scene=blankScene();
  const a=addLayerGroup(scene,{name:'A'});
  const sub=addLayerGroup(scene,{name:'Sub',parentId:a.id});
  const leaf1=addLayer(scene,{name:'First',color:'#ff0000',parentId:sub.id});
  const leaf2=addLayer(scene,{name:'Second',color:'#00ff00',parentId:sub.id});
  const b=addLayerGroup(scene,{name:'B'});
  const below=addLayer(scene,{name:'Below',color:'#0000ff',parentId:b.id});
  const rect=addRectangle(scene,leaf1.id);
  scene.paletteEvents.push({y:55,layerId:leaf2.id,color:'#aa3322'});
  const original=structuredClone(scene);
  const history=createSceneHistory({getScene:()=>scene,replaceScene:value=>{scene=value;}});
  expect(history.transaction(()=>reorderLayer(scene,sub.id,b.id,'inside'))).toBe(true);
  expect(scene.layers.map(node=>node.id)).toEqual(['background','layer-1',a.id,b.id,below.id,sub.id,leaf1.id,leaf2.id]);
  expect(scene.layers.find(node=>node.id===sub.id).parentId).toBe(b.id);
  expect(scene.layers.find(node=>node.id===leaf1.id).parentId).toBe(sub.id);
  expect(scene.shapes[0]).toEqual(rect);
  expect(scene.paletteEvents[0].layerId).toBe(leaf2.id);
  expect(validateScene(scene)).toBe(scene);
  expect(compileScene(scene).shapes[0].layer).toBe(3);
  expect(compileScene(scene).paletteEvents[0].layer).toBe(4);
  expect(history.undo()).toBe(true);
  expect(scene).toEqual(original);
  expect(history.redo()).toBe(true);
  expect(scene.layers.find(node=>node.id===sub.id).parentId).toBe(b.id);
});

test('folder reorder forbids self-parenting, descendant moves and background displacement',()=>{
  const scene=blankScene(),a=addLayerGroup(scene,{name:'A'});
  const sub=addLayerGroup(scene,{name:'Nested',parentId:a.id});
  const leaf=addLayer(scene,{parentId:sub.id});
  const before=structuredClone(scene);
  for(const [source,target,side] of [[a.id,a.id,'inside'],[a.id,sub.id,'inside'],
    [a.id,leaf.id,'above'],[sub.id,leaf.id,'inside'],['background',a.id,'inside'],
    [a.id,'background','below'],[leaf.id,'background','inside'],['unknown',a.id,'inside']]){
    expect(reorderLayer(scene,source,target,side)).toBe(false);
    expect(scene).toEqual(before);
  }
  expect(reorderLayer(scene,leaf.id,'background','above')).toBe(true);
  expect(getLayer(scene,leaf.id).parentId).toBeUndefined();
  expect(validateScene(scene)).toBe(scene);
});

test('deleting a folder recursively removes descendants and only their owned data',()=>{
  let scene=blankScene();
  const root=addLayerGroup(scene,{name:'Delete subtree'});
  const sub=addLayerGroup(scene,{name:'nested',parentId:root.id});
  const a=addLayer(scene,{name:'Red',parentId:sub.id});
  const b=addLayer(scene,{name:'Green',parentId:root.id});
  const keep=addLayer(scene,{name:'Keep me'});
  addRectangle(scene,a.id);
  addText(scene,b.id);
  const surviving=addRectangle(scene,keep.id);
  scene.paletteEvents.push({y:35,layerId:b.id,color:'#123abc'});
  const snapshot=structuredClone(scene);
  const history=createSceneHistory({getScene:()=>scene,replaceScene:value=>{scene=value;}});
  expect(history.transaction(()=>deleteLayer(scene,root.id))).toBe(true);
  expect(scene.layers.map(n=>n.id)).toEqual(['background','layer-1',keep.id]);
  expect(scene.shapes).toEqual([surviving]);
  expect(scene.texts).toEqual([]);
  expect(scene.paletteEvents).toEqual([]);
  expect(validateScene(scene)).toBe(scene);
  expect(history.undo()).toBe(true);
  expect(scene).toEqual(snapshot);
  expect(history.redo()).toBe(true);
  expect(scene.layers.some(n=>n.id===root.id)).toBe(false);
});

test('validator refuses invalid nested tree ordering, cyclic ancestry and folder object references',()=>{
  const scene=blankScene();
  const a=addLayerGroup(scene,{name:'A'});
  const b=addLayerGroup(scene,{name:'B',parentId:a.id});
  const leaf=addLayer(scene,{parentId:b.id});
  expect(validateScene(scene)).toBe(scene);
  const invalid=mutation=>{const bad=structuredClone(scene);mutation(bad);expect(()=>validateScene(bad)).toThrow(SceneStoreError);};
  invalid(s=>{s.layers.find(n=>n.id===a.id).parentId=b.id;});
  invalid(s=>{s.layers.find(n=>n.id===b.id).parentId='missing';});
  invalid(s=>{s.layers.find(n=>n.id===leaf.id).parentId='background';});
  invalid(s=>{s.layers.push({...s.layers.find(n=>n.id===a.id)});});
  invalid(s=>{const node=s.layers.find(n=>n.id===leaf.id);s.layers.splice(s.layers.indexOf(node),1);s.layers.splice(1,0,node);});
  invalid(s=>{s.shapes.push({id:1,x:0,y:0,w:10,h:10,layerId:a.id});});
  invalid(s=>{s.paletteEvents.push({y:12,color:'#ffffff',layerId:b.id});});
  invalid(s=>{s.layers.find(n=>n.id===a.id).color='#ffffff';});
  invalid(s=>{s.layers.find(n=>n.id===b.id).kind='invalid';});
});

test('group IDs remain unique when adding many sibling and nested folders',()=>{
  const scene=blankScene();
  const groups=Array.from({length:14},(_,i)=>addLayerGroup(scene,{name:'Group '+i}));
  expect(new Set(groups.map(x=>x.id)).size).toBe(14);
  for(const group of groups)expect(addLayerGroup(scene,{parentId:group.id})).not.toBeNull();
  expect(validateScene(scene)).toBe(scene);
  expect(drawingLayers(scene)).toHaveLength(2);
  expect(compileScene(scene).palette).toHaveLength(64);
});
