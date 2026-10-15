import {handleApiRequest} from './api.js';
const root = import.meta.dir;
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = Bun.serve({
  port: Number(process.env.PORT || 3000),
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const apiResponse = await handleApiRequest(request, pathname);
    if (apiResponse) return apiResponse;
    if (!['/index.html', '/app.js', '/scene.js', '/scene-model.js', '/scene-editor.js', '/raster-simulator.js', '/palette-view.js', '/style.css'].includes(pathname)) return new Response('Not found', { status: 404 });
    const file = Bun.file(root + pathname);
    if (!(await file.exists())) return new Response('Not found', { status: 404 });
    return new Response(file, { headers: { 'Content-Type': types[pathname.slice(pathname.lastIndexOf('.'))] || 'application/octet-stream' } });
  }
});
console.log(`Raster engine: http://localhost:${server.port}`);
