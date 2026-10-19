import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {blankScene} from './scene.js';
import {
  prepareObjectEditorScene,addObjectFolder,renameObjectFolder,getObjectFolder,
  objectFolders,folderDescendants,folderMembers,moveObjectsToFolder,
  moveObjectFolder,moveObjectFolderContents,deleteObjectFolder,
  addRectangle,addText,moveSelection,resolveSelection,removePaintLayer,
  drawingLayers,compileScene,addLayer,setLayerColor,updateObject,
  copySelection,pasteSelection
} from './scene-model.js';
import {validateScene,SceneStoreError} from './scene-store.js';
import {createSceneHistory} from './scene-history.js';

function setup(){
  const scene=prepareObjectEditorScene(blankScene());
  const ring=addRectangle(scene),dot=addRectangle(scene),label=addText(scene);
  ring.x=100;ring.y=80;dot.x=110;dot.y=90;label.x=140;label.y=80;
  const paint=addLayer(scene,{name:'Foreground',color:'#dd5800'});
  dot.layerId=paint.id;label.layerId=paint.id;
  return {scene,ring,dot,label};
}

test('arbitrary nested object folders are independent of paint layers',()=>{
  const {scene,ring,dot,label}=setup();
  const panel=addObjectFolder(scene,{name:'Panel'});
  const radio=addObjectFolder(scene,{name:'Radio',parentId:panel.id});
  expect(moveObjectsToFolder(scene,[{type:'rect',id:ring.id},{type:'rect',id:dot.id},{type:'text',id:label.id}],radio.id)).toBe(3);
  expect(folderMembers(scene,panel.id)).toHaveLength(3);
  expect(folderMembers(scene,radio.id)).toHaveLength(3);
  expect(folderDescendants(scene,panel.id)).toEqual(new Set([panel.id,radio.id]));
  expect([ring.layerId,dot.layerId,label.layerId]).toEqual(['layer-1','layer-2','layer-2']);
  expect(drawingLayers(scene)).toHaveLength(3);
  expect(validateScene(scene)).toBe(scene);
  expect(compileScene(scene).shapes).not.toHaveProperty('parentId');
  expect(compileScene(scene).shapes.map(o=>o.layer)).toEqual([1,2]);
  const before=[ring.x,dot.x,label.x];
  expect(moveObjectFolderContents(scene,panel.id,23,-7)).toBe(3);
  expect([ring.x,dot.x,label.x]).toEqual(before.map(x=>x+23));
  expect([ring.y,dot.y,label.y]).toEqual([73,83,73]);
  expect([ring.layerId,dot.layerId,label.layerId]).toEqual(['layer-1','layer-2','layer-2']);
  expect(resolveSelection(scene,[{type:'rect',id:ring.id}])).toHaveLength(3);
});

test('folder reparenting rejects cycles, and removing a folder preserves its artwork',()=>{
  const {scene,ring,dot}=setup();
  const root=addObjectFolder(scene,{name:'Root'});
  const nested=addObjectFolder(scene,{name:'Nested',parentId:root.id});
  const other=addObjectFolder(scene,{name:'Other'});
  moveObjectsToFolder(scene,[{type:'rect',id:ring.id},{type:'rect',id:dot.id}],nested.id);
  expect(moveObjectFolder(scene,root.id,nested.id)).toBe(false);
  expect(moveObjectFolder(scene,root.id,root.id)).toBe(false);
  expect(moveObjectFolder(scene,nested.id,other.id)).toBe(true);
  expect(renameObjectFolder(scene,other.id,'Renamed')).toBe(true);
  expect(getObjectFolder(scene,other.id).name).toBe('Renamed');
  expect(deleteObjectFolder(scene,nested.id)).toBe(true);
  expect(ring.parentId).toBe(other.id);
  expect(dot.parentId).toBe(other.id);
  expect(deleteObjectFolder(scene,other.id)).toBe(true);
  expect(ring.parentId).toBeUndefined();
  expect(scene.shapes).toHaveLength(2);
  expect(validateScene(scene)).toBe(scene);
});

test('object folder metadata cannot form cycles or dangle',()=>{
  const {scene,ring}=setup();
  const a=addObjectFolder(scene,{name:'A'});
  const b=addObjectFolder(scene,{name:'B',parentId:a.id});
  moveObjectsToFolder(scene,[{type:'rect',id:ring.id}],b.id);
  const invalid=change=>{const copy=structuredClone(scene);change(copy);expect(()=>validateScene(copy)).toThrow(SceneStoreError);};
  invalid(s=>{s.objectFolders[0].parentId=b.id;});
  invalid(s=>{s.objectFolders[1].parentId='folder-999';});
  invalid(s=>{s.objectFolders.push({...s.objectFolders[0]});});
  invalid(s=>{s.shapes[0].parentId='folder-999';});
  invalid(s=>{s.objectFolders[0].name='INVALID\nNAME';});
});

test('paint changes and palette removal do not alter object composition',()=>{
  const {scene,ring,dot,label}=setup();
  const folder=addObjectFolder(scene,{name:'Radio'});
  moveObjectsToFolder(scene,[{type:'rect',id:ring.id},{type:'rect',id:dot.id},{type:'text',id:label.id}],folder.id);
  const paint=dot.layerId;
  expect(setLayerColor(scene,paint,'#ff3400')).toBe(true);
  expect(getObjectFolder(scene,folder.id).name).toBe('Radio');
  expect(updateObject(scene,'rect',ring.id,'layerId',paint)).toBe(true);
  scene.paletteEvents.push({y:10,layerId:paint,color:'#123456'});
  expect(removePaintLayer(scene,paint)).toBe(true);
  expect([ring.layerId,dot.layerId,label.layerId].every(id=>id!=='background'&&id!==paint)).toBe(true);
  expect(scene.paletteEvents[0].layerId).toBe(ring.layerId);
  expect(folderMembers(scene,folder.id)).toHaveLength(3);
  expect(validateScene(scene)).toBe(scene);
  expect(compileScene(scene).palette).toHaveLength(64);
});

