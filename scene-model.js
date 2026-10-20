/* Scene-editing operations. No DOM, rasterizer, or server dependencies.
   The editor and simulator operate on the same serialized scene data. */
import {WIDTH,HEIGHT,LAYERS,canvasSize} from './scene.js';

const integer=value=>Math.round(Number(value)||0);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

// Editor layers have stable, non-numeric identifiers and an explicit order.
// Only compileScene assigns physical palette indices for the raster machine.
export function sceneObjects(scene){
  return [...(scene.shapes||[]).map(object=>({type:'rect',object})),
          ...(scene.texts||[]).map(object=>({type:'text',object}))];
}

export function editableScene(scene){
  if(scene.width===undefined&&scene.height===undefined){scene.width=WIDTH;scene.height=HEIGHT;}
  canvasSize(scene);
  scene.texts??=[];
  scene.textBuffers??={};
  scene.paletteEvents??=[];
  scene.objectFolders??=[];
  if(!Array.isArray(scene.layers)){
    // Import the old numbered format without changing saved legacy examples.
    const base=Array.from({length:LAYERS},(_,i)=>i===0?'#101827':'#ffffff');
    const used=new Set([0]);
    for(const {object} of sceneObjects(scene))used.add(object.layer===0?1:object.layer);
    for(const event of scene.paletteEvents)used.add(event.layer);
    for(let i=1;i<LAYERS;i++){
      if(scene.palette?.[i]!==base[i]||scene.layerNames?.[String(i)])used.add(i);
    }
    scene.layers=[...used].sort((a,b)=>a-b).map(number=>({
      id:number===0?'background':`layer-${number}`,
      name:scene.layerNames?.[String(number)]??'',
      color:scene.palette?.[number]??base[number]
    }));
    for(const {object} of sceneObjects(scene)){
      // The old rasterizer clamped layer-0 objects to drawing slot 1.
      object.layerId=`layer-${object.layer===0?1:object.layer}`;
      delete object.layer;
    }
    for(const event of scene.paletteEvents){
      event.layerId=event.layer===0?'background':`layer-${event.layer}`;
      delete event.layer;
    }
    delete scene.palette;
    delete scene.layerNames;
  }
  return scene;
}

