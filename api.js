import {rasterize} from './engine.js';
import {canvasSize} from './scene.js';
import {createSceneStore, SceneStoreError, MAX_SCENE_BYTES} from './scene-store.js';
import {compileScene} from './scene-model.js';

// Register future Pypeline or FPGA adapters here. The browser never imports a VM.
const backends = new Map([
  ['javascript', {
    label: 'JavaScript reference',
    run(scene) {
      if (scene.texts?.length) {
        throw new Error('TEXT requires the Python backend; JavaScript does not implement masked paint sources yet');
      }
      return rasterize(scene);
    }
  }],
  ['python', {
    label: 'Python reference',
    run(scene) {
      const command = process.env.RASTER_PYTHON || 'python3';
      const subprocess = Bun.spawnSync([command, 'python_backend.py'], {
        cwd: import.meta.dir,
        stdin: Buffer.from(JSON.stringify({scene})),
        stdout: 'pipe',
        stderr: 'pipe'
      });
      if (subprocess.exitCode !== 0) {
        const stderr = subprocess.stderr?.toString().trim();
        throw new Error(stderr || `Python backend failed with exit code ${subprocess.exitCode}`);
      }
      return JSON.parse(subprocess.stdout.toString());
    }
  }]
]);

export function listBackends() {
  return [...backends].map(([id, {label}]) => ({id, label}));
}

export function runBackend({backend = 'javascript', scene} = {}) {
  const implementation = backends.get(backend);
  if (!implementation) throw new Error(`Unknown backend: ${backend}`);
  if (!scene || !Array.isArray(scene.shapes) || !Array.isArray(scene.paletteEvents) || (!Array.isArray(scene.palette) && !Array.isArray(scene.layers))) {
    throw new Error('Scene must contain shapes, palette, and paletteEvents arrays');
  }
  const dimensions=canvasSize(scene);
  const result = implementation.run(compileScene(scene));
  // Preserve the inspector's existing trace contract; JSON has no Uint8Array.
  return {
    ...result,
    backend,
    width: dimensions.width,
    height: dimensions.height,
    scanlines: result.scanlines.map(({row, ...scanline}) => ({...scanline, row: Array.from(row)}))
  };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}
});

const defaultSceneStore = createSceneStore();

export async function handleApiRequest(request, pathname, sceneStore = defaultSceneStore) {
  if (pathname === '/api/scenes' || pathname.startsWith('/api/scenes/')) {
    try {
      if (pathname === '/api/scenes') {
        if (request.method !== 'GET') return json({error: 'Method not allowed'}, 405);
        return json({scenes: await sceneStore.list()});
      }
      let name;
      try { name = decodeURIComponent(pathname.slice('/api/scenes/'.length)); }
      catch { return json({error: 'Invalid scene name encoding'}, 400); }
      if (request.method === 'GET') return json({name, scene: await sceneStore.load(name)});
      if (request.method === 'PUT') {
        if (Number(request.headers.get('content-length')) > MAX_SCENE_BYTES)
          return json({error: 'Scene too large'}, 413);
        const body = await request.text();
        if (Buffer.byteLength(body) > MAX_SCENE_BYTES)
          return json({error: 'Scene too large'}, 413);
        let scene;
        try { scene = JSON.parse(body); }
        catch { return json({error: 'Invalid JSON'}, 400); }
        const savedName = await sceneStore.save(name, scene);
        return json({name: savedName});
      }
      return json({error: 'Method not allowed'}, 405);
    } catch (error) {
      if (error instanceof SceneStoreError) return json({error: error.message}, error.status);
      console.error('Scene storage error:', error);
      return json({error: 'Unable to access scene files'}, 500);
    }
  }
  if (pathname === '/api/backends') {
    if (request.method !== 'GET') return json({error: 'Method not allowed'}, 405);
    return json({backends: listBackends()});
  }
  if (pathname !== '/api/run') return null;
  if (request.method !== 'POST') return json({error: 'Method not allowed'}, 405);
  if (Number(request.headers.get('content-length')) > 1024 * 1024) return json({error: 'Scene too large'}, 413);
  try {
    const payload = await request.json();
    return json(runBackend(payload));
  } catch (error) {
    return json({error: error instanceof Error ? error.message : String(error)}, 400);
  }
}
