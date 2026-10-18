/* Visual scene editor. Selection, grouping, and clipboard operations work on
   the flat shape/text model; only the raster simulator generates pixels. */
import {WIDTH,HEIGHT,LAYERS} from './scene.js';
import {editableScene,sceneObjects,getObject,getLayerName,setLayerName,getLayer,getLayerNode,drawingLayers,layerTree,layerSubtree,layerIndex,addLayer,addLayerGroup,deleteLayer,reorderLayer,setLayerColor,addRectangle,addText,updateObject,
  moveObject,resizeObject,radiusCss,paletteColor,rectangleThumbnail,
  resolveSelection,selectionUnits,objectsFullyInsideRect,moveSelectionToLayer,alignSelection,distributeSelection,
  groupSelection,ungroupSelection,copySelection,pasteSelection,
  deleteSelection as removeSelectedObjects} from './scene-model.js';

const $=id=>document.getElementById(id);
const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const key=ref=>`${ref.type}:${ref.id}`;
const validColor=value=>/^#[0-9a-fA-F]{6}$/.test(value??'')?value:'#ffffff';
const numericField=(name,label,value,min,max)=>`<label class="property-field">${label}<input type="number" data-property="${name}" value="${html(value)}" min="${min}" max="${max}" step="1"></label>`;
const objectName=(type,obj,data)=>type==='rect'?`Rectangle ${obj.id}`:
  `Text ${obj.id} · ${String(data.textBuffers[String(obj.buffer_ptr)]??'').split('\n')[0].slice(0,22)}`;
const isEditingTarget=target=>Boolean(target.closest('input,textarea,select,[contenteditable], [role="textbox"]'));