// The persisted `layers` array is a preorder forest of nodes, ordered
// bottom-to-top. A folder is {id:'group-N',kind:'group',name,parentId?}; a
// drawable leaf is {id:'layer-N',name,color,parentId?}. Children follow their
// parent contiguously. An absent parentId means root level. Background stays
// the first, root-level leaf. Folders do not occupy raster palette slots.
const isFolder=node=>node?.kind==='group';
export function getLayerNode(scene,id){
  return editableScene(scene).layers.find(node=>node.id===id)??null;
}
export function getLayer(scene,id){
  const node=getLayerNode(scene,id);
  return node&&!isFolder(node)?node:null;
}
export function drawingLayers(scene){return editableScene(scene).layers.filter(node=>!isFolder(node));}
export function layerIndex(scene,id){return drawingLayers(scene).findIndex(layer=>layer.id===id);}
export function getLayerName(scene,id){return getLayerNode(scene,id)?.name??'';}
export function setLayerName(scene,id,value){
  const layer=getLayerNode(scene,id);
  if(!layer)return false;
  layer.name=String(value??'').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,64);
  return true;
}
export function paletteColor(scene,id){return getLayer(scene,id)?.color??'#ffffff';}
export function setLayerColor(scene,id,color){
  const layer=getLayer(scene,id);
  if(!layer||!/^#[0-9a-f]{6}$/i.test(color))return false;
  layer.color=color;
  return true;
}

// Locate an entire contiguous subtree in the preorder array.
export function layerSubtree(scene,id){
  const nodes=editableScene(scene).layers;
  const index=nodes.findIndex(node=>node.id===id);
  if(index<0)return [];
  const descendants=new Set([id]);
  const result=[nodes[index]];
  for(let i=index+1;i<nodes.length;i++){
    const node=nodes[i];
    if(!descendants.has(node.parentId))break;
    descendants.add(node.id);
    result.push(node);
  }
  return result;
}
export function layerTree(scene){
  const roots=[],active=[],seen=new Set();
  for(const node of editableScene(scene).layers){
    if(seen.has(node.id))throw Error(`Duplicate layer node: ${node.id}`);
    seen.add(node.id);
    if(node.parentId===undefined)active.length=0;
    else{
      while(active.length&&active.at(-1).node.id!==node.parentId)active.pop();
      if(!active.length)throw Error(`Non-contiguous or missing parent: ${node.id}`);
    }
    const branch={node,children:[]};
    (active.length?active.at(-1).children:roots).push(branch);
    if(isFolder(node))active.push(branch);
  }
  return roots;
}
const nextNodeId=(scene,prefix)=>{
  const ids=new Set(scene.layers.map(node=>node.id));
  let number=1;
  for(const id of ids){
    const match=new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    if(match)number=Math.max(number,Number(match[1])+1);
  }
  while(ids.has(`${prefix}-${number}`))number++;
  return `${prefix}-${number}`;
};
// Return the insertion point immediately after the target and all descendants.
const subtreeEnd=(scene,id)=>{
  const index=scene.layers.findIndex(node=>node.id===id);
  return index+layerSubtree(scene,id).length;
};

export function addLayer(scene,{name='',color='#ffffff',aboveId=null,parentId=null}={}){
  editableScene(scene);
  if(drawingLayers(scene).length>=LAYERS||scene.layers.length>=256)return null;
  if(parentId!=null&&!isFolder(getLayerNode(scene,parentId)))return null;
  const node={id:nextNodeId(scene,'layer'),name:String(name).trim().slice(0,64),color};
  if(parentId!=null)node.parentId=parentId;
  const target=aboveId??parentId;
  const index=target==null?scene.layers.length:subtreeEnd(scene,target);
  if(aboveId!=null){
    const sibling=getLayerNode(scene,aboveId);
    if(!sibling||(sibling.parentId??null)!==parentId)return null;
  }
  scene.layers.splice(index,0,node);
  return node;
}

export function addLayerGroup(scene,{name='New group',aboveId=null,parentId=null}={}){
  editableScene(scene);
  if(scene.layers.length>=256)return null;
  if(parentId!=null&&!isFolder(getLayerNode(scene,parentId)))return null;
  const node={id:nextNodeId(scene,'group'),kind:'group',name:String(name).trim().slice(0,64)};
  if(parentId!=null)node.parentId=parentId;
  if(aboveId!=null){
    const sibling=getLayerNode(scene,aboveId);
    if(!sibling||(sibling.parentId??null)!==parentId)return null;
  }
  const index=aboveId!=null?subtreeEnd(scene,aboveId):
    parentId!=null?subtreeEnd(scene,parentId):scene.layers.length;
  scene.layers.splice(index,0,node);
  return node;
}

/** Delete one layer or folder subtree, including shapes, text and palette
 * events belonging to its leaves. Background is permanent. */
export function deleteLayer(scene,id){
  editableScene(scene);
  if(id==='background')return false;
  const branch=layerSubtree(scene,id);
  if(!branch.length)return false;
  const leafIds=new Set(branch.filter(node=>!isFolder(node)).map(node=>node.id));
  const objects=sceneObjects(scene).filter(({object})=>leafIds.has(object.layerId));
  const events=scene.paletteEvents.filter(event=>leafIds.has(event.layerId)).length;
  for(const {type,object} of objects)removeObject(scene,type,object.id);
  scene.paletteEvents=scene.paletteEvents.filter(event=>!leafIds.has(event.layerId));
  const index=scene.layers.findIndex(node=>node.id===id);
  scene.layers.splice(index,branch.length);
  return {objects:objects.length,events};
}

/** Remove a paint layer without deleting scene objects. Reassign its objects
 * and palette overrides to an adjacent surviving layer. The background is
 * permanent and cannot be used for non-background shapes/text. */
export function removePaintLayer(scene,id){
  editableScene(scene);
  if(id==='background'||!getLayer(scene,id))return false;
  const leaves=drawingLayers(scene);
  const index=leaves.findIndex(layer=>layer.id===id);
  if(index<1)return false;
  let destination=leaves[index+1]??leaves[index-1];
  if(!destination||destination.id==='background'){
    destination=addLayer(scene,{name:'Default',color:'#92d0e1',aboveId:id});
    if(!destination)return false;
  }
  for(const {object} of sceneObjects(scene)){
    if(object.layerId===id)object.layerId=destination.id;
  }
  for(const event of scene.paletteEvents){
    if(event.layerId===id)event.layerId=destination.id;
  }
  scene.layers.splice(scene.layers.findIndex(layer=>layer.id===id),1);
  return true;
}

/** Move an entire subtree before, after or into another node. Preorder
 * remains contiguous and folders cannot be moved into their own descendants. */
export function reorderLayer(scene,id,targetId,side='above'){
  editableScene(scene);
  if(id==='background'||id===targetId||!['above','below','inside'].includes(side))return false;
  const moving=layerSubtree(scene,id),target=getLayerNode(scene,targetId);
  if(!moving.length||!target)return false;
  if(moving.some(node=>node.id===targetId))return false;
  if(side==='inside'&&!isFolder(target))return false;
  if(targetId==='background'&&side==='below')return false;
  const from=scene.layers.findIndex(node=>node.id===id);
  const previous=scene.layers.map(node=>({...node}));
  scene.layers.splice(from,moving.length);
  const newParent=side==='inside'?target.id:(target.parentId??null);
  if(newParent==null)delete moving[0].parentId;
  else moving[0].parentId=newParent;
  const at=scene.layers.findIndex(node=>node.id===targetId);
  const index=side==='below'?at:subtreeEnd(scene,targetId);
  scene.layers.splice(index,0,...moving);
  if(scene.layers.length===previous.length&&scene.layers.every((node,i)=>
    node.id===previous[i].id&&(node.parentId??null)===(previous[i].parentId??null)))return false;
  return true;
}

/** Pack only drawable leaves into physical palette slots 0..63; groups are
 * organizational and never change an object's ID, geometry or color. */
export function setCanvasSize(scene,width,height){
  canvasSize({width,height});
  if(scene.width===width&&scene.height===height)return false;
  scene.width=width;
  scene.height=height;
  // Keep artwork at native pixel coordinates, even when the viewport shrinks.
  return true;
}

export function compileScene(source){
  if(!Array.isArray(source.layers))return structuredClone(source);
  const leaves=source.layers.filter(node=>!isFolder(node));
  if(!leaves.length||leaves.length>LAYERS||leaves[0].id!=='background')
    throw Error('Scene must have a background and at most 64 drawable layers');
  // Also verifies parentage, ordering and contiguity of the source tree.
  layerTree(source);
  const slots=new Map(leaves.map((node,index)=>[node.id,index]));
  if(slots.size!==leaves.length)throw Error('Duplicate layer IDs');
  const physical=id=>{
    if(!slots.has(id))throw Error(`Unknown drawable layer: ${id}`);
    return slots.get(id);
  };
  const palette=Array.from({length:LAYERS},(_,i)=>leaves[i]?.color??'#ffffff');
  return {
    ...canvasSize(source),
    palette,
    shapes:(source.shapes??[]).map(({layerId,parentId,group_id,...object})=>({...object,layer:physical(layerId)})),
    texts:(source.texts??[]).map(({layerId,parentId,group_id,...object})=>({...object,layer:physical(layerId)})),
    textBuffers:structuredClone(source.textBuffers??{}),
    paletteEvents:(source.paletteEvents??[]).map(({layerId,...event})=>({...event,layer:physical(layerId)}))
  };
}

export function getObject(scene,type,id){
  return (type==='rect'?scene.shapes:type==='text'?scene.texts:[])
    ?.find(object=>object.id===id)??null;
}

// Object folders are an independent composition hierarchy. They NEVER occupy
// palette slots or change paint order. Object coordinates remain absolute; a
// folder move simply translates all of its descendant primitives.
export function objectFolders(scene){return editableScene(scene).objectFolders;}
export function getObjectFolder(scene,id){return objectFolders(scene).find(f=>f.id===id)??null;}
const folderRoot=(scene,id)=>{
  let folder=getObjectFolder(scene,id);
  const visited=new Set();
  while(folder?.parentId&& !visited.has(folder.id)){
    visited.add(folder.id);
    folder=getObjectFolder(scene,folder.parentId);
  }
  return folder?.id??null;
};
export function folderDescendants(scene,id){
  if(!getObjectFolder(scene,id))return new Set();
  const ids=new Set([id]);
  let changed=true;
  while(changed){
    changed=false;
    for(const folder of objectFolders(scene)){
      if(folder.parentId&&ids.has(folder.parentId)&&!ids.has(folder.id)){
        ids.add(folder.id);changed=true;
      }
    }
  }
  return ids;
}
export function folderMembers(scene,id){
  const ids=folderDescendants(scene,id);
  return sceneObjects(scene).filter(({object})=>ids.has(object.parentId))
    .map(({type,object})=>({type,id:object.id}));
}
export function addObjectFolder(scene,{name='New group',parentId=null}={}){
  const folders=objectFolders(scene);
  if(folders.length>=256||(parentId!=null&&!getObjectFolder(scene,parentId)))return null;
  let n=1;
  while(folders.some(folder=>folder.id===`folder-${n}`))n++;
  const folder={id:`folder-${n}`,name:String(name).replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,64)};
  if(parentId!=null)folder.parentId=parentId;
  folders.push(folder);
  return folder;
}
export function renameObjectFolder(scene,id,name){
  const folder=getObjectFolder(scene,id);
  if(!folder)return false;
  folder.name=String(name??'').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,64);
  return true;
}
export function moveObjectsToFolder(scene,refs,parentId=null){
  if(parentId!=null&&!getObjectFolder(scene,parentId))return 0;
  let count=0;
  for(const ref of refs){
    const obj=getObject(scene,ref.type,ref.id);
    if(!obj||(obj.parentId??null)===parentId)continue;
    if(parentId==null)delete obj.parentId;
    else obj.parentId=parentId;
    count++;
  }
  return count;
}
export function moveObjectFolder(scene,id,parentId=null){
  const folder=getObjectFolder(scene,id);
  if(!folder||(folder.parentId??null)===parentId||
     (parentId!=null&&(!getObjectFolder(scene,parentId)||folderDescendants(scene,id).has(parentId))))return false;
  if(parentId==null)delete folder.parentId;
  else folder.parentId=parentId;
  return true;
}
// Deleting a folder keeps its content: promote immediate children to the
// deleted folder's parent rather than deleting artwork.
export function deleteObjectFolder(scene,id){
  const folder=getObjectFolder(scene,id);
  if(!folder)return false;
  const parentId=folder.parentId??null;
  for(const child of objectFolders(scene).filter(child=>child.parentId===id)){
    if(parentId==null)delete child.parentId;
    else child.parentId=parentId;
  }
  for(const {object} of sceneObjects(scene).filter(({object})=>object.parentId===id)){
    if(parentId==null)delete object.parentId;
    else object.parentId=parentId;
  }
  scene.objectFolders=scene.objectFolders.filter(item=>item.id!==id);
  return true;
}
export function moveObjectFolderContents(scene,id,dx,dy){
  const refs=folderMembers(scene,id);
  for(const ref of refs){
    const obj=getObject(scene,ref.type,ref.id);
    moveObject(scene,ref.type,ref.id,obj.x,obj.y,dx,dy);
  }
  return refs.length;
}
// One-time, lossless import from the former paint-layer folder structure and
// old Group action. Keep legacy helpers for loading older undo/test fixtures.
export function prepareObjectEditorScene(scene){
  editableScene(scene);
  const paintNodes=scene.layers.filter(node=>node.kind!=='group');
  if(paintNodes.length!==scene.layers.length||paintNodes.some(node=>node.parentId!=null)){
    scene.layers=paintNodes.map(({parentId,...node})=>node);
  }
  const groups=new Map();
  for(const {object} of sceneObjects(scene)){
    if(object.group_id==null)continue;
    if(!groups.has(object.group_id)){
      groups.set(object.group_id,addObjectFolder(scene,{name:`Group ${object.group_id}`}));
    }
    object.parentId=groups.get(object.group_id).id;
    delete object.group_id;
  }
  return scene;
}

