/* Scene-editing operations. No DOM, rasterizer, or server dependencies.
   The editor and simulator operate on the same serialized scene data. */
import {WIDTH,HEIGHT,LAYERS} from './scene.js';

const integer=value=>Math.round(Number(value)||0);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

export function editableScene(scene){
  scene.texts??=[];
  scene.textBuffers??={};
  scene.paletteEvents??=[];
  return scene;
}

export function sceneObjects(scene){
  return [...(scene.shapes||[]).map(object=>({type:'rect',object})),
          ...(scene.texts||[]).map(object=>({type:'text',object}))];
}

export function getObject(scene,type,id){
  return (type==='rect'?scene.shapes:type==='text'?scene.texts:[])
    ?.find(object=>object.id===id)??null;
}

export function nextObjectId(scene){
  return Math.max(0,...sceneObjects(scene).map(({object})=>object.id))+1;
}

export function nextBufferPtr(scene){
  const pointers=Object.keys(scene.textBuffers||{}).map(Number).filter(Number.isFinite);
  return Math.max(0,...pointers)+4096;
}

export function addRectangle(scene){
  editableScene(scene);
  const id=nextObjectId(scene);
  const object={id,x:340,y:210,w:240,h:150,radius:18,layer:Math.min(LAYERS-1,Math.max(22,id))};
  scene.shapes.push(object);
  scene.palette[object.layer]??='#92d0e1';
  if(scene.palette[object.layer]==='#ffffff')scene.palette[object.layer]='#92d0e1';
  return object;
}

export function addText(scene){
  editableScene(scene);
  const id=nextObjectId(scene),ptr=nextBufferPtr(scene);
  const object={id,x:352,y:225,w:380,h:72,layer:Math.min(LAYERS-1,Math.max(25,id)),buffer_ptr:ptr};
  scene.texts.push(object);
  scene.textBuffers[String(ptr)]='HELLO, WORLD!';
  if(scene.palette[object.layer]==='#ffffff')scene.palette[object.layer]='#17212e';
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
  if(['x','y','w','h','layer'].includes(key)){
    const n=integer(value);
    if(key==='layer')object[key]=clamp(n,1,LAYERS-1);
    else if(key==='w'||key==='h')object[key]=Math.max(1,n);
    else object[key]=clamp(n,key==='x'?-WIDTH:-HEIGHT,key==='x'?WIDTH:HEIGHT);
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

export function paletteColor(scene,layer){
  return scene.palette[layer]||'#ffffff';
}

// Presentation-style editing is metadata layered over the same flat scene:
// group_id never changes the rasterizer's shapes/texts instruction format.
const objectKey = ({type,id}) => `${type}:${id}`;
const objectRef = ({type,object}) => ({type,id:object.id});
export function resolveSelection(scene,refs=[]){
  const selected = new Map();
  for(const ref of refs){
    const obj = getObject(scene,ref.type,ref.id);
    if(!obj)continue;
    if(obj.group_id != null){
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

export function selectionUnits(scene,refs=[]){
  const groups=new Map();
  for(const ref of resolveSelection(scene,refs)){
    const obj=getObject(scene,ref.type,ref.id);
    const key=obj.group_id == null?objectKey(ref):`group:${obj.group_id}`;
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
export function moveSelection(scene,refs,dx,dy){
  for(const unit of selectionUnits(scene,refs))shiftUnit(scene,unit,dx,dy);
}
export function alignSelection(scene,refs,mode){
  const units=selectionUnits(scene,refs);
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
export function distributeSelection(scene,refs,axis){
  const horizontal=axis==='horizontal';
  if(!horizontal&&axis!=='vertical')return false;
  const units=selectionUnits(scene,refs).sort((a,b)=>
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
/** Reassign selected objects (including complete groups) to a palette layer.
 * Layer zero is reserved for the canvas background, not drawable objects. */
export function moveSelectionToLayer(scene,refs,layer){
  if(!Number.isInteger(layer)||layer<1||layer>=LAYERS)return 0;
  let moved=0;
  for(const ref of resolveSelection(scene,refs)){
    const object=getObject(scene,ref.type,ref.id);
    if(object&&object.layer!==layer){object.layer=layer;moved++;}
  }
  return moved;
}

/** Containment-based marquee selection. A grouped object is selected only
 * when the entire group's bounding box fits within the marquee. */
export function objectsFullyInsideRect(scene,{left,top,right,bottom}){
  const all=sceneObjects(scene).map(({type,object})=>({type,id:object.id}));
  return selectionUnits(scene,all)
    .filter(unit=>unit.x>=left&&unit.y>=top&&unit.right<=right&&unit.bottom<=bottom)
    .flatMap(unit=>unit.members.map(({type,id})=>({type,id})));
}

export function nextGroupId(scene){
  return Math.max(0,...sceneObjects(scene).map(({object})=>Number(object.group_id)||0))+1;
}
export function groupSelection(scene,refs){
  if(selectionUnits(scene,refs).length<2)return null;
  const id=nextGroupId(scene);
  for(const ref of resolveSelection(scene,refs))getObject(scene,ref.type,ref.id).group_id=id;
  return id;
}
export function ungroupSelection(scene,refs){
  const members=resolveSelection(scene,refs);
  let changed=false;
  for(const ref of members){
    const obj=getObject(scene,ref.type,ref.id);
    if(obj.group_id!=null){delete obj.group_id;changed=true;}
  }
  return changed;
}
export function copySelection(scene,refs){
  return resolveSelection(scene,refs).map(ref=>{
    const obj=getObject(scene,ref.type,ref.id);
    const entry={type:ref.type,object:structuredClone(obj)};
    if(ref.type==='text')entry.buffer=structuredClone(scene.textBuffers[String(obj.buffer_ptr)]??'');
    return entry;
  });
}
export function pasteSelection(scene,clipboard,offset=20){
  editableScene(scene);
  if(!Array.isArray(clipboard)||!clipboard.length)return [];
  const groupIds=new Map(),result=[];
  let nextId=nextObjectId(scene),nextPtr=nextBufferPtr(scene),groupId=nextGroupId(scene);
  for(const entry of clipboard){
    if(!['rect','text'].includes(entry.type)||!entry.object)continue;
    const original=entry.object;
    const obj={...structuredClone(original),id:nextId++,x:original.x+offset,y:original.y+offset};
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
export function deleteSelection(scene,refs){
  const members=resolveSelection(scene,refs);
  for(const ref of members)removeObject(scene,ref.type,ref.id);
  return members.length;
}
