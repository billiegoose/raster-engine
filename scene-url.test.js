import {test,expect} from 'bun:test';
import {JSDOM} from 'jsdom';
import {requestedSceneName,hasSceneParameter,syncSceneUrl} from './scene-url.js';

test('URL scene name accepts encoded filenames, with or without .json',()=>{
  expect(requestedSceneName('?scene=amber-components.json')).toBe('amber-components');
  expect(requestedSceneName('?scene=My+Scene.json')).toBe('My Scene');
  expect(requestedSceneName('?scene=My%20Scene')).toBe('My Scene');
  expect(requestedSceneName('?other=value&scene=AMBER.JSON')).toBe('AMBER');
  expect(requestedSceneName('?other=value')).toBeNull();
  expect(hasSceneParameter('?other=value')).toBe(false);
});

test('invalid URL scene names are rejected, including path traversal',()=>{
  for(const name of ['', '../private', 'foo/bar.json', '.json', 'x'.repeat(65),'a%2Fb.json','a%00b.json']){
    const query='?scene='+encodeURIComponent(name);
    expect(hasSceneParameter(query)).toBe(true);
    expect(requestedSceneName(query)).toBeNull();
  }
});

test('opening, saving under a new name and creating untitled scenes update the URL',()=>{
  const dom=new JSDOM('',{url:'http://localhost:3000/editor?mode=preview#details'});
  const {location,history}=dom.window;
  const historyState={editor:'keep'};
  history.replaceState(historyState,'',location.href);
  syncSceneUrl(location,history,'amber-components');
  expect(location.href).toBe('http://localhost:3000/editor?mode=preview&scene=amber-components.json#details');
  expect(history.state).toEqual(historyState);
  syncSceneUrl(location,history,'My Scene');
  expect(location.search).toBe('?mode=preview&scene=My+Scene.json');
  expect(requestedSceneName(location.search)).toBe('My Scene');
  syncSceneUrl(location,history,null);
  expect(location.href).toBe('http://localhost:3000/editor?mode=preview#details');
  dom.window.close();
});

test('updating an unchanged URL does not replace browser history',()=>{
  const location={href:'http://localhost/?scene=demo.json'};
  let calls=0;
  const history={state:null,replaceState(){calls++;}};
  syncSceneUrl(location,history,'demo');
  expect(calls).toBe(0);
});
