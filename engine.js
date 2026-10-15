/* Two-stage raster machine.
   A compact Y-program schedules rounded rectangles and palette changes.
   The Y VM executes those instructions, maintains active rounded-rectangle
   generators, and materializes an X linked list for the current scanline. */
import {WIDTH,HEIGHT,LAYERS,initialPalette,demoScene} from './scene.js';
export {WIDTH,HEIGHT,LAYERS,initialPalette,demoScene} from './scene.js';

const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
const edgeOrder=(a,b)=>a.x-b.x||a.layer-b.layer||a.delta-b.delta||a.key.localeCompare(b.key);
const insetCache=new Map([[0,[]]]);

// CSS border-radius shorthand: one value for all corners, or
// [top-left, top-right, bottom-right, bottom-left]. Two- and
// three-value forms follow the same expansion rules as CSS.
function expandRadii(radius){
  const parts=Array.isArray(radius)?radius:typeof radius==='string'
    ?radius.trim().split(/[\s,]+/).filter(Boolean):[radius??0];
  const values=parts.map(v=>Math.max(0,Math.round(Number(v)||0)));
  if(values.length===0)return [0,0,0,0];
  if(values.length===1)return [values[0],values[0],values[0],values[0]];
  if(values.length===2)return [values[0],values[1],values[0],values[1]];
  if(values.length===3)return [values[0],values[1],values[2],values[1]];
  return values.slice(0,4);
}

function normalizeRect(shape){
  const x=Math.round(Number(shape.x)||0);
  const y=Math.round(Number(shape.y)||0);
  const w=Math.max(0,Math.round(Number(shape.w)||0));
  const h=Math.max(0,Math.round(Number(shape.h)||0));
  const layer=clamp(Math.round(Number(shape.layer)||0),1,LAYERS-1);
  const radius=shape.radius??0;
  const corners=expandRadii(radius);
  const [tl,tr,br,bl]=corners;
  // CSS corner-overlap rule: proportionally reduce radii when adjacent
  // corners would overlap. Floor to retain integer-only circle stepping.
  let scale=1;
  for(const [sum,limit] of [[tl+tr,w],[bl+br,w],[tl+bl,h],[tr+br,h]]){
    if(sum>0)scale=Math.min(scale,limit/sum);
  }
  const radii=corners.map(r=>Math.floor(r*scale));
  return {id:shape.id,x,y,w,h,radius,radii,layer};
}

/* Generate the top quarter-circle using an incremental integer error.
   All positions are measured at pixel centers, doubled to avoid fractions.
   The next candidate pixel is inside when X² + Y² - (2r)² <= 0.
   Moving a pixel right changes the error by 4X+4; moving one row down
   changes it by -4Y+4. No square roots, division, or multiplication. */
export function circleInsets(radius){
  radius=Math.max(0,Math.floor(radius));
  if(insetCache.has(radius))return insetCache.get(radius);
  const insets=[];
  let inset=radius;
  let X=1, Y=2*radius-1;
  let error=2-4*radius;
  for(let row=0;row<radius;row++){
    while(inset>0&&error<=0){
      inset--;
      error+=4*X+4;
      X+=2;
    }
    insets.push(inset);
    error+=-4*Y+4;
    Y-=2;
  }
  insetCache.set(radius,insets);
  return insets;
}

function spanForRect(rect,y){
  if(y<rect.y||y>=rect.y+rect.h||rect.w<=0||rect.h<=0)return null;
  const [tl,tr,br,bl]=rect.radii;
  const localY=y-rect.y;
  let leftInset=0,rightInset=0;
  if(localY<tl)leftInset=circleInsets(tl)[localY];
  else if(localY>=rect.h-bl)leftInset=circleInsets(bl)[rect.h-1-localY];
  if(localY<tr)rightInset=circleInsets(tr)[localY];
  else if(localY>=rect.h-br)rightInset=circleInsets(br)[rect.h-1-localY];
  return [rect.x+leftInset,rect.x+rect.w-rightInset];
}

function createEdge(rect,kind,x){
  return {key:`${rect.id}:${kind}`,x,layer:rect.layer,delta:kind==='start'?1:-1,shape:rect.id,next:null};
}