export function nextObjectId(scene){
  return Math.max(0,...sceneObjects(scene).map(({object})=>object.id))+1;
}

export function nextBufferPtr(scene){
  const pointers=Object.keys(scene.textBuffers||{}).map(Number).filter(Number.isFinite);
  return Math.max(0,...pointers)+4096;
}

export function addRectangle(scene,requestedLayer=null){
  editableScene(scene);
  const id=nextObjectId(scene);
  let layerId=getLayer(scene,requestedLayer)?.id??drawingLayers(scene).at(-1)?.id;
  if(!layerId||layerId==='background')layerId=addLayer(scene,{color:'#92d0e1'}).id;
  const {width,height}=canvasSize(scene);
  const object={id,x:340+Math.round((width-WIDTH)/2),y:210+Math.round((height-HEIGHT)/2),w:240,h:150,radius:18,layerId};
  scene.shapes.push(object);
  return object;
}

export function addText(scene,requestedLayer=null){
  editableScene(scene);
  const id=nextObjectId(scene),ptr=nextBufferPtr(scene);
  let layerId=getLayer(scene,requestedLayer)?.id??drawingLayers(scene).at(-1)?.id;
  if(!layerId||layerId==='background')layerId=addLayer(scene,{color:'#17212e'}).id;
  const {width,height}=canvasSize(scene);
  const object={id,x:352+Math.round((width-WIDTH)/2),y:225+Math.round((height-HEIGHT)/2),w:380,h:72,layerId,buffer_ptr:ptr};
  scene.texts.push(object);
  scene.textBuffers[String(ptr)]='HELLO, WORLD!';
  return object;
}

