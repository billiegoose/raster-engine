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
