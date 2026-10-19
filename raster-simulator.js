/* Raster simulator. Runs a selected reference backend and inspects the exact
   Y/X execution trace. Does not mutate scene objects or implement editing. */
import {LAYERS,canvasSize} from './scene.js';
import {paletteView} from './palette-view.js';
import {compileScene} from './scene-model.js';

const $=id=>document.getElementById(id);
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));

function formatY(ins){
  switch(ins.op){
    case 'WAIT_Y':return `y = ${ins.y}`;
    case 'ROUND_RECT':return `shape ${ins.rect.id}: x=${ins.rect.x}, y=${ins.rect.y}, w=${ins.rect.w}, h=${ins.rect.h}, r=${JSON.stringify(ins.rect.radius)}, layer ${ins.rect.layer}`;
    case 'TEXT':return `text ${ins.text.id}: buffer ${ins.text.buffer_ptr}, x=${ins.text.x}, y=${ins.text.y}, w=${ins.text.w}, h=${ins.text.h}, layer ${ins.text.layer}`;
    case 'SET_PALETTE':return `layer ${ins.layer} = ${ins.color}`;
    case 'HALT':return 'stop';
    default:return '';
  }
}

export function createRasterSimulator({getScene,onEditor}){
  const screen=$('screen'),ctx=screen.getContext('2d');
  const timeline=$('timeline'),timelineCtx=timeline.getContext('2d');
  let result=null,selectedY=330,runGeneration=0,revision=0,renderedRevision=-1;
  let playing=false,timer=null,imageData=null,timelineImage=null,loaded=false;
  const backend=$('backend');
  const width=()=>result?.width??canvasSize(getScene()).width;
  const height=()=>result?.height??canvasSize(getScene()).height;

  async function loadBackends(){
    if(loaded)return;
    try{
      const response=await fetch('/api/backends');
      if(!response.ok)throw Error(`HTTP ${response.status}`);
      const {backends}=await response.json();
      const selected=backend.value;
      backend.replaceChildren();
      for(const {id,label} of backends){
        const option=document.createElement('option');
        option.value=id;option.textContent=label;
        backend.append(option);
      }
      if(backends.some(item=>item.id===selected))backend.value=selected;
      loaded=true;
    }catch(error){console.warn('Backend discovery failed:',error);}
  }

  function markDirty(){
    revision++;
    const stale=renderedRevision!==revision;
    $('simulation-dirty').hidden=!stale;
    if(stale&&result)$('stats').textContent='Scene edited · rerun to update the raster output';
  }

  function drawRaster(){
    if(!result||!imageData)return;
    ctx.putImageData(imageData,0,0);
    ctx.fillStyle='rgba(255,255,255,.8)';
    ctx.fillRect(0,selectedY,width(),1);
    if(timelineImage)timelineCtx.putImageData(timelineImage,0,0);
    timelineCtx.fillStyle='#ffffff';
    timelineCtx.fillRect(0,Math.floor(selectedY*timeline.height/height()),timeline.width,1);
    $('yvalue').textContent=selectedY;
    $('scanline').value=String(selectedY);
  }

  function buildPixels(){
    if(!result)return;
    const {width:rasterWidth,height:rasterHeight}=result;
    const image=ctx.createImageData(rasterWidth,rasterHeight);
    const colors=new Map();
    const rgb=hex=>{
      if(!colors.has(hex)){
        const normalized=/^#[0-9a-fA-F]{6}$/.test(hex)?hex:'#101827';
        colors.set(hex,[parseInt(normalized.slice(1,3),16),parseInt(normalized.slice(3,5),16),parseInt(normalized.slice(5,7),16)]);
      }
      return colors.get(hex);
    };
    for(const scanline of result.scanlines){
      const y=scanline.y;
      if(y<0||y>=rasterHeight)continue;
      for(let x=0;x<rasterWidth;x++){
        const [r,g,b]=rgb(scanline.palette[scanline.row[x]]);
        const i=(y*rasterWidth+x)*4;
        image.data[i]=r;image.data[i+1]=g;image.data[i+2]=b;image.data[i+3]=255;
      }
    }
    imageData=image;
    const tw=timeline.width,th=timeline.height;
    const off=document.createElement('canvas');
    off.width=tw;off.height=th;
    const tctx=off.getContext('2d');
    tctx.fillStyle='#0b1420';tctx.fillRect(0,0,tw,th);
    for(const scanline of result.scanlines){
      const py=Math.floor(scanline.y*th/rasterHeight);
      for(const edge of scanline.edges){
        tctx.fillStyle=edge.op?'#cc8be6':'#6dc6d0';
        tctx.fillRect(Math.floor(edge.x*tw/rasterWidth),py,1,1);
      }
      if(scanline.edits){
        tctx.fillStyle='#efb55c';
        tctx.fillRect(0,py,Math.min(tw,scanline.edits*3),1);
      }
    }
    timelineImage=tctx.getImageData(0,0,tw,th);
  }

  function inspect(){
    if(!result)return;
    const scanline=result.scanlines[selectedY];
    if(!scanline)return;
    $('rowstats').textContent=`row ${selectedY} · ${scanline.events} X instructions · ${scanline.edits} Y edits`;
    $('xrow').textContent=selectedY;
    $('y-count').textContent=result.program.length;
    $('x-count').textContent=scanline.edges.length;
    $('palette-row').textContent=selectedY;
    const layers=paletteView(scanline,compileScene(getScene()).palette,LAYERS);
    $('palette-count').textContent=layers.length;
    $('palette-grid').innerHTML=layers.map(entry=>
      `<div class="palette-entry ${entry.visible?'palette-visible':''} ${entry.overridden?'palette-overridden':''}" title="Layer ${entry.layer}: ${escape(entry.color)}${entry.visible?' · visible':' · occluded'}${entry.overridden?' · Y palette override':''}">
         <span class="palette-swatch" style="background-color:${escape(entry.color)}"></span>
         <span class="palette-index">${String(entry.layer).padStart(2,'0')}</span>
         <code class="palette-color">${escape(entry.color)}</code>
         ${entry.overridden?'<span class="palette-change" aria-label="Y palette override">●</span>':''}
       </div>`).join('')||'<div class="empty">No participating layers.</div>';
    $('x-program').innerHTML=scanline.edges.length?scanline.edges.map(edge=>
      `<div class="event"><code>x=${String(edge.x).padStart(4,'0')}</code><div>${edge.op|| (edge.delta>0?'START':'STOP')} <strong>layer ${edge.layer}</strong><small>${edge.op?`text ${edge.shape} · buffer ${edge.buffer_ptr}`:`shape ${edge.shape}`}</small></div></div>`).join(''):'<div class="empty">Empty X list.</div>';
    $('y-program').innerHTML=result.program.map((ins,pc)=>
      `<div class="event y-instruction ${pc===scanline.pc?'current':''} ${pc<scanline.pc?'executed':''}" data-program-pc="${pc}">
        <code>${String(pc).padStart(3,'0')} ${ins.op}</code><div>${escape(formatY(ins))}${pc===scanline.pc?'<small>← next instruction</small>':''}</div>
       </div>`).join('');
    const current=$('y-program').querySelector('.current');
    if(current&&current.scrollIntoView)current.scrollIntoView({block:'nearest'});
  }

  function changeY(y){
    selectedY=clamp(Math.round(Number(y)||0),0,height()-1);
    drawRaster();inspect();
  }

  function pause(){
    playing=false;
    if(timer!==null){clearInterval(timer);timer=null;}
    $('play').textContent='▶ Play';
  }

  async function run({autoSelectPython=false}={}){
    pause();
    await loadBackends();
    const source=getScene();
    if(autoSelectPython&&source.texts?.length&&[...backend.options].some(o=>o.value==='python')){
      if(backend.value==='javascript')backend.value='python';
    }
    const generation=++runGeneration;
    const thisRevision=revision;
    const requestedBackend=backend.value;
    $('stats').textContent=`Running ${requestedBackend} backend…`;
    try{
      const response=await fetch('/api/run',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({backend:requestedBackend,scene:source})
      });
      const data=await response.json();
      if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
      if(generation!==runGeneration||thisRevision!==revision)return;
      result=data;
      screen.width=data.width;
      screen.height=data.height;
      timeline.width=data.width;
      selectedY=clamp(selectedY,0,data.height-1);
      $('scanline').max=String(data.height-1);
      renderedRevision=thisRevision;
      $('simulation-dirty').hidden=true;
      buildPixels();drawRaster();inspect();
      $('stats').textContent=`${data.backend} · ${source.shapes.length} rectangles · ${(source.texts||[]).length} text objects · ${data.totalEvents} X events · ${data.totalEdits} Y edits`;
    }catch(error){
      if(generation!==runGeneration||thisRevision!==revision)return;
      result=null;imageData=null;timelineImage=null;
      ctx.clearRect(0,0,width(),height());
      timelineCtx.clearRect(0,0,timeline.width,timeline.height);
      $('stats').textContent=`ERROR: ${error.message}`;
      $('rowstats').textContent='No simulation result';
      $('y-program').replaceChildren();
      $('x-program').replaceChildren();
      $('palette-grid').replaceChildren();
      console.error(error);
    }
  }

  async function open(){
    await loadBackends();
    if(renderedRevision!==revision || !result)await run({autoSelectPython:true});
    else {drawRaster();inspect();}
  }

  backend.addEventListener('change',()=>void run());
  $('rerun').addEventListener('click',()=>void run());
  $('scanline').addEventListener('input',event=>changeY(event.target.value));
  $('prev').addEventListener('click',()=>changeY(selectedY-1));
  $('next').addEventListener('click',()=>changeY(selectedY+1));
  $('play').addEventListener('click',()=>{
    if(playing){pause();return;}
    playing=true;
    $('play').textContent='❚❚ Pause';
    timer=setInterval(()=>changeY((selectedY+1)%height()),65);
  });
  $('back-to-editor').addEventListener('click',()=>onEditor?.());
  $('y-program').addEventListener('click',event=>{
    const el=event.target.closest('[data-program-pc]');
    if(!el||!result)return;
    const instruction=result.program[Number(el.dataset.programPc)];
    if(instruction?.op==='WAIT_Y')changeY(Math.min(height()-1,instruction.y));
  });
  void loadBackends();
  return {open,markDirty,pause,run,hasResult:()=>!!result};
}
