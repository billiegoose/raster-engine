import {WIDTH, HEIGHT, rasterize} from './engine.js';

// Register future Pypeline or FPGA adapters here. The browser never imports a VM.
const backends = new Map([
  ['javascript', {
    label: 'JavaScript reference',
    run(scene) { return rasterize(scene); }
  }]
]);

export function listBackends() {
  return [...backends].map(([id, {label}]) => ({id, label}));
}

export function runBackend({backend = 'javascript', scene} = {}) {
  const implementation = backends.get(backend);
  if (!implementation) throw new Error(`Unknown backend: ${backend}`);
  if (!scene || !Array.isArray(scene.shapes) || !Array.isArray(scene.palette) || !Array.isArray(scene.paletteEvents)) {
    throw new Error('Scene must contain shapes, palette, and paletteEvents arrays');
  }
  const result = implementation.run(scene);
  // Preserve the inspector's existing trace contract; JSON has no Uint8Array.
  return {
    ...result,
    backend,
    width: WIDTH,
    height: HEIGHT,
    frames: result.frames.map(({row, ...frame}) => ({...frame, row: Array.from(row)}))
  };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}
});

export async function handleApiRequest(request, pathname) {
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