function listArray(head){
  const result=[];let node=head.next,guard=0;
  while(node){
    if(++guard>100000)throw Error('X linked-list cycle');
    const {next,...edge}=node;result.push(edge);node=next;
  }
  return result;
}

function relink(machine){
  const sorted=[...machine.nodes.values()].sort(edgeOrder);
  let tail=machine.head;
  for(const node of sorted){tail.next=node;tail=node;}
  tail.next=null;
}

function syncRectNode(machine,key,edge,changes){
  const existing=machine.nodes.get(key);
  if(!existing){
    machine.nodes.set(key,{...edge,next:null});
    changes.push({op:'INSERT',key,x:edge.x,layer:edge.layer,shape:edge.shape});
    return;
  }
  if(existing.x!==edge.x||existing.layer!==edge.layer||existing.delta!==edge.delta){
    changes.push({op:'MOVE',key,from:existing.x,to:edge.x,layer:edge.layer,shape:edge.shape});
    existing.x=edge.x;existing.layer=edge.layer;existing.delta=edge.delta;existing.shape=edge.shape;
  }
}

function deleteNode(machine,key,changes){
  const node=machine.nodes.get(key);
  if(!node)return;
  changes.push({op:'DELETE',key,x:node.x,layer:node.layer,shape:node.shape});
  machine.nodes.delete(key);
}

function syncActiveRects(machine,y){
  const changes=[];
  const finished=[];
  for(const rect of machine.activeRects.values()){
    const startKey=`${rect.id}:start`, stopKey=`${rect.id}:stop`;
    if(y<rect.y||y>=rect.y+rect.h){
      deleteNode(machine,startKey,changes);
      deleteNode(machine,stopKey,changes);
      if(y>=rect.y+rect.h)finished.push(rect.id);
      continue;
    }
    const span=spanForRect(rect,y);
    if(!span){
      deleteNode(machine,startKey,changes);
      deleteNode(machine,stopKey,changes);
      continue;
    }
    const [leftRaw,rightRaw]=span;
    const left=clamp(Math.round(leftRaw),0,WIDTH);
    const right=clamp(Math.round(rightRaw),0,WIDTH);
    if(right<=left){
      deleteNode(machine,startKey,changes);
      deleteNode(machine,stopKey,changes);
      continue;
    }
    syncRectNode(machine,startKey,createEdge(rect,'start',left),changes);
    syncRectNode(machine,stopKey,createEdge(rect,'stop',right),changes);
  }
  for(const id of finished)machine.activeRects.delete(id);
  relink(machine);
  return changes;
}

function renderRow(head){
  const counts=new Int32Array(LAYERS),row=new Uint8Array(WIDTH);
  let node=head.next,events=0,top=0;
  for(let x=0;x<WIDTH;x++){
    // Only X transitions can change the highest active layer. Recompute
    // compositing priority at those positions instead of 1280 times per row.
    if(node&&node.x<=x){
      while(node&&node.x<=x){
        const l=node.layer;
        if(!Number.isInteger(l)||l<1||l>=LAYERS)throw Error(`Invalid paint layer ${l}`);
        counts[l]+=node.delta;
        if(counts[l]<0)throw Error(`Unbalanced STOP at x=${x} layer=${l}`);
        node=node.next;events++;
      }
      top=0;
      for(let l=LAYERS-1;l>0;l--)if(counts[l]>0){top=l;break;}
    }
    row[x]=top;
  }
  while(node&&node.x===WIDTH){
    const l=node.layer;
    if(!Number.isInteger(l)||l<1||l>=LAYERS)throw Error(`Invalid paint layer ${l}`);
    counts[l]+=node.delta;
    if(counts[l]<0)throw Error(`Unbalanced STOP at x=${WIDTH} layer=${l}`);
    node=node.next;events++;
  }
  if(node)throw Error('X instruction beyond screen');
  for(let l=1;l<LAYERS;l++)if(counts[l]!==0)throw Error(`Unbalanced layer ${l}`);
  return {row,events};
}

