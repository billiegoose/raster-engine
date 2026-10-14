import {WIDTH,HEIGHT,LAYERS,demoScene} from './scene.js';
import {paletteView} from './palette-view.js';
let scene=demoScene(), result, selectedY=330, playing=false,timer=null, runGeneration=0;
const $=id=>document.getElementById(id);
const screen=$('screen'),ctx=screen.getContext('2d'),timeline=$('timeline').getContext('2d');
async function build() {
  const generation=++runGeneration;
  renderScene();
  $('stats').textContent='Running '+$('backend').value+' backend…';
  try {
    const response=await fetch('/api/run',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({backend:$('backend').value,scene})
    });
    const data=await response.json();
    if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
    if(generation!==runGeneration)return; // Ignore stale results after rapid edits.
    result=data;
    draw();
    inspect();
    $('stats').textContent=`${data.backend} · ${scene.shapes.length} shapes · ${data.totalEvents} X events · ${data.totalEdits} Y edits`;
  }catch(e){
    if(generation!==runGeneration)return;
    $('stats').textContent=`ERROR: ${e.message}`;
    console.error(e);
  }
}
async function loadBackends(){
  try{
    const response=await fetch('/api/backends');
    if(!response.ok)throw Error(`HTTP ${response.status}`);
    const {backends}=await response.json();
    const current=$('backend').value;
    $('backend').innerHTML=backends.map(b=>`<option value="${escape(b.id)}">${escape(b.label)}</option>`).join('');
    if(backends.some(b=>b.id===current))$('backend').value=current;
  }catch(e){console.warn('Backend discovery unavailable:',e);}
}

function draw(){
  if(!result)return;
  const image=ctx.createImageData(WIDTH,HEIGHT);
  const colors=new Map();
  const rgb=hex=>{
    if(!colors.has(hex)){
      const h=hex.replace('#','');
      colors.set(hex,[parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]);
    }
    return colors.get(hex);
  };
  for(let y=0;y<HEIGHT;y++){
    const frame=result.frames[y];
    for(let x=0;x<WIDTH;x++){
      const [r,g,b]=rgb(frame.palette[frame.row[x]]||'#101827');
      const i=(y*WIDTH+x)*4;
      image.data[i]=r;image.data[i+1]=g;image.data[i+2]=b;image.data[i+3]=255;
    }
  }
  ctx.putImageData(image,0,0);
  ctx.fillStyle='rgba(255,255,255,.7)';
  ctx.fillRect(0,selectedY,WIDTH,1);
  const tw=timeline.canvas.width,th=timeline.canvas.height;
  timeline.clearRect(0,0,tw,th);
  timeline.fillStyle='#0b1420';timeline.fillRect(0,0,tw,th);
  const xscale=tw/WIDTH,yscale=th/HEIGHT;
  for(const f of result.frames){
    const py=Math.floor(f.y*yscale);
    for(const e of f.edges){
      timeline.fillStyle='#6dc6d0';
      timeline.fillRect(Math.floor(e.x*xscale),py,1,1);
    }
    if(f.edits){
      timeline.fillStyle='#efb55c';
      timeline.fillRect(0,py,Math.min(tw,f.edits*3),1);
    }
  }
  timeline.fillStyle='#fff';
  timeline.fillRect(0,Math.floor(selectedY*yscale),tw,1);
  $('yvalue').textContent=selectedY;
  $('scanline').value=selectedY;
}

const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function formatY(ins){
  switch(ins.op){
    case 'WAIT_Y':return `y = ${ins.y}`;
    case 'ROUND_RECT':return `shape ${ins.rect.id}: x=${ins.rect.x}, y=${ins.rect.y}, w=${ins.rect.w}, h=${ins.rect.h}, r=${ins.rect.radius}, layer ${ins.rect.layer}`;
    case 'SET_PALETTE':return `layer ${ins.layer} = ${ins.color}`;
    case 'HALT':return 'stop';
    default:return '';
  }
}
function inspect(){
  if(!result)return;
  const f=result.frames[selectedY];
  $('rowstats').textContent=`row ${selectedY} · ${f.events} X edges · ${f.edits} Y edits`;
  $('xrow').textContent=selectedY;
  $('y-count').textContent=result.program.length;
  $('x-count').textContent=f.edges.length;
  $('palette-row').textContent=selectedY;
  const layers=paletteView(f,scene.palette,LAYERS);
  $('palette-count').textContent=layers.length;
  $('palette-grid').innerHTML=layers.map(entry=>
    `<div class="palette-entry ${entry.visible?'palette-visible':''} ${entry.overridden?'palette-overridden':''}" title="Layer ${entry.layer}: ${escape(entry.color)}${entry.visible?' · visible on this row':' · occluded on this row'}${entry.overridden?' · changed by Y program':''}">
      <span class="palette-swatch" style="background-color:${escape(entry.color)}"></span>
      <span class="palette-index">${String(entry.layer).padStart(2,'0')}</span>
      <code class="palette-color">${escape(entry.color)}</code>
      ${entry.overridden?'<span class="palette-change" aria-label="Y palette override">●</span>':''}
    </div>`
  ).join('') || '<div class="empty">No participating layers.</div>';
  $('x-program').innerHTML=f.edges.length?f.edges.map(e=>`<div class="event"><code>x=${String(e.x).padStart(3,'0')}</code><div>${e.delta>0?'START':'STOP'} <strong>layer ${e.layer}</strong><small>shape ${e.shape}</small></div></div>`).join(''):'<div class="empty">Empty X list.</div>';
  // The highlighted PC is the actual VM instruction pointer after executing
  // everything due for this scanline (usually the next WAIT_Y).
  $('y-program').innerHTML=result.program.map((ins,pc)=>{
    const active=pc===f.pc;
    const executed=pc<f.pc;
    return `<div class="event y-instruction ${active?'current':''} ${executed?'executed':''}" data-program-pc="${pc}"><code>${String(pc).padStart(3,'0')} ${ins.op}</code><div>${escape(formatY(ins))}${active?'<small>← next instruction</small>':''}</div></div>`;
  }).join('');
  const current=$('y-program').querySelector('.current');
  if(current)current.scrollIntoView({block:'nearest'});
}

