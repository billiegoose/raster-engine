/* DOM scene editor. This is deliberately NOT a rasterizer: the scene is edited
   as CSS rounded rectangles and text regions, while the simulator owns pixels.
   Coordinates and object dimensions remain in 1280 x 720 scene units. */
import {WIDTH,HEIGHT,LAYERS} from './scene.js';
import {editableScene,sceneObjects,getObject,addRectangle,addText,removeObject,
        duplicateObject,updateObject,moveObject,resizeObject,radiusCss,paletteColor}
  from './scene-model.js';

const $=id=>document.getElementById(id);
const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const colorInput=value=>/^#[0-9a-fA-F]{6}$/.test(value??'')?value:'#ffffff';
const objectName=(type,object,scene)=>type==='rect'?`Rectangle ${object.id}`:
  `Text ${object.id} · ${String(scene.textBuffers[String(object.buffer_ptr)]??'').split('\n')[0].slice(0,22)}`;
const numericField=(key,label,value,min,max)=>`<label class="property-field">${label}<input type="number" data-property="${key}" value="${html(value)}" min="${min}" max="${max}" step="1"></label>`;

export function createSceneEditor({getScene,onChange,onSimulate,onReset}){
  const stage=$('editor-stage'),shell=$('editor-canvas-shell');
  const objectList=$('object-list'),properties=$('object-properties');
  let selection=null,drag=null,scale=1;
  const scene=()=>editableScene(getScene());
  const notify=()=>onChange?.();

  function resizeStage(){
    const width=shell.clientWidth || WIDTH;
    scale=Math.min(1,width/WIDTH);
    stage.style.transform=`scale(${scale})`;
    shell.style.height=`${Math.ceil(HEIGHT*scale)}px`;
  }

  function updateDomObject(element,type,object,data){
    element.style.left=`${object.x}px`;
    element.style.top=`${object.y}px`;
    element.style.width=`${Math.max(1,object.w)}px`;
    element.style.height=`${Math.max(1,object.h)}px`;
    element.style.zIndex=String(object.layer);
    element.style.backgroundColor=type==='rect'?paletteColor(data,object.layer):'transparent';
    element.style.color=type==='text'?paletteColor(data,object.layer):'';
    if(type==='rect')element.style.borderRadius=radiusCss(object.radius);
    if(type==='text'){
      const content=element.querySelector('.text-content');
      const raw=data.textBuffers[String(object.buffer_ptr)];
      if(content)content.textContent=typeof raw==='string'?raw:
        Array.isArray(raw)?String.fromCharCode(...raw):'';
    }
  }

  function renderStage(){
    const data=scene();
    stage.style.backgroundColor=colorInput(data.palette[0]||'#101827');
    stage.replaceChildren();
    for(const {type,object} of sceneObjects(data)){
      const el=document.createElement('div');
      el.className=`scene-object ${type==='rect'?'scene-rectangle':'scene-text'}${selection?.type===type&&selection.id===object.id?' is-selected':''}`;
      el.dataset.objectType=type;
      el.dataset.objectId=String(object.id);
      el.setAttribute('role','button');
      el.setAttribute('tabindex','0');
      el.setAttribute('aria-label',objectName(type,object,data));
      if(type==='text'){
        const label=document.createElement('span');
        label.className='text-content';
        el.append(label);
      }
      updateDomObject(el,type,object,data);
      if(selection?.type===type&&selection.id===object.id){
        const handle=document.createElement('span');
        handle.className='object-resize-handle';
        handle.dataset.dragHandle='resize';
        handle.setAttribute('aria-hidden','true');
        el.append(handle);
      }
      stage.append(el);
    }
  }

  function renderObjectList(){
    const data=scene();
    const filter=$('object-filter').value.trim().toLowerCase();
    const items=sceneObjects(data).sort((a,b)=>b.object.layer-a.object.layer||b.object.id-a.object.id);
    $('object-count').textContent=`${items.length} objects`;
    $('editor-stats').textContent=`${data.shapes.length} rectangles · ${data.texts.length} text objects`;
    objectList.innerHTML=items.filter(({type,object})=>
      objectName(type,object,data).toLowerCase().includes(filter))
      .map(({type,object})=>`<button type="button" class="object-list-item${selection?.type===type&&selection.id===object.id?' is-selected':''}" data-select-type="${type}" data-select-id="${object.id}" aria-pressed="${selection?.type===type&&selection.id===object.id}">
          <span class="object-swatch" style="background:${html(colorInput(paletteColor(data,object.layer)))}"></span>
          <span class="object-list-text"><strong>${html(objectName(type,object,data))}</strong><small>${type==='rect'?'Rounded rectangle':'Text buffer '+object.buffer_ptr} · ${object.x}, ${object.y}</small></span>
          <span class="object-layer">L${object.layer}</span>
        </button>`).join('')||'<p class="empty">No matching objects.</p>';
  }

  function renderProperties(){
    const data=scene();
    const obj=selection?getObject(data,selection.type,selection.id):null;
    if(!obj){
      selection=null;
      $('selection-summary').textContent='';
      properties.innerHTML='<p class="empty">Select an object on the canvas or in the object list.</p>';
      return;
    }
    const type=selection.type;
    $('selection-summary').textContent=type==='text'?'TEXT':'ROUND_RECT';
    const fields=[numericField('x','X',obj.x,-WIDTH,WIDTH),numericField('y','Y',obj.y,-HEIGHT,HEIGHT),
      numericField('w','Width',obj.w,1,WIDTH),numericField('h','Height',obj.h,1,HEIGHT),
      numericField('layer','Layer (z-index)',obj.layer,1,LAYERS-1)].join('');
    const radius=type==='rect'?`<label class="property-field property-full">Corner radius <input data-property="radius" type="text" value="${html(Array.isArray(obj.radius)?obj.radius.join(' '):obj.radius??0)}" aria-label="CSS radius TL TR BR BL"></label>`:'';
    const text=type==='text'?`<div class="property-full"><label class="property-field">Text content
      <textarea id="text-value" data-text-buffer="${html(obj.buffer_ptr)}" rows="5" spellcheck="false"></textarea></label>
      <div class="buffer-note">Independent buffer · pointer <code>${html(obj.buffer_ptr)}</code> · ${html(String(data.textBuffers[String(obj.buffer_ptr)]??'').length)} characters</div></div>`:'';
    properties.innerHTML=`<div class="property-grid">${fields}${radius}
      <label class="property-field property-full">Palette color for layer ${obj.layer}<input type="color" data-property-color="${obj.layer}" value="${html(colorInput(paletteColor(data,obj.layer)))}"></label>
      ${text}
      <div class="property-actions property-full"><button id="duplicate-object" type="button">Duplicate</button><button id="delete-object" class="danger" type="button">Delete object</button></div></div>`;
    if(type==='text'){
      const raw=data.textBuffers[String(obj.buffer_ptr)];
      $('text-value').value=typeof raw==='string'?raw:Array.isArray(raw)?String.fromCharCode(...raw):'';
    }
  }

  function renderPaletteEvents(){
    const data=scene();
    $('palette-event-count').textContent=`(${data.paletteEvents.length})`;
    $('paletteEvents').innerHTML=data.paletteEvents.map((event,i)=>`<div class="palette-row">
      <label>Y<input data-event="${i}" data-event-key="y" type="number" min="0" max="719" value="${html(event.y)}"></label>
      <label>Layer<input data-event="${i}" data-event-key="layer" type="number" min="0" max="63" value="${html(event.layer)}"></label>
      <label>Color<input data-event="${i}" data-event-key="color" type="color" value="${html(colorInput(event.color))}"></label>
      <button type="button" data-remove-event="${i}" aria-label="Remove palette event">×</button>
    </div>`).join('');
  }

  function render(){
    renderStage();renderObjectList();renderProperties();renderPaletteEvents();resizeStage();
  }

  function select(type,id){
    const next=type&&getObject(scene(),type,id)?{type,id}:null;
    if(selection?.type===next?.type&&selection?.id===next?.id)return;
    selection=next;
    renderStage();renderObjectList();renderProperties();
  }

  function selectionElement(){
    return selection?[...stage.querySelectorAll('.scene-object')].find(el=>
      el.dataset.objectType===selection.type&&Number(el.dataset.objectId)===selection.id):null;
  }

  stage.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    const el=event.target.closest('.scene-object');
    if(!el || !stage.contains(el)){
      select(null,null);
      return;
    }
    event.preventDefault();
    const type=el.dataset.objectType,id=Number(el.dataset.objectId);
    select(type,id);
    const object=getObject(scene(),type,id);
    const mode=event.target.closest('[data-drag-handle]')?'resize':'move';
    drag={id,type,mode,pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY,
          x:object.x,y:object.y,w:object.w,h:object.h,changed:false};
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    const dx=Math.round((event.clientX-drag.clientX)/scale);
    const dy=Math.round((event.clientY-drag.clientY)/scale);
    if(!dx&&!dy&&!drag.changed)return;
    if(drag.mode==='resize')resizeObject(scene(),drag.type,drag.id,drag.w,drag.h,dx,dy);
    else moveObject(scene(),drag.type,drag.id,drag.x,drag.y,dx,dy);
    drag.changed=true;
    const el=selectionElement(),object=getObject(scene(),drag.type,drag.id);
    if(el&&object)updateDomObject(el,drag.type,object,scene());
  });
  function finishDrag(event){
    if(!drag||event.pointerId!==drag.pointerId)return;
    const changed=drag.changed;
    drag=null;
    if(stage.hasPointerCapture(event.pointerId))stage.releasePointerCapture(event.pointerId);
    if(changed){renderObjectList();renderProperties();notify();}
  }
  stage.addEventListener('pointerup',finishDrag);
  stage.addEventListener('pointercancel',finishDrag);
  stage.addEventListener('keydown',event=>{
    const el=event.target.closest('.scene-object');
    if((event.key==='Enter'||event.key===' ')&&el){
      event.preventDefault();select(el.dataset.objectType,Number(el.dataset.objectId));
    }
  });

  objectList.addEventListener('click',event=>{
    const el=event.target.closest('[data-select-type]');
    if(el)select(el.dataset.selectType,Number(el.dataset.selectId));
  });
  $('object-filter').addEventListener('input',renderObjectList);
  properties.addEventListener('change',event=>{
    const target=event.target;
    if(!selection)return;
    if(target.dataset.property){
      updateObject(scene(),selection.type,selection.id,target.dataset.property,target.value);
      renderStage();renderObjectList();renderProperties();notify();
    }else if(target.dataset.propertyColor!==undefined){
      const layer=Number(target.dataset.propertyColor);
      scene().palette[layer]=target.value;
      renderStage();renderObjectList();renderProperties();notify();
    }
  });
  properties.addEventListener('input',event=>{
    const target=event.target;
    if(target.dataset.textBuffer===undefined||!selection||selection.type!=='text')return;
    const obj=getObject(scene(),'text',selection.id);
    if(!obj||String(obj.buffer_ptr)!==target.dataset.textBuffer)return;
    scene().textBuffers[String(obj.buffer_ptr)]=target.value;
    const el=selectionElement();
    if(el)updateDomObject(el,'text',obj,scene());
    renderObjectList();notify();
  });
  properties.addEventListener('click',event=>{
    if(!selection)return;
    if(event.target.closest('#duplicate-object')){
      const copy=duplicateObject(scene(),selection.type,selection.id);
      if(copy){
        const type=selection.type;
        selection=null;
        select(type,copy.id);
        notify();
      }
    }else if(event.target.closest('#delete-object')){
      if(removeObject(scene(),selection.type,selection.id)){
        selection=null;render();notify();
      }
    }
  });
  $('add-rect').addEventListener('click',()=>{
    const rect=addRectangle(scene());
    selection=null;select('rect',rect.id);notify();
  });
  $('add-text').addEventListener('click',()=>{
    const text=addText(scene());
    selection=null;select('text',text.id);notify();
  });
  $('reset').addEventListener('click',()=>onReset?.());
  $('run-simulator').addEventListener('click',()=>onSimulate?.());
  $('addPalette').addEventListener('click',()=>{
    scene().paletteEvents.push({y:300,layer:3,color:'#d64e78'});
    renderPaletteEvents();notify();
  });
  $('paletteEvents').addEventListener('change',event=>{
    const target=event.target;
    if(target.dataset.event===undefined)return;
    const item=scene().paletteEvents[Number(target.dataset.event)];
    if(!item)return;
    const key=target.dataset.eventKey;
    item[key]=key==='color'?target.value:clamp(Math.round(Number(target.value)||0),0,key==='y'?HEIGHT-1:LAYERS-1);
    renderPaletteEvents();notify();
  });
  $('paletteEvents').addEventListener('click',event=>{
    const remove=event.target.closest('[data-remove-event]');
    if(!remove)return;
    scene().paletteEvents.splice(Number(remove.dataset.removeEvent),1);
    renderPaletteEvents();notify();
  });

  document.addEventListener('keydown',event=>{
    if($('editor-view').hidden || !selection)return;
    if(event.target.matches('input,textarea,select,[contenteditable="true"]'))return;
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;
    event.preventDefault();
    const object=getObject(scene(),selection.type,selection.id);
    if(!object)return;
    const amount=event.shiftKey?10:1;
    const dx=event.key==='ArrowRight'?amount:event.key==='ArrowLeft'?-amount:0;
    const dy=event.key==='ArrowDown'?amount:event.key==='ArrowUp'?-amount:0;
    moveObject(scene(),selection.type,selection.id,object.x,object.y,dx,dy);
    renderStage();renderObjectList();renderProperties();notify();
  });
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(resizeStage).observe(shell);
  window.addEventListener('resize',resizeStage);
  render();
  return {render,clearSelection(){selection=null;render();}, getSelection(){return selection;}};
}
