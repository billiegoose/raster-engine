import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {blankScene} from './scene.js';
import {prepareObjectEditorScene,addRectangle,addText,addObjectFolder,moveObjectsToFolder,drawingLayers,getObjectFolder} from './scene-model.js';
import {createSceneHistory} from './scene-history.js';
import {createSceneEditor} from './scene-editor.js';

function harness(){
  const dom=new JSDOM(readFileSync(new URL('./index.html',import.meta.url),'utf8'),{url:'http://localhost/'});
  const previousDocument=globalThis.document,previousWindow=globalThis.window;
  globalThis.window=dom.window;
  globalThis.document=dom.window.document;
  let scene=prepareObjectEditorScene(blankScene());
  const rect=addRectangle(scene),label=addText(scene);
  rect.x=25;rect.y=30;label.x=100;label.y=30;
  const history=createSceneHistory({getScene:()=>scene,replaceScene:s=>{scene=s;}});
  let editor;
  try{editor=createSceneEditor({getScene:()=>scene,history,onSimulate:()=>{}});}
  catch(error){globalThis.document=previousDocument;globalThis.window=previousWindow;dom.window.close();throw error;}
  const $=id=>dom.window.document.getElementById(id);
  const click=element=>element.click();
  const change=(element,value)=>{
    element.value=value;
    element.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  };
  const drag=(element,type,dataTransfer)=>{
    const event=new dom.window.Event(type,{bubbles:true,cancelable:true});
    Object.defineProperty(event,'dataTransfer',{value:dataTransfer});
    Object.defineProperty(event,'clientY',{value:0});
    element.dispatchEvent(event);
    return event;
  };
  const cleanup=()=>{
    globalThis.document=previousDocument;globalThis.window=previousWindow;
    dom.window.close();
  };
  return {dom,$,getScene:()=>scene,rect,label,history,editor,click,change,drag,cleanup};
}

test('Objects and Palette are independent views; objects no longer nest under paint layers',()=>{
  const h=harness();try{
    expect(h.$('object-list').querySelectorAll('[data-select-type]')).toHaveLength(2);
    expect(h.$('object-list').querySelector('[data-layer-id]')).toBeNull();
    expect(h.$('palette-pane').hidden).toBe(true);
    expect(h.$('group-objects')).toBeNull();
    expect(h.$('ungroup-objects')).toBeNull();
    h.click(h.$('show-palette'));
    expect(h.$('palette-pane').hidden).toBe(false);
    expect(h.$('objects-pane').hidden).toBe(true);
    expect(h.$('palette-layer-list').querySelectorAll('[data-paint-layer]')).toHaveLength(2);
    h.click(h.$('show-objects'));
    expect(h.$('objects-pane').hidden).toBe(false);
    expect(h.$('object-list').querySelectorAll('[data-select-type]')).toHaveLength(2);
  }finally{h.cleanup();}
});

test('object properties assign paint by dropdown and palette owns the color picker',()=>{
  const h=harness();try{
    const tile=h.$('object-list').querySelector(`[data-select-type="rect"][data-select-id="${h.rect.id}"]`);
    h.click(tile);
    const dropdown=h.$('object-properties').querySelector('[data-property="layerId"]');
    expect(dropdown?.tagName).toBe('SELECT');
    expect(h.$('object-properties').querySelector('input[type=color]')).toBeNull();
    h.click(h.$('show-palette'));
    h.click(h.$('add-layer'));
    const added=drawingLayers(h.getScene()).at(-1);
    expect(added.id).not.toBe('layer-1');
    const name=h.$('palette-layer-list').querySelector(`[data-layer-name="${added.id}"]`);
    h.change(name,'Control foreground');
    h.change(h.$('palette-layer-list').querySelector(`[data-layer-color="${added.id}"]`),'#dd5800');
    h.click(h.$('show-objects'));
    h.click(h.$('object-list').querySelector(`[data-select-type="rect"][data-select-id="${h.rect.id}"]`));
    const updated=h.$('object-properties').querySelector('[data-property="layerId"]');
    expect(updated.textContent).toContain('Control foreground');
    h.change(updated,added.id);
    expect(h.getScene().shapes.find(s=>s.id===h.rect.id).layerId).toBe(added.id);
    expect(h.getScene().layers.find(l=>l.id===added.id).color).toBe('#dd5800');
    expect(h.history.undo()).toBe(true);
    h.editor.render();
    expect(h.getScene().shapes.find(s=>s.id===h.rect.id).layerId).not.toBe(added.id);
  }finally{h.cleanup();}
});