export function compileY(scene){
  const buckets=new Map();
  function push(y,instruction){
    if(y<0||y>=HEIGHT)return;
    if(!buckets.has(y))buckets.set(y,[]);
    buckets.get(y).push(instruction);
  }
  for(const shape of scene.shapes||[]){
    const rect=normalizeRect(shape);
    if(rect.w<=0||rect.h<=0)continue;
    push(rect.y,{op:'ROUND_RECT',rect});
  }
  for(const event of scene.paletteEvents||[]){
    const y=Math.round(Number(event.y)||0);
    const layer=Math.round(Number(event.layer)||0);
    if(y<0||y>=HEIGHT||layer<0||layer>=LAYERS)continue;
    push(y,{op:'SET_PALETTE',layer,color:event.color});
  }
  const ys=[...buckets.keys()].sort((a,b)=>a-b);
  const program=[];
  for(const y of ys){
    program.push({op:'WAIT_Y',y});
    const instructions=buckets.get(y).slice().sort((a,b)=>{
      if(a.op!==b.op)return a.op.localeCompare(b.op);
      if(a.op==='ROUND_RECT')return a.rect.id-b.rect.id;
      return a.layer-b.layer;
    });
    program.push(...instructions);
  }
  program.push({op:'WAIT_Y',y:HEIGHT});
  program.push({op:'HALT'});
  return program;
}

function makeMachine(scene,program){
  return {
    head:{key:'HEAD',next:null},
    nodes:new Map(),
    activeRects:new Map(),
    palette:[...scene.palette],
    program,
    pc:0,
    y:0,
    halted:false
  };
}

function execute(machine,ins){
  switch(ins.op){
    case 'ROUND_RECT':{
      const rect=normalizeRect(ins.rect);
      if(machine.activeRects.has(rect.id))throw Error(`Duplicate rounded rectangle ${rect.id}`);
      machine.activeRects.set(rect.id,rect);
      break;
    }
    case 'SET_PALETTE':{
      if(!Number.isInteger(ins.layer)||ins.layer<0||ins.layer>=LAYERS)throw Error(`Invalid palette layer ${ins.layer}`);
      machine.palette[ins.layer]=ins.color;
      break;
    }
    default:
      throw Error(`Unknown Y opcode ${ins.op}`);
  }
}

/* Execute all Y bytecode scheduled for this scanline, then materialize X. */
export function advanceY(machine,y){
  if(y<machine.y)throw Error('Y machine cannot rewind');
  machine.y=y;
  const executed=[];
  while(machine.pc<machine.program.length){
    const ins=machine.program[machine.pc];
    if(ins.op==='WAIT_Y'){
      if(ins.y>y)break;
      executed.push({pc:machine.pc,ins});
      machine.pc++;
      continue;
    }
    if(ins.op==='HALT'){
      machine.halted=true;
      break;
    }
    execute(machine,ins);
    executed.push({pc:machine.pc,ins});
    machine.pc++;
  }
  const changes=syncActiveRects(machine,y);
  return {executed,changes,pc:machine.pc};
}

export function runYProgram(scene,program){
  const machine=makeMachine(scene,program),scanlines=[],logs=[];
  let totalEdits=0,totalEvents=0;
  for(let y=0;y<HEIGHT;y++){
    const {executed,changes,pc}=advanceY(machine,y);
    const edges=listArray(machine.head);
    const {row,events}=renderRow(machine.head);
    totalEdits+=changes.length;
    totalEvents+=events;
    scanlines.push({y,row,edges,palette:[...machine.palette],events,edits:changes.length,executed,changes,pc});
    logs.push({y,events,edits:changes.length});
  }
  return {program,scanlines,logs,totalEvents,totalEdits};
}

export function compile(scene){return runYProgram(scene,compileY(scene));}
export const rasterize=compile;

export function referenceRow(scene,y){
  const row=new Uint8Array(WIDTH);
  // Normalize geometry once per shape per row, not once per pixel. This is
  // important for the larger VGA reference image while remaining independent
  // of the X-list interpreter and its palette reference-count machinery.
  for(const raw of scene.shapes||[]){
    const rect=normalizeRect(raw);
    const span=spanForRect(rect,y);
    if(!span)continue;
    const left=clamp(Math.round(span[0]),0,WIDTH);
    const right=clamp(Math.round(span[1]),0,WIDTH);
    for(let x=left;x<right;x++)row[x]=Math.max(row[x],rect.layer);
  }
  return row;
}
