/* Local-only named JSON scene storage. Files live in ./scenes next to the Bun
   server, never in the browser or an upload/download workflow. */
import {mkdir, readdir, lstat, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const MAX_SCENE_BYTES = 1024 * 1024;

export class SceneStoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function sceneName(value) {
  if (typeof value !== 'string') throw new SceneStoreError('Scene name must be a string');
  const name = value.trim().replace(/\.json$/i, '');
  // Deliberately disallow all path separators, dot paths, and URL syntax.
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(name)) {
    throw new SceneStoreError('Use a scene name of 1–64 letters, numbers, spaces, underscores, or hyphens');
  }
  return name;
}

export function validateScene(scene) {
  if(!scene||typeof scene!=='object'||Array.isArray(scene)||
     !Array.isArray(scene.shapes)||!Array.isArray(scene.paletteEvents)||
     (scene.texts!=null&&!Array.isArray(scene.texts))||
     (scene.textBuffers!=null&&(typeof scene.textBuffers!=='object'||!scene.textBuffers||Array.isArray(scene.textBuffers)))){
    throw new SceneStoreError('Scene requires shapes, paletteEvents and optional texts/textBuffers');
  }
  const ordered=scene.layers!==undefined;
  let ids,drawableIds;
  if(ordered){
    if(!Array.isArray(scene.layers)||scene.layers.length<1||scene.layers.length>256||
       scene.layers[0]?.id!=='background')throw new SceneStoreError('Ordered scene needs a background and at most 256 tree nodes');
    ids=new Set();
    drawableIds=new Set();
    const activeGroups=[];
    let drawable=0;
    for(let i=0;i<scene.layers.length;i++){
      const node=scene.layers[i];
      const group=node?.kind==='group';
      if(!node||typeof node!=='object'||Array.isArray(node)||
         typeof node.id!=='string'||
         !(group?/^group-[1-9][0-9]*$/.test(node.id):/^(background|layer-[1-9][0-9]*)$/.test(node.id))||
         (!group&&node.kind!==undefined)||ids.has(node.id)||
         typeof node.name!=='string'||node.name.length>64||
         node.name!==node.name.trim()||/[\x00-\x1f\x7f]/.test(node.name)||
         (group?node.color!==undefined:typeof node.color!=='string'||!/^#[0-9a-f]{6}$/i.test(node.color))||
         (node.parentId!==undefined&&(typeof node.parentId!=='string'||!/^group-[1-9][0-9]*$/.test(node.parentId)))){
        throw new SceneStoreError('Invalid or duplicate tree node');
      }
      ids.add(node.id);
      if(!group){
        drawableIds.add(node.id);
        if(++drawable>64)throw new SceneStoreError('At most 64 drawable layers, including background');
      }
      if(i===0){
        if(group||node.parentId!==undefined)throw new SceneStoreError('Background must be a root drawing layer');
      }else if(node.id==='background')throw new SceneStoreError('Background cannot be duplicated or moved');
      if(node.parentId===undefined){
        activeGroups.length=0;
      }else{
        while(activeGroups.length&&activeGroups.at(-1)!==node.parentId)activeGroups.pop();
        if(!activeGroups.length)throw new SceneStoreError('Non-contiguous, cyclic or missing parent layer group');
      }
      if(group)activeGroups.push(node.id);
    }
  }else{
    if(!Array.isArray(scene.palette)||scene.palette.length!==64||
       !scene.palette.every(color=>typeof color==='string'&&/^#[0-9a-f]{6}$/i.test(color))){
      throw new SceneStoreError('Legacy scene requires 64 valid palette colors');
    }
    if(scene.layerNames!==undefined&&
      (!scene.layerNames||typeof scene.layerNames!=='object'||Array.isArray(scene.layerNames)||
       !Object.entries(scene.layerNames).every(([layer,name])=>
         /^(0|[1-9][0-9]?)$/.test(layer)&&Number(layer)<64&&
         typeof name==='string'&&name.length>0&&name.length<=64&&
         name.trim()===name&&!/[\x00-\x1f\x7f]/.test(name)))){
      throw new SceneStoreError('Invalid legacy layer names');
    }
  }
  const validObject=obj=>obj&&typeof obj==='object'&&
    ['id','x','y','w','h'].every(key=>Number.isFinite(obj[key]))&&
    Number.isInteger(obj.id)&&obj.w>0&&obj.h>0&&
    (ordered?typeof obj.layerId==='string'&&drawableIds.has(obj.layerId)&&obj.layerId!=='background':
      Number.isInteger(obj.layer)&&obj.layer>=0&&obj.layer<64);
  if(!scene.shapes.every(obj=>validObject(obj)&&
      (obj.radius===undefined||typeof obj.radius==='number'&&Number.isFinite(obj.radius)||
       Array.isArray(obj.radius)&&obj.radius.length>=1&&obj.radius.length<=4&&
       obj.radius.every(value=>typeof value==='number'&&Number.isFinite(value))))){
    throw new SceneStoreError('Invalid rectangle in scene');
  }
  if(!(scene.texts??[]).every(obj=>validObject(obj)&&
      (typeof obj.buffer_ptr==='number'||typeof obj.buffer_ptr==='string')&&
      Object.hasOwn(scene.textBuffers??{},String(obj.buffer_ptr)))){
    throw new SceneStoreError('Invalid text object or missing buffer');
  }
  if(!Object.values(scene.textBuffers??{}).every(value=>typeof value==='string'||
      Array.isArray(value)&&value.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255))){
    throw new SceneStoreError('Invalid text buffer');
  }
  if(!scene.paletteEvents.every(event=>event&&Number.isInteger(event.y)&&event.y>=0&&event.y<720&&
      (ordered?typeof event.layerId==='string'&&drawableIds.has(event.layerId):
       Number.isInteger(event.layer)&&event.layer>=0&&event.layer<64)&&
      typeof event.color==='string'&&/^#[0-9a-f]{6}$/i.test(event.color))){
    throw new SceneStoreError('Invalid palette event');
  }
  return scene;
}
export function createSceneStore(directory = join(import.meta.dir, 'scenes')) {
  const filename = name => join(directory, sceneName(name) + '.json');
  return {
    async list() {
      let entries;
      try { entries = await readdir(directory, {withFileTypes: true}); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => entry.name.slice(0, -5))
        .filter(name => { try { return sceneName(name) === name; } catch { return false; } })
        .sort((a, b) => a.localeCompare(b));
    },
    async load(name) {
      const path = filename(name);
      let info;
      try { info = await lstat(path); }
      catch (error) {
        if (error.code === 'ENOENT') throw new SceneStoreError('Scene not found', 404);
        throw error;
      }
      if (!info.isFile()) throw new SceneStoreError('Scene is not a regular file', 400);
      if (info.size > MAX_SCENE_BYTES) throw new SceneStoreError('Scene too large', 413);
      const source = await readFile(path, 'utf8');
      if (Buffer.byteLength(source) > MAX_SCENE_BYTES) throw new SceneStoreError('Scene too large', 413);
      let value;
      try { value = JSON.parse(source); }
      catch { throw new SceneStoreError('Saved scene contains invalid JSON'); }
      return validateScene(value);
    },
    async save(name, value) {
      const canonical = sceneName(name);
      validateScene(value);
      const text = JSON.stringify(value, null, 2) + '\n';
      if (Buffer.byteLength(text) > MAX_SCENE_BYTES) throw new SceneStoreError('Scene too large', 413);
      await mkdir(directory, {recursive: true});
      const temp = join(directory, `.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, text, {flag: 'wx'});
        await rename(temp, filename(canonical));
      } finally {
        await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return canonical;
    }
  };
}