function numberField(s,k){
  if(k==='radius'){
    const value=Array.isArray(s.radius)?s.radius.join(' '):s.radius??0;
    return `<label title="CSS order: top-left top-right bottom-right bottom-left">radius<input type="text" data-id="${s.id}" data-key="radius" value="${value}" title="One to four radii in CSS order"></label>`;
  }
  return `<label>${k}<input type="number" data-id="${s.id}" data-key="${k}" value="${s[k]}" step="1"></label>`;
}
function renderScene(){
  $('shapes').innerHTML=scene.shapes.map(s=>`<div class="shape-row">${['x','y','w','h','radius'].map(k=>numberField(s,k)).join('')}<label>layer<input type="number" min="1" max="63" data-id="${s.id}" data-key="layer" value="${s.layer}"></label><button data-remove="${s.id}" title="Remove shape">×</button></div>`).join('');
  $('paletteEvents').innerHTML=scene.paletteEvents.map((p,i)=>`<div class="palette-row"><label>Y<input type="number" data-event="${i}" data-key="y" value="${p.y}"></label><label>layer<input type="number" data-event="${i}" data-key="layer" value="${p.layer}"></label><label>color<input type="color" data-event="${i}" data-key="color" value="${p.color}"></label><button data-remove-event="${i}">×</button></div>`).join('');
}
function changeY(y){selectedY=Math.max(0,Math.min(HEIGHT-1,y));draw();inspect();}
$('backend').addEventListener('change',build);
$('scanline').addEventListener('input',e=>changeY(+e.target.value));$('prev').onclick=()=>changeY(selectedY-1);$('next').onclick=()=>changeY(selectedY+1);
$('play').onclick=()=>{playing=!playing;$('play').textContent=playing?'❚❚ Pause':'▶ Play';if(timer)clearInterval(timer);if(playing)timer=setInterval(()=>changeY((selectedY+1)%HEIGHT),65);};
$('reset').onclick=()=>{scene=demoScene();build();};$('add').onclick=()=>{const id=Math.max(0,...scene.shapes.map(s=>s.id))+1;scene.shapes.push({id,x:280,y:180,w:240,h:150,radius:30,layer:Math.min(63,id)});scene.palette[Math.min(63,id)]='#a9c9ee';build();};
$('addPalette').onclick=()=>{scene.paletteEvents.push({y:300,layer:3,color:'#d64e78'});build();};
$('shapes').addEventListener('change',e=>{const t=e.target;if(t.dataset.id){const s=scene.shapes.find(s=>s.id===+t.dataset.id);s[t.dataset.key]=t.dataset.key==='radius'?(()=>{const values=t.value.trim().split(/[\s,]+/).filter(Boolean).slice(0,4).map(v=>Math.max(0,Math.round(Number(v)||0)));return values.length===1?values[0]:values.length?values:0;})():+t.value;if(t.dataset.key==='layer')s.layer=Math.max(1,Math.min(63,s.layer));build();}});
$('shapes').addEventListener('click',e=>{const id=e.target.dataset.remove;if(id){scene.shapes=scene.shapes.filter(s=>s.id!==+id);build();}});
$('paletteEvents').addEventListener('change',e=>{const t=e.target;if(t.dataset.event!==undefined){scene.paletteEvents[+t.dataset.event][t.dataset.key]=t.dataset.key==='color'?t.value:+t.value;build();}});
$('paletteEvents').addEventListener('click',e=>{const i=e.target.dataset.removeEvent;if(i!==undefined){scene.paletteEvents.splice(+i,1);build();}});
$('y-program').addEventListener('click',e=>{const item=e.target.closest('[data-program-pc]');if(!item)return;const pc=+item.dataset.programPc;const ins=result.program[pc];if(ins.op==='WAIT_Y')changeY(Math.min(HEIGHT-1,ins.y));});
loadBackends();
build();
