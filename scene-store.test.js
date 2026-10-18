import {validateScene} from './scene-store.js';
import {test, expect} from 'bun:test';
import {mkdtemp, rm, readdir, readFile, writeFile, symlink, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {demoScene} from './scene.js';
import {addText, editableScene, getLayer, setLayerName} from './scene-model.js';
import {createSceneStore, sceneName, SceneStoreError, MAX_SCENE_BYTES} from './scene-store.js';
import {handleApiRequest} from './api.js';

const withStore = async callback => {
  const root = await mkdtemp(join(tmpdir(), 'raster-scene-tests-'));
  const directory = join(root, 'scenes');
  try { await callback(createSceneStore(directory), directory, root); }
  finally { await rm(root, {recursive: true, force: true}); }
};
const api = (store, path, method = 'GET', value) => handleApiRequest(
  new Request('http://localhost' + path, {
    method,
    ...(value === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)})
  }), path, store
);

test('scene store creates ./scenes and round-trips rectangles, text, palette and events', async () => {
  await withStore(async (store, directory) => {
    expect(await store.list()).toEqual([]);
    const original = editableScene(demoScene());
    getLayer(original,'layer-20').color = '#a1b2c3';
    original.paletteEvents.push({y: 233, layerId: 'layer-20', color: '#123abc'});
    const text = addText(original);
    original.textBuffers[String(text.buffer_ptr)] = 'P.O.\nHELLO, WORLD!';
    const result = await api(store, '/api/scenes/my%20first%20scene', 'PUT', original);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({name: 'my first scene'});
    expect(JSON.parse(await readFile(join(directory, 'my first scene.json'), 'utf8'))).toEqual(original);
    const names = await api(store, '/api/scenes');
    expect(await names.json()).toEqual({scenes: ['my first scene']});
    const loaded = await api(store, '/api/scenes/my%20first%20scene');
    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toEqual({name: 'my first scene', scene: original});
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    getLayer(original,'layer-20').color = '#003344';
    original.shapes.pop();
    expect((await api(store, '/api/scenes/my%20first%20scene.json', 'PUT', original)).status).toBe(200);
    expect(await store.load('my first scene')).toEqual(original);
    expect(await store.list()).toEqual(['my first scene']);
  });
});

test('scene paths cannot escape ./scenes or use hidden names', async () => {
  await withStore(async (store, directory, root) => {
    const original = demoScene();
    for (const name of ['../outside', '..', '.', '/tmp/evil', 'other/name', 'other\\\\name', '.hidden', 'bad?.json', '', '🦆', 'x'.repeat(66)]) {
      expect(() => sceneName(name)).toThrow(SceneStoreError);
      const response = await api(store, '/api/scenes/' + encodeURIComponent(name), 'PUT', original);
      expect(response.status).toBe(400);
    }
    const badEncoding = await handleApiRequest(new Request('http://localhost/api/scenes/%25FF'), '/api/scenes/%FF', store);
    expect(badEncoding.status).toBe(400);
    expect(await readdir(root)).toEqual([]);
  });
});

test('API reports malformed payloads, invalid scenes, size limits, 404 and method restrictions', async () => {
  await withStore(async (store, directory) => {
    expect((await api(store, '/api/scenes/no-such-file')).status).toBe(404);
    expect((await api(store, '/api/scenes', 'PUT', demoScene())).status).toBe(405);
    expect((await api(store, '/api/scenes/test', 'DELETE')).status).toBe(405);
    expect((await api(store, '/api/scenes/test', 'PUT', {shapes: []})).status).toBe(400);
    const broken = new Request('http://localhost/api/scenes/test', {method:'PUT', body:'{broken'});
    expect((await handleApiRequest(broken, '/api/scenes/test', store)).status).toBe(400);
    const tooLarge = { ...demoScene(), metadata: 'x'.repeat(MAX_SCENE_BYTES) };
    expect((await api(store, '/api/scenes/large', 'PUT', tooLarge)).status).toBe(413);
    const invalid = demoScene(); invalid.palette[0] = 'bad-color';
    expect((await api(store, '/api/scenes/bad', 'PUT', invalid)).status).toBe(400);
    const lengthSpoof = new Request('http://localhost/api/scenes/foo', {method:'PUT', body:JSON.stringify(demoScene()), headers:{'Content-Length': String(MAX_SCENE_BYTES + 1)}});
    expect((await handleApiRequest(lengthSpoof, '/api/scenes/foo', store)).status).toBe(413);
    expect(await store.list()).toEqual([]);
  });
});

test('scene listing excludes temporary, unrelated and symlink files', async () => {
  await withStore(async (store, directory, root) => {
    await mkdir(directory);
    await writeFile(join(directory, 'valid.json'), JSON.stringify(demoScene()));
    await writeFile(join(directory, '.partial.tmp'), '{}');
    await writeFile(join(directory, 'bad!.json'), '{}');
    await writeFile(join(directory, 'notes.txt'), 'notes');
    const outside = join(root, 'outside.json');
    await writeFile(outside, JSON.stringify(demoScene()));
    await symlink(outside, join(directory, 'alias.json'));
    expect(await store.list()).toEqual(['valid']);
    const symlinkRequest = await api(store, '/api/scenes/alias');
    expect(symlinkRequest.status).toBe(400);
    const invalidFile = join(directory, 'broken.json');
    await writeFile(invalidFile, '{bad');
    const brokenRequest = await api(store, '/api/scenes/broken');
    expect(brokenRequest.status).toBe(400);
  });
});


test('scene validator accepts named layers and rejects invalid metadata',()=>{
  const scene=demoScene();
  scene.layerNames={'0':'Background','12':'Bricks','63':'HUD'};
  expect(validateScene(scene).layerNames['12']).toBe('Bricks');
  for(const invalid of [{'64':'Bad'}, {'abc':'Bad'}, {'1':''}, {'2':'a'.repeat(65)}, {'3':42}]){
    expect(()=>validateScene({...scene,layerNames:invalid})).toThrow();
  }
  expect(validateScene(demoScene()).layerNames).toBeUndefined();
});
