import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Browser ESM imports are fetched individually, unlike the Bun build. Every
// recursively imported module needs an entry in the server static allowlist.
test('static server exposes all browser-imported JavaScript modules',()=>{
  const source=readFileSync(new URL('./server.ts',import.meta.url),'utf8');
  const allowlist=source.match(/if\s*\(!\[(.*?)\]\.includes\(pathname\)\)/s);
  expect(allowlist).not.toBeNull();
  const served=new Set([...allowlist[1].matchAll(/'([^']+)'/g)].map(match=>match[1]));
  const visited=new Set();
  const inspect=pathname=>{
    if(visited.has(pathname))return;
    visited.add(pathname);
    expect(served.has(pathname)).toBe(true);
    const file=resolve(import.meta.dir,'.'+pathname);
    const module=readFileSync(file,'utf8');
    const imports=[...module.matchAll(/\bfrom\s+['"](\.\.?\/[^'"]+\.js)['"]|\bimport\s+['"](\.\.?\/[^'"]+\.js)['"]/g)];
    for(const match of imports){
      const specifier=match[1]??match[2];
      const imported=new URL(specifier,'http://localhost'+pathname).pathname;
      inspect(imported);
    }
  };
  inspect('/app.js');
  expect(visited.has('/scene-url.js')).toBe(true);
});
