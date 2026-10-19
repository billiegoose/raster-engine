/* Workspace controller: native local scene files and an independent simulator. */
import {blankScene,canvasSize} from './scene.js';
import {prepareObjectEditorScene,setCanvasSize} from './scene-model.js';
import {createSceneEditor} from './scene-editor.js';
import {createSceneHistory} from './scene-history.js';
import {createRasterSimulator} from './raster-simulator.js';

const $=id=>document.getElementById(id);
let scene=prepareObjectEditorScene(blankScene());
const getScene=()=>scene;
const snapshot=()=>JSON.stringify(scene);
let editor;
let savedName=null,sceneRevision=0,sceneFileBusy=false;
let savedSnapshot=snapshot(),sceneDirty=false;
let availableScenes=[];
const picker=$('saved-scenes');
const newButton=$('scene-new'),saveButton=$('scene-save');
const saveAsButton=$('scene-save-as'),refreshButton=$('scene-refresh');
const saveAsDialog=$('scene-save-as-dialog'),saveAsName=$('scene-save-as-name');
const saveAsConfirm=$('scene-save-as-confirm');
const resolutionPicker=$('scene-resolution');
function syncResolutionUI(){
  const {width,height}=canvasSize(scene);
  const value=`${width}x${height}`;
  for(const item of [...resolutionPicker.options])if(item.dataset.custom==='true')item.remove();
  if(![...resolutionPicker.options].some(item=>item.value===value)){
    const custom=new Option(`Custom · ${width} × ${height}`,value);
    custom.dataset.custom='true';
    resolutionPicker.add(custom);
  }
  resolutionPicker.value=value;
  $('scene-size-heading').textContent=`RASTER ENGINE / ${width} × ${height}`;
}

function sceneStatus(message,kind='info'){
  $('scene-file-status').textContent=message;
  $('scene-file-status').dataset.kind=kind;
}
function syncFileUI(){
  picker.value=savedName&&availableScenes.includes(savedName)?savedName:'';
  for(const control of [picker,newButton,saveButton,saveAsButton,refreshButton,saveAsConfirm]){
    control.disabled=sceneFileBusy;
  }
}
function setSceneFileBusy(busy){sceneFileBusy=busy;syncFileUI();}
function sceneChanged(){
  sceneRevision++;
  sceneDirty=snapshot()!==savedSnapshot;
  simulator.markDirty();
  syncResolutionUI();
  sceneStatus(sceneDirty?`Unsaved changes · ${savedName?savedName+'.json':'Untitled'}`:
    (savedName?`${savedName}.json · saved`:'Untitled · not saved'),sceneDirty?'dirty':'info');
}
async function sceneRequest(path,options){
  const response=await fetch(path,options);
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||`Request failed (${response.status})`);
  return data;
}
async function refreshScenes(){
  const {scenes}=await sceneRequest('/api/scenes');
  availableScenes=scenes;
  picker.replaceChildren(new Option('Untitled',''));
  picker.options[0].disabled=true;
  for(const name of scenes)picker.add(new Option(name+'.json',name));
  syncFileUI();
}
function newScene(){
  if(sceneFileBusy)return false;
  if(sceneDirty&&!window.confirm('Discard unsaved changes and create a new blank scene?'))return false;
  scene=prepareObjectEditorScene(blankScene());
  savedName=null;
  savedSnapshot=snapshot();
  sceneDirty=false;
  sceneRevision++;
  history.reset();
  editor.clearSelection();
  simulator.markDirty();
  syncResolutionUI();
  syncFileUI();
  sceneStatus('Untitled · not saved');
  return true;
}
async function loadScene(name){
  if(sceneFileBusy||!name)return;
  if(name===savedName){syncFileUI();return;}
  if(sceneDirty&&!window.confirm(`Discard unsaved changes and open ${name}.json?`)){
    syncFileUI();return;
  }
  const revision=sceneRevision;
  setSceneFileBusy(true);
  try{
    const result=await sceneRequest('/api/scenes/'+encodeURIComponent(name));
    if(sceneRevision!==revision){
      sceneStatus('Scene changed during loading; open it again to avoid losing edits','dirty');
      return;
    }
    scene=prepareObjectEditorScene(result.scene);
    savedName=result.name;
    savedSnapshot=snapshot();
    sceneDirty=false;
    sceneRevision++;
    history.reset();
    editor.clearSelection();
    simulator.markDirty();
    syncResolutionUI();
    sceneStatus(`Opened ${savedName}.json`);
  }catch(error){sceneStatus('Open failed: '+error.message,'error');}
  finally{setSceneFileBusy(false);}
}
async function writeScene(name){
  if(sceneFileBusy)return false;
  const source=snapshot();
  setSceneFileBusy(true);
  try{
    const {name:canonical}=await sceneRequest('/api/scenes/'+encodeURIComponent(name),{
      method:'PUT',headers:{'Content-Type':'application/json'},body:source
    });
    savedName=canonical;
    savedSnapshot=source;
    sceneDirty=snapshot()!==savedSnapshot;
    try{await refreshScenes();}
    catch(error){sceneStatus(`Saved ${canonical}.json, but refreshing the list failed: ${error.message}`,'error');return true;}
    sceneStatus(sceneDirty?`Saved ${canonical}.json · newer edits are unsaved`:`Saved ${canonical}.json`,
      sceneDirty?'dirty':'info');
    return true;
  }catch(error){
    sceneStatus('Save failed: '+error.message,'error');
    if(saveAsDialog.open){$('scene-save-as-error').hidden=false;$('scene-save-as-error').textContent=error.message;}
    return false;
  }finally{setSceneFileBusy(false);}
}
function openSaveAs(){
  if(sceneFileBusy)return;
  saveAsName.value=savedName??'';
  $('scene-save-as-error').hidden=true;
  $('scene-save-as-error').textContent='';
  saveAsDialog.showModal();
  saveAsName.focus();
  saveAsName.select();
}
function saveScene(){
  if(sceneFileBusy)return;
  if(savedName)void writeScene(savedName);
  else openSaveAs();
}
function setMode(target){
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
  replaceScene(value){scene=prepareObjectEditorScene(value);},
  getSelection(){return editor?.getSelection()??[];},
  replaceSelection(refs){editor?.setSelection(refs);},
  onChange(){sceneChanged();},
  onStateChange(){editor?.updateHistoryControls();}
});
editor=createSceneEditor({getScene,history,onSimulate(){setMode('simulator');}});
const simulator=createRasterSimulator({getScene,onEditor:()=>setMode('editor')});
editor.setOnTextInput(sceneChanged);

