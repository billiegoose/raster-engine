/* Visual scene editor. Composition folders organize objects independently of
   paint layers; only the raster simulator generates pixels. */
import {LAYERS,canvasSize} from './scene.js';
import {prepareObjectEditorScene,sceneObjects,getObject,getLayerName,setLayerName,getLayer,drawingLayers,layerIndex,addLayer,reorderLayer,setLayerColor,addRectangle,addText,updateObject,
  moveObject,resizeObject,radiusCss,paletteColor,rectangleThumbnail,
  resolveSelection,selectionUnits,objectsFullyInsideRect,moveSelectionToLayer,alignSelection,distributeSelection,
  objectFolders,getObjectFolder,folderMembers,addObjectFolder,renameObjectFolder,
  moveObjectsToFolder,moveObjectFolder,moveObjectFolderContents,deleteObjectFolder,
  removePaintLayer,copySelection,pasteSelection,
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
  const exactSelection={expandGroups:false};
  let selectedFolderId=null;
  const collapsedFolders=new Set();
  let draggedObjects=null,draggedFolder=null,draggedPaintLayer=null;

  // Scene normalization happens when a scene is created, loaded or restored,
  // never during rendering: reads must not mutate history or save-state.
  const scene=()=>getScene();
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
    const {width,height}=canvasSize(data);
    const shell=$('editor-canvas-shell');
    const layout=stage.closest('.editor-layout');
    layout.dataset.canvasWidth=String(width);
    layout.style.setProperty('--canvas-height',`${height}px`);
    shell.style.width=`${width}px`;
    shell.style.height=`${height}px`;
    stage.style.width=`${width}px`;
    stage.style.height=`${height}px`;
    stage.setAttribute('aria-label',`Editable ${width} by ${height} scene`);
    stage.style.backgroundColor=validColor(data.layers[0].color);
    stage.replaceChildren();
    const allowResize=selection.length===1&&!selectedFolderId;
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
    const data=scene(),active=selected(),folders=objectFolders(data);
    const filter=$('object-filter').value.trim().toLowerCase();
    const objects=sceneObjects(data).sort((a,b)=>
      layerIndex(data,b.object.layerId)-layerIndex(data,a.object.layerId)||b.object.id-a.object.id);
    $('object-count').textContent=`${objects.length} objects · ${folders.length} groups`;
    $('editor-stats').textContent=`${data.shapes.length} rectangles · ${data.texts.length} text`;
    $('add-folder').disabled=folders.length>=256;
    const byParent=new Map(),children=new Map();
    for(const item of objects){
      const parent=item.object.parentId??null;
      if(!byParent.has(parent))byParent.set(parent,[]);
      byParent.get(parent).push(item);
    }
    for(const folder of folders){
      const parent=folder.parentId??null;
      if(!children.has(parent))children.set(parent,[]);
      children.get(parent).push(folder);
    }
    const objectMarkup=({type,object},force=false)=>{
      const ref={type,id:object.id},chosen=active.has(key(ref));
      const name=objectName(type,object,data),layer=getLayer(data,object.layerId);
      if(filter&&!force&&!name.toLowerCase().includes(filter)&&
         !(layer?.name??'').toLowerCase().includes(filter))return '';
      const color=validColor(layer?.color),paint=layer?.name||`Layer ${layerIndex(data,object.layerId)}`;
      const thumb=type==='rect'?(()=>{
        const t=rectangleThumbnail(object,40,26);
        return `<span class="object-thumbnail-shape" style="width:${t.width}px;height:${t.height}px;border-radius:${t.borderRadius};background:${color}"></span>`;
      })():`<span class="object-thumbnail-text red2" style="color:${color}">${html(String(data.textBuffers[String(object.buffer_ptr)]??'').split('\n')[0].slice(0,32)||'TEXT')}</span>`;
      return `<button type="button" draggable="true" role="treeitem" class="object-row${chosen?' is-selected':''}" data-select-type="${type}" data-select-id="${object.id}" aria-pressed="${chosen}" title="${html(name)} · ${html(paint)}">
        <span class="object-tile-preview">${thumb}</span><span class="object-paint-swatch" style="background:${color}"></span><span class="object-paint-name">${html(paint)}</span></button>`;
    };
    const renderChildren=(parent=null,depth=1,force=false)=>{
      const direct=(byParent.get(parent)||[]).map(item=>objectMarkup(item,force)).filter(Boolean).join('');
      const nested=(children.get(parent)||[]).map(folder=>{
        const match=filter&&folder.name.toLowerCase().includes(filter);
        const inner=renderChildren(folder.id,depth+1,force||match);
        if(filter&&!force&&!match&&!inner)return '';
        const collapsed=collapsedFolders.has(folder.id)&&!filter;
        const members=folderMembers(data,folder.id).length;
        const chosen=selectedFolderId===folder.id;
        return `<div class="object-folder" role="treeitem" aria-level="${depth}" aria-expanded="${!collapsed}" data-folder-drop="${html(folder.id)}">
          <div class="object-folder-header${chosen?' is-selected':''}" draggable="true" data-folder-drag="${html(folder.id)}">
            <button type="button" data-folder-toggle="${html(folder.id)}" aria-label="${collapsed?'Expand':'Collapse'} group">${collapsed?'▸':'▾'}</button>
            <button type="button" class="folder-title" data-folder-select="${html(folder.id)}" title="Select group (${members} objects). Double-click to rename">${html(folder.name||'New group')}</button>
            <input class="folder-rename" data-folder-name="${html(folder.id)}" maxlength="64" aria-label="Rename group" value="${html(folder.name)}" hidden>
          </div><div class="object-folder-contents"${collapsed?' hidden':''}>${inner||'<p class="layer-empty">Drop objects here</p>'}</div>
        </div>`;
      }).join('');
      return direct+nested;
    };
    const scrollTop=list.scrollTop;
    list.innerHTML=renderChildren()+'<div class="object-root-drop" data-objects-root-drop="true">Drop here to move objects or groups to root</div>';
    if(!objects.length&&!folders.length)list.innerHTML='<p class="empty">No objects yet. Add a rectangle, text, or group.</p>';
    list.scrollTop=scrollTop;
  }

  function renderPaletteLayers(){
    const layers=drawingLayers(scene());
    $('palette-layer-count').textContent=`${layers.length}/64`;
    $('add-layer').disabled=layers.length>=LAYERS;
    $('palette-layer-list').innerHTML=[...layers].reverse().map((layer,i)=>{
      const physical=layers.length-1-i,background=layer.id==='background';
      const title=layer.name||(background?'Background':`Layer ${physical}`);
      const used=sceneObjects(scene()).filter(({object})=>object.layerId===layer.id).length;
      return `<div class="palette-layer-row" data-paint-layer="${html(layer.id)}">
        ${background?'<span class="layer-grip layer-grip-fixed">▦</span>':`<button class="layer-grip" type="button" draggable="true" data-layer-drag="${html(layer.id)}" title="Drag to reorder paint layers">⠿</button>`}
        <span class="palette-number">${physical}</span>
        <input class="layer-name" data-layer-name="${html(layer.id)}" type="text" maxlength="64" aria-label="Paint layer ${physical} name" placeholder="${html(title)}" value="${html(layer.name)}">
        <input class="layer-color" data-layer-color="${html(layer.id)}" type="color" value="${validColor(layer.color)}" aria-label="${html(title)} color">
        <span class="muted" title="Assigned objects">${used}</span>
        ${background?'':`<button class="layer-delete" data-layer-delete="${html(layer.id)}" title="Remove layer and reassign its objects">×</button>`}
      </div>`;
    }).join('');
  }

  function renderProperties(){
    const data=scene();
    const summary=$('selection-summary');
    if(!selection.length&&!selectedFolderId){
      summary.textContent='';
      properties.innerHTML='<p class="empty">Select objects or a group on the canvas or in the Objects list.</p>';
      return;
    }
    if(selectedFolderId&&getObjectFolder(data,selectedFolderId)){
      const folder=getObjectFolder(data,selectedFolderId);
      summary.textContent='GROUP';
      properties.innerHTML=`<div class="property-grid">
        <label class="property-field property-full">Group name<input data-selected-folder-name="${html(folder.id)}" type="text" maxlength="64" value="${html(folder.name)}"></label>
        <p class="muted property-full">${folderMembers(data,folder.id).length} descendant objects · Moving the group translates all its contents without changing paint layers.</p>
        ${numericField('folder-dx','Move X by (px)',0,-canvasSize(data).width,canvasSize(data).width)}
        ${numericField('folder-dy','Move Y by (px)',0,-canvasSize(data).height,canvasSize(data).height)}
      </div>`;
      return;
    }
    const layerOptions=drawingLayers(data).filter(layer=>layer.id!=='background').map(layer=>
      `<option value="${html(layer.id)}">${html(`${layerIndex(data,layer.id)} · ${layer.name||'Unnamed layer'}`)}</option>`).join('');
    if(selection.length!==1){
      const units=selectionUnits(data,selection,{expandGroups:false});
      summary.textContent=`${selection.length} objects`;
      properties.innerHTML=`<p class="multi-selection-description">${selection.length} selected objects · ${units.length} movable units. Drag or use Align / Distribute to edit positions.</p>
        <label class="property-field">Assign selected objects to paint layer
          <select data-batch-layer><option value="">Choose layer…</option>${layerOptions}</select></label>`;
      return;
    }
    const {type,id}=selection[0],obj=getObject(data,type,id);
    if(!obj)return;
    summary.textContent=type==='rect'?'RECTANGLE':'TEXT';
    const {width,height}=canvasSize(data);
    const fields=[numericField('x','X',obj.x,-width,width),numericField('y','Y',obj.y,-height,height),
      numericField('w','Width',obj.w,1,width),numericField('h','Height',obj.h,1,height)].join('');
    const radius=type==='rect'?`<label class="property-field property-full">Corner radius <input data-property="radius" type="text" value="${html(Array.isArray(obj.radius)?obj.radius.join(' '):obj.radius??0)}" aria-label="CSS radius TL TR BR BL"></label>`:'';
    const text=type==='text'?`<div class="property-full"><label class="property-field">Text content
      <textarea id="text-value" data-text-buffer="${html(obj.buffer_ptr)}" rows="5" spellcheck="false"></textarea></label>
      <div class="buffer-note">Independent buffer · pointer <code>${html(obj.buffer_ptr)}</code></div></div>`:'';
    const paint=getLayer(data,obj.layerId);
    const palette=`<label class="property-field property-full">Paint layer
      <select data-property="layerId">${drawingLayers(data).filter(layer=>layer.id!=='background').map(layer=>
        `<option value="${html(layer.id)}"${obj.layerId===layer.id?' selected':''}>${html(`${layerIndex(data,layer.id)} · ${layer.name||'Unnamed layer'}`)}</option>`).join('')}</select>
      <span class="muted"><span class="property-color-chip" style="background:${validColor(paint?.color)}"></span>${html(paint?.name||'Unnamed layer')} · Change color in Palette / Layers</span></label>`;
    properties.innerHTML=`<div class="property-grid">${fields}${radius}${palette}
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
      <label>Y<input data-event="${i}" data-event-key="y" type="number" min="0" max="${canvasSize(data).height-1}" value="${html(event.y)}"></label>
      <label>Layer<select data-event="${i}" data-event-key="layerId">${drawingLayers(data).map((layer,index)=>
        `<option value="${html(layer.id)}"${event.layerId===layer.id?' selected':''}>${html(layer.name|| (index===0?'Background':'Unnamed layer'))}</option>`).join('')}</select></label>
      <label>Color<input data-event="${i}" data-event-key="color" type="color" value="${html(validColor(event.color))}"></label>
      <button type="button" data-remove-event="${i}" aria-label="Remove palette event">×</button>
    </div>`).join('');
  }

  function updateControls(){
    const count=selection.length,units=selectionUnits(scene(),selection,exactSelection);
    $('undo-edit').disabled=!history.state().canUndo;
    $('redo-edit').disabled=!history.state().canRedo;
    $('copy-objects').disabled=count===0;
    $('cut-objects').disabled=count===0;
    $('paste-objects').disabled=clipboard.length===0;
    $('remove-folder').disabled=!selectedFolderId||!getObjectFolder(scene(),selectedFolderId);
    $('duplicate-objects').disabled=count===0;
    $('delete-objects').disabled=count===0;
    $('align-objects').disabled=units.length<2;
    $('distribute-objects').disabled=units.length<3;
  }
  function render(){
    selection=resolveSelection(scene(),selection,exactSelection);
    if(selectedFolderId&&!getObjectFolder(scene(),selectedFolderId))selectedFolderId=null;
    if(mostRecentLayer&&!getLayer(scene(),mostRecentLayer))mostRecentLayer=null;
    renderStage();renderList();renderPaletteLayers();renderProperties();renderPaletteEvents();updateControls();
  }
  // Reveal a selected canvas object in the Objects panel without stealing
  // focus or moving the scroll position when its tile is already visible.
  function revealObjectTile(ref){
    if(!ref)return;
    const obj=getObject(scene(),ref.type,ref.id);
    if(!obj)return;
    let changed=false;
    let folderId=obj.parentId;
    const visited=new Set();
    while(folderId&&!visited.has(folderId)){
      visited.add(folderId);
      if(collapsedFolders.delete(folderId))changed=true;
      folderId=getObjectFolder(scene(),folderId)?.parentId;
    }
    const selector=`[data-select-type="${ref.type}"][data-select-id="${ref.id}"]`;
    let tile=list.querySelector(selector);
    // A canvas selection must remain discoverable even when the Objects
    // filter previously hid its layer or thumbnail.
    if(!tile&&$('object-filter').value){
      $('object-filter').value='';
      changed=true;
    }
    if(changed){renderList();tile=list.querySelector(selector);}
    if(!tile)return;
    const viewport=list.getBoundingClientRect();
    const bounds=tile.getBoundingClientRect();
    if(bounds.top<viewport.top)list.scrollTop+=bounds.top-viewport.top;
    else if(bounds.bottom>viewport.bottom)list.scrollTop+=bounds.bottom-viewport.bottom;
  }

  function setSelection(refs,{folderId=null,focusRef=null,preserveList=false,reveal=true}={}){
    selection=resolveSelection(scene(),refs,exactSelection);
    selectedFolderId=folderId;
    if(refs.length){
      const ref=refs.at(-1);
      const obj=getObject(scene(),ref.type,ref.id);
      if(obj&&obj.layerId!=='background')mostRecentLayer=obj.layerId;
    }
    renderStage();
    if(preserveList){
      // Preserve group title DOM across clicks so native dblclick still fires.
      const active=selected();
      list.querySelectorAll('[data-select-type]').forEach(el=>{
        const chosen=active.has(`${el.dataset.selectType}:${el.dataset.selectId}`);
        el.classList.toggle('is-selected',chosen);
        el.setAttribute('aria-pressed',String(chosen));
      });
      list.querySelectorAll('.object-folder-header').forEach(el=>{
        el.classList.toggle('is-selected',el.closest('[data-folder-drop]')?.dataset.folderDrop===folderId);
      });
    }else renderList();
    renderProperties();updateControls();
    if(reveal)revealObjectTile(focusRef??(refs.length?refs.at(-1):null));
  }
  function select(ref,additive=false){
    if(!ref){if(!additive)setSelection([]);return;}
    const obj=getObject(scene(),ref.type,ref.id);
    if(!obj)return;
    const old=selected();
    if(additive){
      const changed=old.has(key(ref))?selection.filter(item=>key(item)!==key(ref)):[...selection,ref];
      setSelection(changed,{focusRef:changed.some(item=>key(item)===key(ref))?ref:null});
    }else setSelection([ref],{focusRef:ref});
    if(obj.layerId!=='background')mostRecentLayer=obj.layerId;
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
      // Preserve a selected set for dragging, but a simple click always
      // drills down to the actual object clicked, not the whole group/selection.
      const alreadySelected=selected().has(key(ref));
      const drillDown=alreadySelected&&(selectedFolderId!=null||selection.length>1);
      if(!alreadySelected)select(ref);
      const mode=event.target.closest('[data-drag-handle]')?'resize':'move';
      const start=selection.map(item=>{
        const obj=getObject(scene(),item.type,item.id);
        return {...item,x:obj.x,y:obj.y,w:obj.w,h:obj.h};
      });
      history.begin();
      drag={mode,pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY,start,
        resizeRef:ref,drillDown:drillDown&&mode==='move',clickedRef:ref,changed:false};
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
      const {width,height}=canvasSize(scene());
      const x1=clamp(drag.clientX-bounds.left,0,width),y1=clamp(drag.clientY-bounds.top,0,height);
      const x2=clamp(event.clientX-bounds.left,0,width),y2=clamp(event.clientY-bounds.top,0,height);
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
        const {width,height}=canvasSize(scene());
        const x1=clamp(finished.clientX-bounds.left,0,width),y1=clamp(finished.clientY-bounds.top,0,height);
        const x2=clamp(event.clientX-bounds.left,0,width),y2=clamp(event.clientY-bounds.top,0,height);
        const left=Math.min(x1,x2),right=Math.max(x1,x2),top=Math.min(y1,y2),bottom=Math.max(y1,y2);
        const hits=objectsFullyInsideRect(scene(),{left,top,right,bottom},exactSelection);
        setSelection([...finished.base,...hits]);
      }
    }else{
      history.commit();
      if(finished.drillDown&&!finished.changed){
        select(finished.clickedRef);
      }else render();
    }
  }
  stage.addEventListener('pointerup',finishDrag);
  stage.addEventListener('pointercancel',finishDrag);
  stage.addEventListener('keydown',event=>{
    const el=event.target.closest('.scene-object');
    if(el&&(event.key==='Enter'||event.key===' ')){
      event.preventDefault();
      const ref={type:el.dataset.objectType,id:Number(el.dataset.objectId)};
      select(ref,event.shiftKey);
    }
  });
  list.addEventListener('click',event=>{
    const el=event.target.closest('[data-select-type]');
    if(el)select({type:el.dataset.selectType,id:Number(el.dataset.selectId)},
      event.shiftKey||event.ctrlKey||event.metaKey);
  });
  $('object-filter').addEventListener('input',renderList);
  $('show-objects').addEventListener('click',()=>{
    $('objects-pane').hidden=false;$('palette-pane').hidden=true;
    $('show-objects').classList.add('active');$('show-palette').classList.remove('active');
    $('show-objects').setAttribute('aria-selected','true');$('show-palette').setAttribute('aria-selected','false');
  });
  $('show-palette').addEventListener('click',()=>{
    $('objects-pane').hidden=true;$('palette-pane').hidden=false;
    $('show-objects').classList.remove('active');$('show-palette').classList.add('active');
    $('show-objects').setAttribute('aria-selected','false');$('show-palette').setAttribute('aria-selected','true');
  });
  $('add-folder').addEventListener('click',()=>{
    // When objects are selected, wrap them in a group at their existing
    // level. Selecting a group instead creates an empty child group.
    const refs=selectedFolderId?[]:[...selection];
    const parents=refs.map(ref=>getObject(scene(),ref.type,ref.id)?.parentId??null);
    const parentId=selectedFolderId??(parents.length&&parents.every(id=>id===parents[0])?parents[0]:null);
    let created=null;
    if(edit(()=>{
      created=addObjectFolder(scene(),{parentId});
      if(created&&refs.length)moveObjectsToFolder(scene(),refs,created.id);
    })&&created){
      setSelection(folderMembers(scene(),created.id),{folderId:created.id});
    }
  });
  $('remove-folder').addEventListener('click',()=>{
    const id=selectedFolderId;
    if(!id||!getObjectFolder(scene(),id))return;
    if(edit(()=>deleteObjectFolder(scene(),id))){
      collapsedFolders.delete(id);
      setSelection([]);
    }
  });
  list.addEventListener('click',event=>{
    const toggle=event.target.closest('[data-folder-toggle]');
    if(toggle){
      const id=toggle.dataset.folderToggle;
      if(collapsedFolders.has(id))collapsedFolders.delete(id);else collapsedFolders.add(id);
      renderList();return;
    }
    const title=event.target.closest('[data-folder-select]');
    if(title){
      const id=title.dataset.folderSelect;
      setSelection(folderMembers(scene(),id),{folderId:id,preserveList:true,reveal:false});
    }
  });
  list.addEventListener('dblclick',event=>{
    const title=event.target.closest('[data-folder-select]');
    if(!title)return;
    const input=title.parentElement.querySelector('[data-folder-name]');
    if(!input)return;
    title.hidden=true;input.hidden=false;
    input.focus();input.select();
  });
  list.addEventListener('change',event=>{
    const name=event.target.closest('[data-folder-name]');
    if(name)edit(()=>renameObjectFolder(scene(),name.dataset.folderName,name.value));
  });
  list.addEventListener('focusout',event=>{
    const input=event.target.closest('[data-folder-name]');
    if(!input||!list.contains(input))return;
    const title=input.parentElement.querySelector('[data-folder-select]');
    input.hidden=true;
    if(title){title.hidden=false;title.textContent=getObjectFolder(scene(),input.dataset.folderName)?.name||'New group';}
  });
  list.addEventListener('keydown',event=>{
    const input=event.target.closest('[data-folder-name]');
    if(!input)return;
    if(event.key==='Enter'){event.preventDefault();input.blur();}
    if(event.key==='Escape'){
      event.preventDefault();input.value=getObjectFolder(scene(),input.dataset.folderName)?.name??'';input.blur();
    }
  });
  $('add-layer').addEventListener('click',()=>edit(()=>addLayer(scene(),{color:'#92d0e1'})));
  const paintList=$('palette-layer-list');
  paintList.addEventListener('click',event=>{
    const button=event.target.closest('[data-layer-delete]');
    if(!button)return;
    const id=button.dataset.layerDelete,layer=getLayer(scene(),id);
    if(!layer)return;
    const count=sceneObjects(scene()).filter(({object})=>object.layerId===id).length;
    const events=scene().paletteEvents.filter(event=>event.layerId===id).length;
    if((count||events)&&!window.confirm(`Remove ${layer.name||id}? ${count} objects and ${events} palette overrides will be reassigned to an adjacent paint layer. This can be undone.`))return;
    edit(()=>removePaintLayer(scene(),id));
  });
  paintList.addEventListener('change',event=>{
    const color=event.target.closest('[data-layer-color]');
    if(color){edit(()=>setLayerColor(scene(),color.dataset.layerColor,color.value));return;}
    const name=event.target.closest('[data-layer-name]');
    if(name)edit(()=>setLayerName(scene(),name.dataset.layerName,name.value));
  });
  paintList.addEventListener('keydown',event=>{
    const input=event.target.closest('[data-layer-name]');
    if(!input)return;
    if(event.key==='Enter'){event.preventDefault();input.blur();}
    if(event.key==='Escape'){
      event.preventDefault();input.value=getLayerName(scene(),input.dataset.layerName);input.blur();
    }
  });
  // Reparenting in Objects never changes paint. Reordering in Palette never
  // changes composition. Each operation is a single history transaction.
  list.addEventListener('dragstart',event=>{
    if(event.target.closest('input'))return;
    const folder=event.target.closest('[data-folder-drag]');
    if(folder){
      draggedFolder=folder.dataset.folderDrag;draggedObjects=null;
      if(event.dataTransfer){event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',draggedFolder);}
      return;
    }
    const tile=event.target.closest('[data-select-type]');
    if(!tile||!event.dataTransfer)return;
    draggedFolder=null;
    const ref={type:tile.dataset.selectType,id:Number(tile.dataset.selectId)};
    draggedObjects=selected().has(key(ref))?selection.map(item=>({...item})):[ref];
    event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',`Move object ${ref.id}`);
  });
  list.addEventListener('dragover',event=>{
    const target=event.target.closest('[data-folder-drop],[data-objects-root-drop]');
    if(!target||(!draggedFolder&&!draggedObjects))return;
    const parentId=target.dataset.folderDrop??null;
    if(draggedFolder&&(parentId===draggedFolder))return;
    event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';
    list.querySelectorAll('.is-drop-target').forEach(el=>el.classList.remove('is-drop-target'));
    target.classList.add('is-drop-target');
  });
  list.addEventListener('drop',event=>{
    const target=event.target.closest('[data-folder-drop],[data-objects-root-drop]');
    if(!target||(!draggedFolder&&!draggedObjects))return;
    event.preventDefault();
    const parentId=target.dataset.folderDrop??null;
    if(draggedFolder){edit(()=>moveObjectFolder(scene(),draggedFolder,parentId));}
    else{
      const refs=draggedObjects;
      if(edit(()=>moveObjectsToFolder(scene(),refs,parentId)))setSelection(refs);
    }
    draggedFolder=null;draggedObjects=null;
    list.querySelectorAll('.is-drop-target').forEach(el=>el.classList.remove('is-drop-target'));
  });
  list.addEventListener('dragend',()=>{
    draggedFolder=null;draggedObjects=null;
    list.querySelectorAll('.is-drop-target').forEach(el=>el.classList.remove('is-drop-target'));
  });
  paintList.addEventListener('dragstart',event=>{
    const grip=event.target.closest('[data-layer-drag]');
    if(!grip||!event.dataTransfer)return;
    draggedPaintLayer=grip.dataset.layerDrag;
    event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',draggedPaintLayer);
  });
  paintList.addEventListener('dragover',event=>{
    const target=event.target.closest('[data-paint-layer]');
    if(!target||!draggedPaintLayer)return;
    event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';
    paintList.querySelectorAll('[data-layer-insert]').forEach(el=>el.removeAttribute('data-layer-insert'));
    const bounds=target.getBoundingClientRect();
    target.setAttribute('data-layer-insert',event.clientY<bounds.top+bounds.height/2?'above':'below');
  });
  paintList.addEventListener('drop',event=>{
    const target=event.target.closest('[data-paint-layer]');
    if(!target||!draggedPaintLayer)return;
    event.preventDefault();
    const bounds=target.getBoundingClientRect();
    const side=event.clientY<bounds.top+bounds.height/2?'above':'below';
    const moving=draggedPaintLayer;draggedPaintLayer=null;
    edit(()=>reorderLayer(scene(),moving,target.dataset.paintLayer,side));
    paintList.querySelectorAll('[data-layer-insert]').forEach(el=>el.removeAttribute('data-layer-insert'));
  });
  paintList.addEventListener('dragend',()=>{
    draggedPaintLayer=null;
    paintList.querySelectorAll('[data-layer-insert]').forEach(el=>el.removeAttribute('data-layer-insert'));
  });

  properties.addEventListener('change',event=>{
    const target=event.target;
    if(target.dataset.textBuffer!==undefined)return;
    if(target.dataset.selectedFolderName){
      edit(()=>renameObjectFolder(scene(),target.dataset.selectedFolderName,target.value));return;
    }
    if(target.dataset.property==='folder-dx'||target.dataset.property==='folder-dy'){
      if(selectedFolderId){
        const delta=Math.round(Number(target.value)||0);
        if(delta)edit(()=>moveObjectFolderContents(scene(),selectedFolderId,
          target.dataset.property==='folder-dx'?delta:0,target.dataset.property==='folder-dy'?delta:0));
      }
      return;
    }
    if(target.matches('[data-batch-layer]')){
      if(target.value)edit(()=>moveSelectionToLayer(scene(),selection,target.value,{expandGroups:false}));
      return;
    }
    if(selection.length!==1)return;
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
    edit(()=>removeSelectedObjects(scene(),selection,exactSelection));
    setSelection([]);
  }
  function copySelected(){
    if(!selection.length)return false;
    clipboard=copySelection(scene(),selection,exactSelection);
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
  $('align-objects').addEventListener('change',event=>{
    const value=event.target.value;event.target.value='';
    if(value)edit(()=>alignSelection(scene(),selection,value,exactSelection));
  });
  $('distribute-objects').addEventListener('change',event=>{
    const value=event.target.value;event.target.value='';
    if(value)edit(()=>distributeSelection(scene(),selection,value,exactSelection));
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
      item[name]=name==='color'||name==='layerId'?target.value:clamp(Math.round(Number(target.value)||0),0,canvasSize(scene()).height-1);
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
    clearSelection(){selection=[];selectedFolderId=null;mostRecentLayer=null;render();},
    getSelection(){return selection.map(ref=>({...ref}));},
    setSelection(refs){setSelection(refs);},
    setOnTextInput(callback){onTextInput=callback;}
  };
}