export function removeObject(scene,type,id){
  const collection=type==='rect'?scene.shapes:type==='text'?scene.texts:null;
  if(!collection)return false;
  const index=collection.findIndex(object=>object.id===id);
  if(index<0)return false;
  const [removed]=collection.splice(index,1);
  if(type==='text' && !scene.texts.some(object=>String(object.buffer_ptr)===String(removed.buffer_ptr))){
    delete scene.textBuffers[String(removed.buffer_ptr)];
  }
  return true;
}

export function duplicateObject(scene,type,id){
  const original=getObject(scene,type,id);
  if(!original)return null;
  const copy={...original,id:nextObjectId(scene),x:original.x+18,y:original.y+18};
  if(type==='rect'){
    copy.radius=Array.isArray(original.radius)?[...original.radius]:original.radius;
    scene.shapes.push(copy);
  }else{
    const ptr=nextBufferPtr(scene);
    copy.buffer_ptr=ptr;
    const content=scene.textBuffers[String(original.buffer_ptr)];
    scene.textBuffers[String(ptr)]=Array.isArray(content)?[...content]:content??'';
    scene.texts.push(copy);
  }
  return copy;
}

export function updateObject(scene,type,id,key,value){
  const object=getObject(scene,type,id);
  if(!object)return false;
  if(['x','y','w','h'].includes(key)){
    const {width,height}=canvasSize(scene);
    const n=integer(value);
    if(key==='w'||key==='h')object[key]=Math.max(1,n);
    else object[key]=clamp(n,key==='x'?-width:-height,key==='x'?width:height);
  }else if(key==='layerId'){
    if(value==='background'||!getLayer(scene,value))return false;
    object.layerId=value;
  }else if(key==='radius'&&type==='rect'){
    const nums=String(value).trim().split(/[\s,]+/).filter(Boolean).slice(0,4)
      .map(v=>Math.max(0,integer(v)));
    object.radius=nums.length<=1?(nums[0]??0):nums;
  }else return false;
  return true;
}