resolutionPicker.addEventListener('change',()=>{
  const [width,height]=resolutionPicker.value.split('x').map(Number);
  if(history.transaction(()=>setCanvasSize(scene,width,height)))editor.render();
  syncResolutionUI();
});
newButton.addEventListener('click',newScene);
saveButton.addEventListener('click',saveScene);
saveAsButton.addEventListener('click',openSaveAs);
$('scene-save-as-cancel').addEventListener('click',()=>saveAsDialog.close());
$('scene-save-as-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if(sceneFileBusy)return;
  const name=saveAsName.value.trim();
  const canonical=name.replace(/\.json$/i,'');
  const error=$('scene-save-as-error');
  if(!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(canonical)){
    error.textContent='Use 1–64 letters, numbers, spaces, underscores, or hyphens.';
    error.hidden=false;
    return;
  }
  if(availableScenes.includes(canonical)&&canonical!==savedName&&
     !window.confirm(`Overwrite existing ${canonical}.json?`))return;
  error.hidden=true;
  if(await writeScene(name))saveAsDialog.close();
});
picker.addEventListener('change',()=>{
  const name=picker.value;
  if(name)void loadScene(name);
  else syncFileUI();
});
refreshButton.addEventListener('click',async()=>{
  if(sceneFileBusy)return;
  setSceneFileBusy(true);
  try{await refreshScenes();sceneStatus('Scene list refreshed');}
  catch(error){sceneStatus('Refresh failed: '+error.message,'error');}
  finally{setSceneFileBusy(false);}
});
void refreshScenes().catch(error=>sceneStatus('Unable to list scenes: '+error.message,'error'));
$('mode-editor').addEventListener('click',()=>setMode('editor'));
$('mode-simulator').addEventListener('click',()=>setMode('simulator'));
syncResolutionUI();
setMode('editor');
