/* Workspace controller. The editor owns direct manipulation of one scene;
   the simulator is a separate read-only, backend-driven view of that scene. */
import {demoScene} from './scene.js';
import {editableScene} from './scene-model.js';
import {createSceneEditor} from './scene-editor.js';
import {createRasterSimulator} from './raster-simulator.js';

const $=id=>document.getElementById(id);
let scene=editableScene(demoScene());
const getScene=()=>scene;
let mode='editor';

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

const editor=createSceneEditor({
  getScene,
  onChange(){simulator.markDirty();},
  onSimulate(){setMode('simulator');},
  onReset(){
    scene=editableScene(demoScene());
    editor.clearSelection();
    simulator.markDirty();
  }
});
const simulator=createRasterSimulator({getScene,onEditor:()=>setMode('editor')});
$('mode-editor').addEventListener('click',()=>setMode('editor'));
$('mode-simulator').addEventListener('click',()=>setMode('simulator'));
setMode('editor');