export function moveObject(scene,type,id,startX,startY,dx,dy){
  const object=getObject(scene,type,id);
  if(!object)return;
  updateObject(scene,type,id,'x',startX+integer(dx));
  updateObject(scene,type,id,'y',startY+integer(dy));
}

export function resizeObject(scene,type,id,startW,startH,dx,dy){
  const object=getObject(scene,type,id);
  if(!object)return;
  updateObject(scene,type,id,'w',startW+integer(dx));
  updateObject(scene,type,id,'h',startH+integer(dy));
}

export function radiusCss(radius){
  return (Array.isArray(radius)?radius:[radius??0]).map(v=>Math.max(0,integer(v))+'px').join(' ');
}

/** CSS thumbnail geometry, scaled uniformly from real object dimensions.
 * Corner radii scale by the same factor as its rectangle, preserving the
 * visual shape rather than merely displaying an oversized color swatch. */
export function rectangleThumbnail(rect,maxWidth=124,maxHeight=78){
  const width=Math.max(1,Number(rect.w)||1);
  const height=Math.max(1,Number(rect.h)||1);
  const scale=Math.min(maxWidth/width,maxHeight/height);
  const px=value=>Math.round(value*1000)/1000;
  const radius=Array.isArray(rect.radius)?rect.radius:
    typeof rect.radius==='string'?rect.radius.trim().split(/[\s,]+/).filter(Boolean):[rect.radius??0];
  const cssRadius=radius.map(value=>`${px(Math.max(0,Number(value)||0)*scale)}px`).join(' ');
  return {width:px(width*scale),height:px(height*scale),borderRadius:cssRadius};
}

