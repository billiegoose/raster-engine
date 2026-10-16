/* Workspace controller. The editor owns direct manipulation of one scene;
   the simulator is a separate read-only, backend-driven view of that scene. */
import {demoScene} from './scene.js';
import {editableScene} from './scene-model.js';
import {createSceneEditor} from './scene-editor.js';
import {createSceneHistory} from './scene-history.js';
import {createRasterSimulator} from './raster-simulator.js';

const $=id=>document.getElementById(id);
let scene=editableScene(demoScene());
const getScene=()=>scene;
let editor;
let mode='editor';
let savedName=null,sceneDirty=false,sceneRevision=0,sceneFileBusy=false;
let availableScenes=[];
const filename=$('scene-file-name'),picker=$('saved-scenes');
const saveButton=$('scene-save'),loadButton=$('scene-load'),refreshButton=$('scene-refresh');

function sceneStatus(message,kind='info'){
  $('scene-file-status').textContent=message;
  $('scene-file-status').dataset.kind=kind;
}
function setSceneFileBusy(busy){
  sceneFileBusy=busy;
  for(const button of [saveButton,loadButton,refreshButton])button.disabled=busy;
}
function sceneChanged(){
  sceneRevision++;
  sceneDirty=true;
  simulator.markDirty();
  sceneStatus(`Unsaved changes${savedName?' · '+savedName+'.json':''}`,'dirty');
}
async function sceneRequest(path,options){
  const response=await fetch(path,options);
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||`Request failed (${response.status})`);
  return data;
}
async function refreshScenes(preferred=picker.value){
  const {scenes}=await sceneRequest('/api/scenes');
  availableScenes=scenes;
  picker.replaceChildren(new Option('Choose a scene…',''));
  for(const name of scenes)picker.add(new Option(name+'.json',name));
  picker.value=scenes.includes(preferred)?preferred:'';
}
async function saveScene(){
  if(sceneFileBusy)return;
  const name=filename.value.trim();
  if(!name){sceneStatus('Enter a scene name before saving','error');filename.focus();return;}
  const canonical=name.replace(/\.json$/i,'');
  if(availableScenes.includes(canonical)&&savedName!==canonical&&
     !window.confirm(`Overwrite ${canonical}.json?`))return;
  const revision=sceneRevision;
  setSceneFileBusy(true);
  try{
    const {name:saved}=await sceneRequest('/api/scenes/'+encodeURIComponent(name),{
      method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(getScene())
    });
    savedName=saved;
    filename.value=saved;
    await refreshScenes(saved);
    sceneDirty=sceneRevision!==revision;
    sceneStatus(sceneDirty?`Saved ${saved}.json · newer changes are unsaved`:`Saved ${saved}.json`,sceneDirty?'dirty':'info');
  }catch(error){sceneStatus('Save failed: '+error.message,'error');}
  finally{setSceneFileBusy(false);}
}
async function loadScene(){
  if(sceneFileBusy)return;
  const name=picker.value||filename.value.trim().replace(/\.json$/i,'');
  if(!name){sceneStatus('Choose a saved scene to load','error');return;}
  if(sceneDirty&&!window.confirm('Discard unsaved scene changes and load '+name+'.json?'))return;
  const revision=sceneRevision;
  setSceneFileBusy(true);
  try{
    const result=await sceneRequest('/api/scenes/'+encodeURIComponent(name));
    if(sceneRevision!==revision){
      sceneStatus('Scene changed while loading; load again to avoid losing edits','dirty');
      return;
    }
    scene=editableScene(result.scene);
    savedName=result.name;
    sceneDirty=false;
    sceneRevision++;
    filename.value=savedName;
    picker.value=savedName;
    history.reset();
    editor.clearSelection();
    simulator.markDirty();
    sceneStatus(`Loaded ${savedName}.json`);
  }catch(error){sceneStatus('Load failed: '+error.message,'error');}
  finally{setSceneFileBusy(false);}
}

function setMode(target){
  mode=target;
  $('editor-view').hidden=target!=='editor';
  $('simulator-view').hidden=target!=='simulator';
  for(const key of ['editor','simulator']){
    const button=$(`mode-${key}`);
    button.classList.toggle('active',key===target);
    button.setAttribute('aria-pressed',String(key===target));
  }
  if(target==='simulator')void simulator.open();
  else simulator.pause();
}

const history=createSceneHistory({
  getScene,
  replaceScene(value){scene=editableScene(value);},
  getSelection(){return editor?.getSelection()??[];},
  replaceSelection(refs){editor?.setSelection(refs);},
  onChange(){sceneChanged();},
  onStateChange(){editor?.updateHistoryControls();}
});
editor=createSceneEditor({
  getScene,
  history,
  onSimulate(){setMode('simulator');},
  onReset(){
    scene=editableScene(demoScene());
    history.reset();
    editor.clearSelection();
    sceneRevision++;
    sceneDirty=false;
    savedName=null;
    filename.value='';
    picker.value='';
    simulator.markDirty();
    sceneStatus('Demo scene · not saved');
  }
});
const simulator=createRasterSimulator({getScene,onEditor:()=>setMode('editor')});
editor.setOnTextInput(sceneChanged);
saveButton.addEventListener('click',()=>void saveScene());
loadButton.addEventListener('click',()=>void loadScene());
refreshButton.addEventListener('click',async()=>{
  if(sceneFileBusy)return;
  setSceneFileBusy(true);
  try {await refreshScenes();sceneStatus('Saved scenes refreshed');}
  catch(error){sceneStatus('Refresh failed: '+error.message,'error');}
  finally{setSceneFileBusy(false);}
});
picker.addEventListener('change',()=>{if(picker.value)filename.value=picker.value;});
filename.addEventListener('keydown',event=>{
  if(event.key==='Enter'){event.preventDefault();void saveScene();}
});
void refreshScenes().catch(error=>sceneStatus('Unable to list scenes: '+error.message,'error'));
$('mode-editor').addEventListener('click',()=>setMode('editor'));
$('mode-simulator').addEventListener('click',()=>setMode('simulator'));
setMode('editor');