export function createSceneEditor({getScene,history,onSimulate}){
  const stage=$('editor-stage'),list=$('object-list'),properties=$('object-properties');
  let selection=[],drag=null,clipboard=[],pasteCount=0;
  let mostRecentLayer=null;
  const collapsedLayers=new Set();
  let draggedObjects=null,draggedLayer=null;

  const scene=()=>editableScene(getScene());
  const selected=()=>new Set(selection.map(key));
  const edit=callback=>{const changed=history.transaction(callback);if(changed)render();return changed;};

  function paintObject(element,type,obj,data){
    element.style.left=`${obj.x}px`;
    element.style.top=`${obj.y}px`;
    element.style.width=`${Math.max(1,obj.w)}px`;
    element.style.height=`${Math.max(1,obj.h)}px`;
    element.style.zIndex=String(layerIndex(data,obj.layerId));
    element.style.backgroundColor=type==='rect'?paletteColor(data,obj.layerId):'transparent';
    element.style.color=type==='text'?paletteColor(data,obj.layerId):'';
    if(type==='rect')element.style.borderRadius=radiusCss(obj.radius);
    if(type==='text'){
      const raw=data.textBuffers[String(obj.buffer_ptr)];
      const content=element.querySelector('.text-content');
      if(content)content.textContent=typeof raw==='string'?raw:
        Array.isArray(raw)?String.fromCharCode(...raw):'';
    }
  }

  function renderStage(){
    const data=scene(),active=selected();
    stage.style.backgroundColor=validColor(data.layers[0].color);
    stage.replaceChildren();
    const allowResize=selection.length===1;
    for(const {type,object} of sceneObjects(data)){
      const ref={type,id:object.id},chosen=active.has(key(ref));
      const el=document.createElement('div');
      el.className=`scene-object ${type==='rect'?'scene-rectangle':'scene-text'}${chosen?' is-selected':''}`;
      el.dataset.objectType=type;
      el.dataset.objectId=String(object.id);
      el.setAttribute('role','button');
      el.setAttribute('tabindex','0');
      el.setAttribute('aria-label',objectName(type,object,data));
      el.setAttribute('aria-pressed',String(chosen));
      if(type==='text'){
        const span=document.createElement('span');
        span.className='text-content red2';
        el.append(span);
      }
      paintObject(el,type,object,data);
      if(chosen&&allowResize){
        const handle=document.createElement('span');
        handle.className='object-resize-handle';
        handle.dataset.dragHandle='resize';
        handle.setAttribute('aria-hidden','true');
        el.append(handle);
      }
      stage.append(el);
    }
  }

  function renderList(){
    const data=scene(),active=selected();
    const filter=$('object-filter').value.trim().toLowerCase();
    const objects=sceneObjects(data).sort((a,b)=>
      layerIndex(data,b.object.layerId)-layerIndex(data,a.object.layerId)||b.object.id-a.object.id);
    const leaves=drawingLayers(data);
    $('object-count').textContent=`${objects.length} objects · ${leaves.length}/64 layers`;
    $('editor-stats').textContent=`${data.shapes.length} rectangles · ${data.texts.length} text`;
    $('add-layer').disabled=leaves.length>=LAYERS||data.layers.length>=256;
    $('add-group').disabled=data.layers.length>=256;
    const buckets=new Map();
    for(const item of objects){
      const id=item.object.layerId;
      if(!buckets.has(id))buckets.set(id,[]);
      buckets.get(id).push(item);
    }
    const renderNodes=(nodes,depth=1,showAll=false)=>[...nodes].reverse().map(({node,children})=>{
      const id=html(node.id),background=node.id==='background',folder=node.kind==='group';
      const contents=buckets.get(node.id)||[];
      const localMatch=filter&&(
        node.name.toLowerCase().includes(filter)||
        (folder?'group':'layer').includes(filter)||
        contents.some(({type,object})=>objectName(type,object,data).toLowerCase().includes(filter)));
      const includeChildren=showAll||Boolean(localMatch);
      const childMarkup=folder?renderNodes(children,depth+1,includeChildren):'';
      if(filter&&!showAll&&!localMatch&&!childMarkup)return '';
      const color=html(validColor(node.color)),name=html(node.name);
      const collapsed=collapsedLayers.has(node.id)&&!filter;
      const thumbnails=contents.filter(({type,object})=>
        !filter||includeChildren||objectName(type,object,data).toLowerCase().includes(filter))
        .map(({type,object})=>{
          const ref={type,id:object.id},chosen=active.has(key(ref));
          const description=`${objectName(type,object,data)}, ${node.name||'Unnamed layer'}`;
          const preview=type==='rect'?(()=>{
            const thumb=rectangleThumbnail(object,72,54);
            return `<span class="object-thumbnail-shape" style="width:${thumb.width}px;height:${thumb.height}px;border-radius:${thumb.borderRadius};background:${color}"></span>`;
          })():`<span class="object-thumbnail-text red2" style="color:${color}">${html(String(data.textBuffers[String(object.buffer_ptr)]??'').split('\n')[0].slice(0,10)||'TEXT')}</span>`;
          return `<button type="button" draggable="true" class="object-tile${chosen?' is-selected':''}" data-select-type="${type}" data-select-id="${object.id}" aria-label="${html(description)}" title="${html(description)}" aria-pressed="${chosen}">
            <span class="object-tile-preview">${preview}</span>
            ${object.group_id!=null?`<span class="object-tile-group" title="Group ${object.group_id}">G${object.group_id}</span>`:''}
          </button>`;
        }).join('');
      const title=node.name||(background?'Background':folder?'New group':'Unnamed layer');
      return `<section class="layer-section${folder?' layer-folder':''}" role="treeitem" aria-level="${depth}"${folder?` aria-expanded="${!collapsed}"`:''}
        data-layer-id="${id}" data-layer-reorder="${id}"${folder?` data-layer-group="${id}"`:background?'':` data-layer-drop="${id}"`}>
        <div class="layer-header">
          ${background?'<span class="layer-grip layer-grip-fixed" title="Background stays at the bottom">▦</span>':
            `<button class="layer-grip" type="button" draggable="true" data-layer-drag="${id}" title="Drag ${html(title)} to reorder" aria-label="Drag to reorder ${html(title)}">⠿</button>`}
          <button type="button" class="layer-toggle" data-layer-toggle="${id}" aria-expanded="${!collapsed}" aria-controls="layer-content-${id}" title="${collapsed?'Expand':'Collapse'} ${html(title)}" aria-label="${collapsed?'Expand':'Collapse'} ${html(title)}">
            <span class="layer-chevron" aria-hidden="true">${collapsed?'▸':'▾'}</span>
            ${folder?'<span class="layer-folder-icon" aria-hidden="true">▣</span>':''}
          </button>
          <input class="layer-name" type="text" data-layer-name="${id}" maxlength="64" value="${name}" placeholder="${background?'Name background…':folder?'Group name…':'Name layer…'}" title="${html(title)}" aria-label="Name ${background?'background':folder?'group':'layer'}" autocomplete="off" spellcheck="false">
          ${folder?`<button type="button" class="layer-child-add" data-add-child-layer="${id}" title="Add layer inside ${html(title)}" aria-label="Add layer inside ${html(title)}">+L</button>
            <button type="button" class="layer-child-add" data-add-child-group="${id}" title="Add group inside ${html(title)}" aria-label="Add group inside ${html(title)}">+G</button>`:
            `<input class="layer-color" type="color" data-layer-color="${id}" value="${color}" title="Color for ${html(title)}" aria-label="Layer color">`}
          ${background?'':`<button type="button" class="layer-delete" data-layer-delete="${id}" title="Delete ${html(title)}" aria-label="Delete ${html(title)}">×</button>`}
        </div>
        ${folder?`<div id="layer-content-${id}" class="layer-children" role="group"${collapsed?' hidden':''}>${childMarkup||'<p class="layer-empty">Drop layers or groups here</p>'}</div>`:
          `<div id="layer-content-${id}" class="layer-object-grid"${collapsed?' hidden':''}>
            ${background?'<p class="layer-empty">Canvas background color</p>':thumbnails||'<p class="layer-empty">Drop objects here</p>'}
          </div>`}
      </section>`;
    }).join('');
    const scrollTop=list.scrollTop;
    list.innerHTML=renderNodes(layerTree(data))||'<p class="empty">No matching layers or objects.</p>';
    list.scrollTop=scrollTop;
  }

  function renderProperties(){
    const data=scene();
    const summary=$('selection-summary');
    if(!selection.length){
      summary.textContent='';
      properties.innerHTML='<p class="empty">Select objects on the canvas or in the Objects list. Shift-click to select several.</p>';
      return;
    }
    if(selection.length!==1){
      const units=selectionUnits(data,selection);
      summary.textContent=`${selection.length} objects`;
      properties.innerHTML=`<p class="multi-selection-description">${selection.length} selected objects · ${units.length} movable ${units.length===1?'unit':'units'}. Use the Align, Distribute, and Group controls in the toolbar. Drag any selected object to move the selection.</p>`;
      return;
    }
    const {type,id}=selection[0],obj=getObject(data,type,id);
    if(!obj)return;
    summary.textContent=type==='rect'?'RECTANGLE':'TEXT';
    const fields=[numericField('x','X',obj.x,-WIDTH,WIDTH),numericField('y','Y',obj.y,-HEIGHT,HEIGHT),
      numericField('w','Width',obj.w,1,WIDTH),numericField('h','Height',obj.h,1,HEIGHT)].join('');
    const radius=type==='rect'?`<label class="property-field property-full">Corner radius <input data-property="radius" type="text" value="${html(Array.isArray(obj.radius)?obj.radius.join(' '):obj.radius??0)}" aria-label="CSS radius TL TR BR BL"></label>`:'';
    const text=type==='text'?`<div class="property-full"><label class="property-field">Text content
      <textarea id="text-value" data-text-buffer="${html(obj.buffer_ptr)}" rows="5" spellcheck="false"></textarea></label>
      <div class="buffer-note">Independent buffer · pointer <code>${html(obj.buffer_ptr)}</code></div></div>`:'';
    properties.innerHTML=`<div class="property-grid">${fields}${radius}
      ${text}</div>`;
    if(type==='text'){
      const raw=data.textBuffers[String(obj.buffer_ptr)];
      $('text-value').value=typeof raw==='string'?raw:Array.isArray(raw)?String.fromCharCode(...raw):'';
    }
  }

  function renderPaletteEvents(){
    const data=scene();
    $('palette-event-count').textContent=`${data.paletteEvents.length}`;
    $('paletteEvents').innerHTML=data.paletteEvents.map((event,i)=>`<div class="palette-row">
      <label>Y<input data-event="${i}" data-event-key="y" type="number" min="0" max="719" value="${html(event.y)}"></label>
      <label>Layer<select data-event="${i}" data-event-key="layerId">${drawingLayers(data).map((layer,index)=>
        `<option value="${html(layer.id)}"${event.layerId===layer.id?' selected':''}>${html(layer.name|| (index===0?'Background':'Unnamed layer'))}</option>`).join('')}</select></label>
      <label>Color<input data-event="${i}" data-event-key="color" type="color" value="${html(validColor(event.color))}"></label>
      <button type="button" data-remove-event="${i}" aria-label="Remove palette event">×</button>
    </div>`).join('');
  }

  function updateControls(){
    const count=selection.length,units=selectionUnits(scene(),selection);
    const grouped=selection.some(ref=>getObject(scene(),ref.type,ref.id)?.group_id!=null);
    $('undo-edit').disabled=!history.state().canUndo;
    $('redo-edit').disabled=!history.state().canRedo;
    $('copy-objects').disabled=count===0;
    $('cut-objects').disabled=count===0;
    $('paste-objects').disabled=clipboard.length===0;
    $('duplicate-objects').disabled=count===0;
    $('delete-objects').disabled=count===0;
    $('group-objects').disabled=units.length<2;
    $('ungroup-objects').disabled=!grouped;
    $('align-objects').disabled=units.length<2;
    $('distribute-objects').disabled=units.length<3;
  }
  function render(){
    selection=resolveSelection(scene(),selection);
    if(mostRecentLayer&&!getLayer(scene(),mostRecentLayer))mostRecentLayer=null;
    renderStage();renderList();renderProperties();renderPaletteEvents();updateControls();
  }
  function setSelection(refs){
    selection=resolveSelection(scene(),refs);
    if(refs.length){
      const ref=refs.at(-1);
      const obj=getObject(scene(),ref.type,ref.id);
      if(obj&&obj.layerId!=='background')mostRecentLayer=obj.layerId;
    }
    renderStage();renderList();renderProperties();updateControls();
  }
  function select(ref,additive=false){
    if(!ref){if(!additive)setSelection([]);return;}
    const members=resolveSelection(scene(),[ref]);
    const old=selected();
    if(additive){
      const already=members.every(member=>old.has(key(member)));
      const changed=already?selection.filter(member=>!members.some(item=>key(item)===key(member))):[...selection,...members];
      setSelection(changed);
    }else setSelection(members);
    // A group click expands to its members, but the specifically clicked
    // object (rather than the last expanded member) controls new insertions.
    const obj=getObject(scene(),ref.type,ref.id);
    if(obj&&obj.layerId!=='background')mostRecentLayer=obj.layerId;
  }
  const elementFor=ref=>[...stage.querySelectorAll('.scene-object')].find(el=>
    el.dataset.objectType===ref.type&&Number(el.dataset.objectId)===ref.id);

  // Dragging is one undoable action, even if the pointer sends hundreds of moves.
  stage.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    const el=event.target.closest('.scene-object');
    const modifier=event.shiftKey||event.ctrlKey||event.metaKey;
    const hit=el&&stage.contains(el)&&!event.altKey;
    if(hit){
      event.preventDefault();
      const ref={type:el.dataset.objectType,id:Number(el.dataset.objectId)};
      if(modifier){select(ref,true);return;}
      if(!selected().has(key(ref)))select(ref);
      const mode=event.target.closest('[data-drag-handle]')?'resize':'move';
      const start=selection.map(item=>{
        const obj=getObject(scene(),item.type,item.id);
        return {...item,x:obj.x,y:obj.y,w:obj.w,h:obj.h};
      });
      history.begin();
      drag={mode,pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY,start,
        resizeRef:ref,changed:false};
    }else{
      const base=modifier?[...selection]:[];
      if(!modifier)setSelection([]);
      const rect=document.createElement('div');
      rect.className='selection-marquee';
      stage.append(rect);
      drag={mode:'marquee',pointerId:event.pointerId,clientX:event.clientX,
        clientY:event.clientY,base,rect,changed:false};
    }
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    const dx=Math.round(event.clientX-drag.clientX),dy=Math.round(event.clientY-drag.clientY);
    if(drag.mode==='marquee'){
      const bounds=stage.getBoundingClientRect();
      const x1=clamp(drag.clientX-bounds.left,0,WIDTH),y1=clamp(drag.clientY-bounds.top,0,HEIGHT);
      const x2=clamp(event.clientX-bounds.left,0,WIDTH),y2=clamp(event.clientY-bounds.top,0,HEIGHT);
      Object.assign(drag.rect.style,{left:`${Math.min(x1,x2)}px`,top:`${Math.min(y1,y2)}px`,
        width:`${Math.abs(x2-x1)}px`,height:`${Math.abs(y2-y1)}px`});
      drag.changed=drag.changed||Math.abs(dx)>3||Math.abs(dy)>3;
      return;
    }
    if(!dx&&!dy&&!drag.changed)return;
    drag.changed=true;
    if(drag.mode==='resize'){
      const ref=drag.start.find(item=>key(item)===key(drag.resizeRef));
      if(ref)resizeObject(scene(),ref.type,ref.id,ref.w,ref.h,dx,dy);
    }else for(const ref of drag.start){
      moveObject(scene(),ref.type,ref.id,ref.x,ref.y,dx,dy);
    }
    for(const ref of drag.start){
      const obj=getObject(scene(),ref.type,ref.id),el=elementFor(ref);
      if(obj&&el)paintObject(el,ref.type,obj,scene());
    }
  });
  function finishDrag(event){
    if(!drag||event.pointerId!==drag.pointerId)return;
    const finished=drag;drag=null;
    if(stage.hasPointerCapture(event.pointerId))stage.releasePointerCapture(event.pointerId);
    if(finished.mode==='marquee'){
      finished.rect.remove();
      if(finished.changed){
        const bounds=stage.getBoundingClientRect();
        const x1=clamp(finished.clientX-bounds.left,0,WIDTH),y1=clamp(finished.clientY-bounds.top,0,HEIGHT);
        const x2=clamp(event.clientX-bounds.left,0,WIDTH),y2=clamp(event.clientY-bounds.top,0,HEIGHT);
        const left=Math.min(x1,x2),right=Math.max(x1,x2),top=Math.min(y1,y2),bottom=Math.max(y1,y2);
        const hits=objectsFullyInsideRect(scene(),{left,top,right,bottom});
        setSelection([...finished.base,...hits]);
      }
    }else{
      history.commit();
      render();
    }
  }
  stage.addEventListener('pointerup',finishDrag);
  stage.addEventListener('pointercancel',finishDrag);
  stage.addEventListener('keydown',event=>{
    const el=event.target.closest('.scene-object');
    if(el&&(event.key==='Enter'||event.key===' ')){
      event.preventDefault();
      select({type:el.dataset.objectType,id:Number(el.dataset.objectId)},event.shiftKey);
    }
  });
  list.addEventListener('click',event=>{
    const el=event.target.closest('[data-select-type]');
    if(el)select({type:el.dataset.selectType,id:Number(el.dataset.selectId)},
      event.shiftKey||event.ctrlKey||event.metaKey);
  });
  $('object-filter').addEventListener('input',renderList);
  $('add-layer').addEventListener('click',()=>edit(()=>addLayer(scene(),{color:'#92d0e1'})));
  $('add-group').addEventListener('click',()=>edit(()=>addLayerGroup(scene())));
  list.addEventListener('click',event=>{
    const addChildLayer=event.target.closest('[data-add-child-layer]');
    if(addChildLayer){edit(()=>addLayer(scene(),{parentId:addChildLayer.dataset.addChildLayer,color:'#92d0e1'}));return;}
    const addChildGroup=event.target.closest('[data-add-child-group]');
    if(addChildGroup)edit(()=>addLayerGroup(scene(),{parentId:addChildGroup.dataset.addChildGroup}));
  });
  list.addEventListener('click',event=>{
    const button=event.target.closest('[data-layer-delete]');
    if(!button)return;
    const id=button.dataset.layerDelete,data=scene(),layer=getLayerNode(data,id);
    if(!layer||id==='background')return;
    const leafIds=new Set(layerSubtree(data,id).filter(node=>node.kind!=='group').map(node=>node.id));
    const objects=sceneObjects(data).filter(({object})=>leafIds.has(object.layerId)).length;
    const events=data.paletteEvents.filter(item=>leafIds.has(item.layerId)).length;
    if((objects||events)&&!window.confirm(
      `Delete ${layer.name|| (layer.kind==='group'?'this group':'this layer')} and its ${objects} ${objects===1?'object':'objects'}${events?` and ${events} palette ${events===1?'event':'events'}`:''}? ${layer.kind==='group'?'All nested layers and groups will also be deleted. ':''}You can undo this action.`))return;
    const removedIds=new Set(layerSubtree(data,id).map(node=>node.id));
    if(edit(()=>deleteLayer(scene(),id))){
      for(const deletedId of removedIds)collapsedLayers.delete(deletedId);
      if(removedIds.has(mostRecentLayer))mostRecentLayer=null;
    }
  });
  list.addEventListener('click',event=>{
    const toggle=event.target.closest('[data-layer-toggle]');
    if(!toggle)return;
    const id=toggle.dataset.layerToggle;
    if(collapsedLayers.has(id))collapsedLayers.delete(id);
    else collapsedLayers.add(id);
    renderList();
  });
  list.addEventListener('change',event=>{
    const color=event.target.closest('[data-layer-color]');
    if(color){edit(()=>setLayerColor(scene(),color.dataset.layerColor,color.value));return;}
    const name=event.target.closest('[data-layer-name]');
    if(name)edit(()=>setLayerName(scene(),name.dataset.layerName,name.value));
  });
  list.addEventListener('keydown',event=>{
    const input=event.target.closest('[data-layer-name]');
    if(!input)return;
    if(event.key==='Enter'){event.preventDefault();input.blur();}
    if(event.key==='Escape'){
      event.preventDefault();
      input.value=getLayerName(scene(),input.dataset.layerName);
      input.blur();
    }
  });

  // Grip drag reorders a complete layer; tile drag transfers objects.
  const clearDropHighlights=()=>{
    list.querySelectorAll('.layer-drop-target,.is-dragging').forEach(el=>
      el.classList.remove('layer-drop-target','is-dragging'));
    list.querySelectorAll('[data-layer-insert]').forEach(el=>el.removeAttribute('data-layer-insert'));
  };
  const dropSide=(event,section)=>{
    const rect=section.querySelector('.layer-header').getBoundingClientRect();
    if(section.hasAttribute('data-layer-group')){
      if(event.target.closest('.layer-children')===section.querySelector('.layer-children'))return 'inside';
      if(event.clientY>=rect.top+rect.height*.25&&event.clientY<=rect.bottom-rect.height*.25)return 'inside';
    }
    return event.clientY<rect.top+rect.height/2?'above':'below';
  };
  list.addEventListener('dragstart',event=>{
    const grip=event.target.closest('[data-layer-drag]');
    if(grip&&event.dataTransfer){
      draggedObjects=null;draggedLayer=grip.dataset.layerDrag;
      event.dataTransfer.effectAllowed='move';
      event.dataTransfer.setData('application/x-raster-layer',draggedLayer);
      event.dataTransfer.setData('text/plain',`Reorder scene layer ${draggedLayer}`);
      grip.closest('.layer-section').classList.add('is-dragging');
      return;
    }
    const tile=event.target.closest('[data-select-type]');
    if(!tile||!event.dataTransfer)return;
    draggedLayer=null;
    const ref={type:tile.dataset.selectType,id:Number(tile.dataset.selectId)};
    const refs=selected().has(key(ref))?selection:resolveSelection(scene(),[ref]);
    draggedObjects=refs.map(item=>({...item}));
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('application/x-raster-objects',JSON.stringify(draggedObjects));
    event.dataTransfer.setData('text/plain','Move scene objects between layers');
    tile.classList.add('is-dragging');
  });
  list.addEventListener('dragover',event=>{
    if(draggedLayer){
      const target=event.target.closest('[data-layer-reorder]');
      if(!target)return;
      const side=dropSide(event,target);
      if(target.dataset.layerReorder==='background'&&side==='below')return;
      event.preventDefault();
      if(event.dataTransfer)event.dataTransfer.dropEffect='move';
      clearDropHighlights();target.setAttribute('data-layer-insert',side);
      return;
    }
    const target=event.target.closest('[data-layer-drop]');
    if(!target||!draggedObjects)return;
    event.preventDefault();
    if(event.dataTransfer)event.dataTransfer.dropEffect='move';
    clearDropHighlights();target.classList.add('layer-drop-target');
  });
  list.addEventListener('dragleave',event=>{
    const section=event.target.closest('[data-layer-reorder]');
    if(section&&!section.contains(event.relatedTarget)){
      section.classList.remove('layer-drop-target');
      section.removeAttribute('data-layer-insert');
    }
  });
  list.addEventListener('drop',event=>{
    const section=event.target.closest('[data-layer-reorder]');
    if(!section)return;
    if(draggedLayer){
      const source=draggedLayer,target=section.dataset.layerReorder,side=dropSide(event,section);
      event.preventDefault();draggedLayer=null;clearDropHighlights();
      edit(()=>reorderLayer(scene(),source,target,side));
      return;
    }
    if(!draggedObjects||!section.dataset.layerDrop)return;
    event.preventDefault();
    const refs=draggedObjects;draggedObjects=null;clearDropHighlights();
    edit(()=>moveSelectionToLayer(scene(),refs,section.dataset.layerDrop));
    setSelection(refs);
  });
  list.addEventListener('dragend',()=>{
    draggedObjects=null;draggedLayer=null;clearDropHighlights();
  });

  properties.addEventListener('change',event=>{
    const target=event.target;
    if(selection.length!==1||target.dataset.textBuffer!==undefined)return;
    const {type,id}=selection[0];
    if(target.dataset.property){
      edit(()=>updateObject(scene(),type,id,target.dataset.property,target.value));
    }
  });
  properties.addEventListener('focusin',event=>{
    if(event.target.dataset.textBuffer!==undefined)history.begin();
  });
  properties.addEventListener('input',event=>{
    const target=event.target;
    if(target.dataset.textBuffer===undefined||selection.length!==1||selection[0].type!=='text')return;
    const obj=getObject(scene(),'text',selection[0].id);
    if(!obj||String(obj.buffer_ptr)!==target.dataset.textBuffer)return;
    history.begin();
    if(scene().textBuffers[String(obj.buffer_ptr)]===target.value)return;
    scene().textBuffers[String(obj.buffer_ptr)]=target.value;
    const el=elementFor(selection[0]);
    if(el)paintObject(el,'text',obj,scene());
    renderList();
    // Text inputs stay focused while history records one transaction on blur.
    historyTextDirty=true;
    onTextInput?.();
  });
  let historyTextDirty=false;
  let onTextInput=null;
  properties.addEventListener('focusout',event=>{
    if(event.target.dataset.textBuffer===undefined)return;
    history.commit({notify:!historyTextDirty});
    historyTextDirty=false;
    updateControls();
  });
  function deleteSelected(){
    if(!selection.length)return;
    edit(()=>removeSelectedObjects(scene(),selection));
    setSelection([]);
  }
  function copySelected(){
    if(!selection.length)return false;
    clipboard=copySelection(scene(),selection);
    pasteCount=0;
    updateControls();
    return true;
  }
  function pasteCopied(offset){
    if(!clipboard.length)return;
    let copies=[];
    edit(()=>{copies=pasteSelection(scene(),clipboard,offset??20*(++pasteCount));});
    setSelection(copies);
  }
  function duplicateSelected(){if(copySelected())pasteCopied(18);}
  $('add-rect').addEventListener('click',()=>{
    let obj;edit(()=>{obj=addRectangle(scene(),mostRecentLayer);});setSelection([{type:'rect',id:obj.id}]);
  });
  $('add-text').addEventListener('click',()=>{
    let obj;edit(()=>{obj=addText(scene(),mostRecentLayer);});setSelection([{type:'text',id:obj.id}]);
  });
  $('run-simulator').addEventListener('click',()=>onSimulate?.());
  $('undo-edit').addEventListener('click',()=>{if(history.undo())render();});
  $('redo-edit').addEventListener('click',()=>{if(history.redo())render();});
  $('copy-objects').addEventListener('click',copySelected);
  $('cut-objects').addEventListener('click',()=>{if(copySelected())deleteSelected();});
  $('paste-objects').addEventListener('click',()=>pasteCopied());
  $('duplicate-objects').addEventListener('click',duplicateSelected);
  $('delete-objects').addEventListener('click',deleteSelected);
  $('group-objects').addEventListener('click',()=>edit(()=>groupSelection(scene(),selection)));
  $('ungroup-objects').addEventListener('click',()=>edit(()=>ungroupSelection(scene(),selection)));
  $('align-objects').addEventListener('change',event=>{
    const value=event.target.value;event.target.value='';
    if(value)edit(()=>alignSelection(scene(),selection,value));
  });
  $('distribute-objects').addEventListener('change',event=>{
    const value=event.target.value;event.target.value='';
    if(value)edit(()=>distributeSelection(scene(),selection,value));
  });

  $('addPalette').addEventListener('click',()=>edit(()=>{
    scene().paletteEvents.push({y:300,layerId:getLayer(scene(),mostRecentLayer)?.id??drawingLayers(scene()).at(-1).id,color:'#d64e78'});
  }));
  $('paletteEvents').addEventListener('change',event=>{
    const target=event.target;
    if(target.dataset.event===undefined)return;
    edit(()=>{
      const item=scene().paletteEvents[Number(target.dataset.event)];
      if(!item)return;
      const name=target.dataset.eventKey;
      item[name]=name==='color'||name==='layerId'?target.value:clamp(Math.round(Number(target.value)||0),0,HEIGHT-1);
    });
  });
  $('paletteEvents').addEventListener('click',event=>{
    const button=event.target.closest('[data-remove-event]');
    if(button)edit(()=>scene().paletteEvents.splice(Number(button.dataset.removeEvent),1));
  });

  document.addEventListener('keydown',event=>{
    if($('editor-view').hidden||event.altKey||isEditingTarget(event.target))return;
    const cmd=event.ctrlKey||event.metaKey;
    const letter=event.key.toLowerCase();
    if(cmd){
      if(letter==='z'){event.preventDefault();if((event.shiftKey?history.redo():history.undo()))render();return;}
      if(letter==='y'){event.preventDefault();if(history.redo())render();return;}
      if(letter==='a'){event.preventDefault();setSelection(sceneObjects(scene()).map(({type,object})=>({type,id:object.id})));return;}
      if(letter==='c'&&copySelected()){event.preventDefault();return;}
      if(letter==='x'&&copySelected()){event.preventDefault();deleteSelected();return;}
      if(letter==='v'&&clipboard.length){event.preventDefault();pasteCopied();return;}
      if(letter==='d'&&selection.length){event.preventDefault();duplicateSelected();return;}
      if(letter==='g'&&event.shiftKey){event.preventDefault();edit(()=>ungroupSelection(scene(),selection));return;}
      if(letter==='g'&&selection.length){event.preventDefault();edit(()=>groupSelection(scene(),selection));return;}
      return;
    }
    if(!selection.length)return;
    if(event.key==='Delete'||event.key==='Backspace'){
      event.preventDefault();deleteSelected();return;
    }
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;
    event.preventDefault();
    const amount=event.shiftKey?10:1;
    const dx=event.key==='ArrowRight'?amount:event.key==='ArrowLeft'?-amount:0;
    const dy=event.key==='ArrowDown'?amount:event.key==='ArrowUp'?-amount:0;
    edit(()=>{
      for(const ref of selection){
        const obj=getObject(scene(),ref.type,ref.id);
        if(obj)moveObject(scene(),ref.type,ref.id,obj.x,obj.y,dx,dy);
      }
    });
  });
  render();
  return {
    render,
    updateHistoryControls:updateControls,
    clearSelection(){selection=[];mostRecentLayer=null;render();},
    getSelection(){return selection.map(ref=>({...ref}));},
    setSelection(refs){setSelection(refs);},
    setOnTextInput(callback){onTextInput=callback;}
  };
}