test('removing the only foreground paint layer keeps content on a replacement layer',()=>{
  const {scene,ring}=setup();
  const extra=scene.layers.find(l=>l.id==='layer-2');
  expect(removePaintLayer(scene,extra.id)).toBe(true);
  expect(removePaintLayer(scene,'layer-1')).toBe(true);
  expect(drawingLayers(scene).length).toBe(2);
  expect(scene.shapes.every(o=>o.layerId!=='background')).toBe(true);
  expect(validateScene(scene)).toBe(scene);
});

test('former paint groups become flat palette order, and former object groups become composition folders',()=>{
  const source=JSON.parse(readFileSync(new URL('./scenes/amber-components.json',import.meta.url),'utf8'));
  const expected=compileScene(source);
  const before=source.layers.filter(l=>l.kind!=='group').map(l=>[l.id,l.name,l.color]);
  const existingGroups=new Set([...source.shapes,...source.texts]
    .map(object=>object.group_id).filter(id=>id!=null));
  const rect=source.shapes[0],text=source.texts[0];
  rect.group_id=991;text.group_id=991;
  const migrated=prepareObjectEditorScene(source);
  expect(migrated.layers.every(l=>l.kind!=='group'&&l.parentId===undefined)).toBe(true);
  expect(migrated.layers.map(l=>[l.id,l.name,l.color])).toEqual(before);
  expect(migrated.objectFolders).toHaveLength(existingGroups.size+1);
  const imported=objectFolders(migrated).find(folder=>folder.name==='Group 991');
  expect(imported).toBeDefined();
  expect(folderMembers(migrated,imported.id)).toHaveLength(2);
  expect(rect.group_id).toBeUndefined();
  expect(text.group_id).toBeUndefined();
  expect(compileScene(migrated).shapes).toEqual(expected.shapes);
  expect(compileScene(migrated).texts).toEqual(expected.texts);
  expect(compileScene(migrated).palette).toEqual(expected.palette);
  expect(validateScene(migrated)).toBe(migrated);
  expect(prepareObjectEditorScene(migrated)).toBe(migrated);
  expect(migrated.objectFolders).toHaveLength(existingGroups.size+1);
});

test('composition edits are undoable independently of paint edits',()=>{
  let scene=setup().scene;
  const ring=scene.shapes[0],paint=scene.shapes[1].layerId;
  const history=createSceneHistory({getScene:()=>scene,replaceScene:value=>{scene=value;}});
  let folder;
  expect(history.transaction(()=>{folder=addObjectFolder(scene,{name:'Radio'});moveObjectsToFolder(scene,[{type:'rect',id:ring.id}],folder.id);})).toBe(true);
  expect(history.transaction(()=>setLayerColor(scene,paint,'#ff3400'))).toBe(true);
  expect(history.undo()).toBe(true);
  expect(scene.shapes[0].parentId).toBe(folder.id);
  expect(history.undo()).toBe(true);
  expect(scene.objectFolders).toHaveLength(0);
  expect(scene.shapes[0].parentId).toBeUndefined();
  expect(history.redo()).toBe(true);
  expect(scene.shapes[0].parentId).toBe(folder.id);
});

test('exact selection does not merge individual primitives merely because they share a folder',()=>{
  const {scene,ring,dot,label}=setup();
  const folder=addObjectFolder(scene,{name:'One widget'});
  moveObjectsToFolder(scene,[{type:'rect',id:ring.id},{type:'rect',id:dot.id},{type:'text',id:label.id}],folder.id);
  const refs=[{type:'rect',id:ring.id},{type:'rect',id:dot.id}];
  expect(resolveSelection(scene,[refs[0]])).toHaveLength(3);
  expect(resolveSelection(scene,[refs[0]],{expandGroups:false})).toEqual([refs[0]]);
  const bx=dot.x;
  moveSelection(scene,[refs[0]],7,0,{expandGroups:false});
  expect(ring.x).toBe(107);
  expect(dot.x).toBe(bx);
});


test('cross-scene clipboard paste cannot leave dangling composition folders',()=>{
  const source=setup(),folder=addObjectFolder(source.scene,{name:'Widget'});
  moveObjectsToFolder(source.scene,[{type:'rect',id:source.ring.id}],folder.id);
  const clipboard=copySelection(source.scene,[{type:'rect',id:source.ring.id}],{expandGroups:false});
  const destination=prepareObjectEditorScene(blankScene());
  const pasted=pasteSelection(destination,clipboard);
  expect(pasted).toHaveLength(1);
  expect(destination.shapes[0].parentId).toBeUndefined();
  expect(validateScene(destination)).toBe(destination);
});

test('independent folder hierarchy survives JSON serialization without changing raster output',()=>{
  const {scene,ring,dot,label}=setup();
  const root=addObjectFolder(scene,{name:'Panel'});
  const nested=addObjectFolder(scene,{name:'Radio',parentId:root.id});
  moveObjectsToFolder(scene,[{type:'rect',id:ring.id},{type:'rect',id:dot.id},{type:'text',id:label.id}],nested.id);
  const compiled=compileScene(scene);
  const restored=JSON.parse(JSON.stringify(scene));
  expect(validateScene(restored)).toBe(restored);
  expect(prepareObjectEditorScene(restored).objectFolders).toEqual(scene.objectFolders);
  expect(folderMembers(restored,root.id)).toHaveLength(3);
  expect(compileScene(restored)).toEqual(compiled);
});
