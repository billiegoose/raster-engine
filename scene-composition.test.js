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

test('legacy paint groups flatten and legacy object memberships become composition groups',()=>{
  // amber-components.json now uses the new representation. Construct an actual
  // legacy fixture in memory so this remains a migration test independently
  // of what is saved in the editable example scene.
  const source=JSON.parse(readFileSync(new URL('./scenes/amber-components.json',import.meta.url),'utf8'));
  delete source.objectFolders;
  for(const object of [...source.shapes,...source.texts]){
    delete object.parentId;
    delete object.group_id;
  }
  source.layers.splice(1,0,{id:'group-991',kind:'group',name:'Legacy paint group'});
  source.layers[2].parentId='group-991';
  source.layers[3].parentId='group-991';
  const expected=compileScene(source);
  const before=source.layers.filter(l=>l.kind!=='group').map(l=>[l.id,l.name,l.color]);
  const rect=source.shapes[0],text=source.texts[0];
  rect.group_id=991;text.group_id=991;
  const migrated=prepareObjectEditorScene(source);
  expect(migrated.layers.every(l=>l.kind!=='group'&&l.parentId===undefined)).toBe(true);
  expect(migrated.layers.map(l=>[l.id,l.name,l.color])).toEqual(before);
  expect(migrated.objectFolders).toHaveLength(1);
  const imported=objectFolders(migrated).find(group=>group.name==='Group 991');
  expect(imported).toBeDefined();
  expect(folderMembers(migrated,imported.id)).toHaveLength(2);
  expect(rect.group_id).toBeUndefined();
  expect(text.group_id).toBeUndefined();
  expect(compileScene(migrated)).toEqual(expected);
  expect(validateScene(migrated)).toBe(migrated);
  expect(prepareObjectEditorScene(migrated)).toBe(migrated);
  expect(migrated.objectFolders).toHaveLength(1);
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


test('amber-os has meaningful nested composition group names and unchanged legacy grouping',()=>{
  const scene=JSON.parse(readFileSync(new URL('./scenes/amber-os.json',import.meta.url),'utf8'));
  expect(validateScene(scene)).toBe(scene);
  const names=scene.objectFolders.map(group=>group.name);
  expect(names).toEqual(expect.arrayContaining(['Active Message','Left Window','Right Window']));
  const left=scene.objectFolders.find(group=>group.name==='Left Window');
  const active=scene.objectFolders.find(group=>group.name==='Active Message');
  const right=scene.objectFolders.find(group=>group.name==='Right Window');
  expect(active.parentId).toBe(left.id);
  expect(folderMembers(scene,left.id)).toHaveLength(6);
  expect(folderMembers(scene,active.id)).toHaveLength(3);
  expect(folderMembers(scene,right.id)).toHaveLength(2);
  const compiled=compileScene(scene);
  expect(compileScene(prepareObjectEditorScene(structuredClone(scene)))).toEqual(compiled);
  expect(scene.shapes.every(shape=>shape.group_id===undefined)).toBe(true);
  expect(scene.texts.every(text=>text.group_id===undefined)).toBe(true);
});


test('amber-components has meaningful nested groups and no legacy object group IDs',()=>{
  const scene=JSON.parse(readFileSync(new URL('./scenes/amber-components.json',import.meta.url),'utf8'));
  expect(validateScene(scene)).toBe(scene);
  const groups=new Map(scene.objectFolders.map(group=>[group.name,group]));
  expect(scene.objectFolders).toHaveLength(46);
  expect(scene.objectFolders.filter(group=>group.parentId===undefined).map(group=>group.name)).toEqual([
    'Header','Palette Panel','Buttons Panel','Text Fields Panel',
    'Choices Panel','Values Panel','Status Bar','Tabs Panel','Lists Panel'
  ]);
  const children={
    'Base Swatch':'Palette Panel',
    'Primary Button':'Buttons Panel',
    'Required Text Field':'Text Fields Panel',
    'Required Marker':'Required Text Field',
    'Insertion Caret':'Standard Text Field',
    'Checked Checkmark':'Checked Checkbox',
    'Toggle On':'Choices Panel',
    'Progress Bar':'Values Panel',
    'Volume Slider':'Values Panel'
  };
  for(const [child,parent] of Object.entries(children)){
    expect(groups.get(child)?.parentId).toBe(groups.get(parent)?.id);
  }
  expect(folderMembers(scene,groups.get('Header').id)).toHaveLength(6);
  expect(folderMembers(scene,groups.get('Values Panel').id)).toHaveLength(12);
  expect(scene.shapes).toHaveLength(82);
  expect(scene.texts).toHaveLength(46);
  expect([...scene.shapes,...scene.texts].every(object=>object.group_id===undefined)).toBe(true);
  expect(compileScene(prepareObjectEditorScene(structuredClone(scene)))).toEqual(compileScene(scene));
});


test('amber-components tabs use square geometry and inverse video on the active tab',()=>{
  const scene=JSON.parse(readFileSync(new URL('./scenes/amber-components.json',import.meta.url),'utf8'));
  const groups=new Map(scene.objectFolders.map(group=>[group.name,group]));
  const tabs=groups.get('Tabs Panel');
  expect(tabs).toBeDefined();
  const labels=['OVERVIEW','FILES','TASKS','SETTINGS'];
  const selected=groups.get('Tab: OVERVIEW (selected)');
  expect(selected?.parentId).toBe(tabs.id);
  for(const name of labels){
    const group=groups.get(`Tab: ${name}${name==='OVERVIEW'?' (selected)':''}`);
    expect(group?.parentId).toBe(tabs.id);
    const rects=scene.shapes.filter(shape=>shape.parentId===group.id);
    const texts=scene.texts.filter(text=>text.parentId===group.id);
    expect(rects.length).toBe(name==='OVERVIEW'?1:2);
    expect(rects.every(rect=>rect.radius===0)).toBe(true);
    expect(texts).toHaveLength(1);
    expect(scene.textBuffers[String(texts[0].buffer_ptr)]).toBe(name);
    expect(texts[0].layerId).toBe(name==='OVERVIEW'?'layer-7':'layer-6');
    expect(rects[0].layerId).toBe(name==='OVERVIEW'?'layer-6':'layer-3');
  }
  expect(groups.get('Overview Tab Content')?.parentId).toBe(tabs.id);
});

test('amber-components lists use inverse video for selected items and dim disabled entries',()=>{
  const scene=JSON.parse(readFileSync(new URL('./scenes/amber-components.json',import.meta.url),'utf8'));
  const groups=new Map(scene.objectFolders.map(group=>[group.name,group]));
  const panel=groups.get('Lists Panel');
  const list=groups.get('Selection List');
  expect(list?.parentId).toBe(panel.id);
  const items=[
    ['SCENE EDITOR',false,false],
    ['COMPONENTS',true,false],
    ['FONT ATLAS',false,false],
    ['PALETTE',false,false],
    ['EXPORT',false,true]
  ];
  for(const [label,selected,disabled] of items){
    const name=`List Item: ${label}${selected?' (selected)':disabled?' (disabled)':''}`;
    const row=groups.get(name);
    expect(row?.parentId).toBe(list.id);
    const text=scene.texts.find(item=>item.parentId===row.id&&scene.textBuffers[String(item.buffer_ptr)]===label);
    expect(text).toBeDefined();
    expect(text.layerId).toBe(selected?'layer-7':disabled?'layer-3':'layer-6');
    const rectangles=scene.shapes.filter(shape=>shape.parentId===row.id);
    expect(rectangles.every(rect=>rect.radius===0)).toBe(true);
    if(selected){
      expect(rectangles.some(rect=>rect.layerId==='layer-6'&&rect.w>=800)).toBe(true);
    }else{
      expect(rectangles.some(rect=>rect.layerId==='layer-6'&&rect.w>=800)).toBe(false);
    }
  }
  expect(validateScene(scene)).toBe(scene);
});