test('nested object folders can contain different paint layers and move together',()=>{
  const h=harness();try{
    h.click(h.$('add-folder'));
    const root=h.getScene().objectFolders[0];
    expect(root).toBeDefined();
    h.change(h.$('object-list').querySelector(`[data-folder-name="${root.id}"]`),'Widget');
    h.click(h.$('object-list').querySelector(`[data-add-child-folder="${root.id}"]`));
    const child=h.getScene().objectFolders.find(f=>f.parentId===root.id);
    expect(child).toBeDefined();
    const rectTile=h.$('object-list').querySelector(`[data-select-type="rect"][data-select-id="${h.rect.id}"]`);
    const dt={effectAllowed:'',setData:()=>{}};
    h.drag(rectTile,'dragstart',dt);
    const target=h.$('object-list').querySelector(`[data-folder-drop="${child.id}"] .object-folder-header`);
    h.drag(target,'dragover',dt);h.drag(target,'drop',dt);
    expect(h.getScene().shapes.find(s=>s.id===h.rect.id).parentId).toBe(child.id);
    // A successful drop re-renders the tree, so acquire the current target.
    const labelTile=h.$('object-list').querySelector(`[data-select-type="text"][data-select-id="${h.label.id}"]`);
    const currentTarget=h.$('object-list').querySelector(`[data-folder-drop="${child.id}"] .object-folder-header`);
    h.drag(labelTile,'dragstart',dt);
    h.drag(currentTarget,'dragover',dt);h.drag(currentTarget,'drop',dt);
    expect(h.getScene().texts.find(s=>s.id===h.label.id).parentId).toBe(child.id);
    const before=h.getScene().shapes.find(s=>s.id===h.rect.id).x;
    h.click(h.$('object-list').querySelector(`[data-folder-select="${root.id}"]`));
    expect(h.$('selection-summary').textContent).toBe('FOLDER');
    h.change(h.$('object-properties').querySelector('[data-property="folder-dx"]'),'15');
    expect(h.getScene().shapes.find(s=>s.id===h.rect.id).x).toBe(before+15);
    expect(h.getScene().texts.find(s=>s.id===h.label.id).x).toBe(115);
    expect(h.history.undo()).toBe(true);h.editor.render();
    expect(h.getScene().shapes.find(s=>s.id===h.rect.id).x).toBe(before);
    expect(h.getScene().objectFolders).toHaveLength(2);
  }finally{h.cleanup();}
});

test('folder deletion promotes children; empty folders still have editable properties',()=>{
  const h=harness();try{
    h.click(h.$('add-folder'));
    const folder=h.getScene().objectFolders[0];
    h.click(h.$('object-list').querySelector(`[data-folder-select="${folder.id}"]`));
    expect(h.$('selection-summary').textContent).toBe('FOLDER');
    expect(h.$('object-properties').querySelector('[data-selected-folder-name]')).not.toBeNull();
    h.click(h.$('object-list').querySelector(`[data-folder-delete="${folder.id}"]`));
    expect(h.getScene().objectFolders).toHaveLength(0);
    expect(h.getScene().shapes).toHaveLength(1);
    expect(h.getScene().texts).toHaveLength(1);
    expect(h.$('object-properties').textContent).not.toContain('0 selected objects');
  }finally{h.cleanup();}
});