// Composition-folder membership is authoring metadata over the flat scene;
// legacy group_id remains supported only for older fixtures and imports.
const objectKey = ({type,id}) => `${type}:${id}`;
const objectRef = ({type,object}) => ({type,id:object.id});
export function resolveSelection(scene,refs=[],{expandGroups=true}={}){
  const selected = new Map();
  for(const ref of refs){
    const obj = getObject(scene,ref.type,ref.id);
    if(!obj)continue;
    if(expandGroups&&obj.parentId&&getObjectFolder(scene,obj.parentId)){
      for(const member of folderMembers(scene,folderRoot(scene,obj.parentId))){
        selected.set(objectKey(member),member);
      }
    }else if(expandGroups&&obj.group_id != null){
      for(const item of sceneObjects(scene)){
        if(item.object.group_id === obj.group_id){
          const member=objectRef(item);
          selected.set(objectKey(member),member);
        }
      }
    }else selected.set(objectKey(ref),{type:ref.type,id:ref.id});
  }
  return [...selected.values()];
}

export function selectionUnits(scene,refs=[],options={}){
  const groups=new Map();
  for(const ref of resolveSelection(scene,refs,options)){
    const obj=getObject(scene,ref.type,ref.id);
    // Exact selection really means individual primitives, even when they
    // happen to share a composition folder. Group only in normal mode.
    const key=options.expandGroups===false?objectKey(ref):
      obj.parentId&&getObjectFolder(scene,obj.parentId)
        ?`folder:${folderRoot(scene,obj.parentId)}`:
        obj.group_id == null?objectKey(ref):`group:${obj.group_id}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({type:ref.type,id:ref.id,object:obj});
  }
  return [...groups.values()].map(members=>{
    const x=Math.min(...members.map(m=>m.object.x));
    const y=Math.min(...members.map(m=>m.object.y));
    const right=Math.max(...members.map(m=>m.object.x+m.object.w));
    const bottom=Math.max(...members.map(m=>m.object.y+m.object.h));
    return {members,x,y,w:right-x,h:bottom-y,right,bottom};
  });
}

const shiftUnit=(scene,unit,dx,dy)=>{
  for(const ref of unit.members){
    const obj=getObject(scene,ref.type,ref.id);
    moveObject(scene,ref.type,ref.id,obj.x,obj.y,dx,dy);
  }
};
export function moveSelection(scene,refs,dx,dy,options={}){
  for(const unit of selectionUnits(scene,refs,options))shiftUnit(scene,unit,dx,dy);
}
export function alignSelection(scene,refs,mode,options={}){
  const units=selectionUnits(scene,refs,options);
  if(units.length<2)return false;
  const minX=Math.min(...units.map(u=>u.x)),minY=Math.min(...units.map(u=>u.y));
  const maxX=Math.max(...units.map(u=>u.right)),maxY=Math.max(...units.map(u=>u.bottom));
  for(const unit of units){
    let dx=0,dy=0;
    switch(mode){
      case 'left': dx=minX-unit.x;break;
      case 'center': dx=Math.round((minX+maxX-unit.w)/2)-unit.x;break;
      case 'right': dx=maxX-unit.right;break;
      case 'top': dy=minY-unit.y;break;
      case 'middle': dy=Math.round((minY+maxY-unit.h)/2)-unit.y;break;
      case 'bottom':dy=maxY-unit.bottom;break;
      default:return false;
    }
    shiftUnit(scene,unit,dx,dy);
  }
  return true;
}
export function distributeSelection(scene,refs,axis,options={}){
  const horizontal=axis==='horizontal';
  if(!horizontal&&axis!=='vertical')return false;
  const units=selectionUnits(scene,refs,options).sort((a,b)=>
    (horizontal?a.x-b.x:a.y-b.y)||(horizontal?a.y-b.y:a.x-b.x));
  if(units.length<3)return false;
  const start=horizontal?units[0].x:units[0].y;
  const end=horizontal?units.at(-1).right:units.at(-1).bottom;
  const sizeSum=units.reduce((total,u)=>total+(horizontal?u.w:u.h),0);
  const gap=(end-start-sizeSum)/(units.length-1);
  let position=start;
  for(const unit of units){
    const old=horizontal?unit.x:unit.y;
    const delta=Math.round(position)-old;
    shiftUnit(scene,unit,horizontal?delta:0,horizontal?0:delta);
    position+=(horizontal?unit.w:unit.h)+gap;
  }
  return true;
}
/** Reassign selected objects (including complete groups) to a stable layer ID. */
export function moveSelectionToLayer(scene,refs,layerId,options={}){
  if(layerId==='background'||!getLayer(scene,layerId))return 0;
  let moved=0;
  for(const ref of resolveSelection(scene,refs,options)){
    const object=getObject(scene,ref.type,ref.id);
    if(object&&object.layerId!==layerId){object.layerId=layerId;moved++;}
  }
  return moved;
}

/** Containment-based marquee selection. A grouped object is selected only
 * when the entire group's bounding box fits within the marquee. */
export function objectsFullyInsideRect(scene,{left,top,right,bottom},options={}){
  const all=sceneObjects(scene).map(({type,object})=>({type,id:object.id}));
  return selectionUnits(scene,all,options)
    .filter(unit=>unit.x>=left&&unit.y>=top&&unit.right<=right&&unit.bottom<=bottom)
    .flatMap(unit=>unit.members.map(({type,id})=>({type,id})));
}

export function nextGroupId(scene){
  return Math.max(0,...sceneObjects(scene).map(({object})=>Number(object.group_id)||0))+1;
}
export function groupSelection(scene,refs,options={}){
  if(selectionUnits(scene,refs,options).length<2)return null;
  const id=nextGroupId(scene);
  for(const ref of resolveSelection(scene,refs,options))getObject(scene,ref.type,ref.id).group_id=id;
  return id;
}
export function ungroupSelection(scene,refs,options={}){
  const members=resolveSelection(scene,refs,options);
  let changed=false;
  for(const ref of members){
    const obj=getObject(scene,ref.type,ref.id);
    if(obj.group_id!=null){delete obj.group_id;changed=true;}
  }
  return changed;
}
export function copySelection(scene,refs,options={}){
  return resolveSelection(scene,refs,options).map(ref=>{
    const obj=getObject(scene,ref.type,ref.id);
    const entry={type:ref.type,object:structuredClone(obj)};
    if(ref.type==='text')entry.buffer=structuredClone(scene.textBuffers[String(obj.buffer_ptr)]??'');
    return entry;
  });
}
export function pasteSelection(scene,clipboard,offset=20){
  editableScene(scene);
  if(!Array.isArray(clipboard)||!clipboard.length)return [];
  if(drawingLayers(scene).length===1)addLayer(scene,{color:'#92d0e1'});
  const groupIds=new Map(),result=[];
  let nextId=nextObjectId(scene),nextPtr=nextBufferPtr(scene),groupId=nextGroupId(scene);
  for(const entry of clipboard){
    if(!['rect','text'].includes(entry.type)||!entry.object)continue;
    const original=entry.object;
    const obj={...structuredClone(original),id:nextId++,x:original.x+offset,y:original.y+offset};
    if(!getLayer(scene,obj.layerId))obj.layerId=drawingLayers(scene).at(-1).id;
    // Clipboard content can outlive its source scene. Never paste an object
    // with a parent folder that does not exist in the destination scene.
    if(obj.parentId!=null&&!getObjectFolder(scene,obj.parentId))delete obj.parentId;
    if(original.group_id!=null){
      if(!groupIds.has(original.group_id))groupIds.set(original.group_id,groupId++);
      obj.group_id=groupIds.get(original.group_id);
    }
    if(entry.type==='text'){
      obj.buffer_ptr=nextPtr;
      scene.textBuffers[String(nextPtr)]=structuredClone(entry.buffer??'');
      nextPtr+=4096;
      scene.texts.push(obj);
    }else scene.shapes.push(obj);
    result.push({type:entry.type,id:obj.id});
  }
  return result;
}
export function deleteSelection(scene,refs,options={}){
  const members=resolveSelection(scene,refs,options);
  for(const ref of members)removeObject(scene,ref.type,ref.id);
  return members.length;
}
