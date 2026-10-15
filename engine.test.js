import {test,expect} from 'bun:test';
import {WIDTH,HEIGHT,demoScene,rasterize,referenceRow,compileY,runYProgram,circleInsets} from './engine.js';

test('compiled X programs match direct geometric rasterization on every scanline',()=>{
  const scene=demoScene(),r=rasterize(scene);
  expect(r.scanlines.length).toBe(HEIGHT);
  for(let y=0;y<HEIGHT;y++)expect([...r.scanlines[y].row]).toEqual([...referenceRow(scene,y)]);
});

test('same-layer overlap retains paint until last STOP',()=>{
  const scene=demoScene();
  scene.shapes=[
    {id:1,x:10,y:10,w:100,h:40,radius:0,layer:3},
    {id:2,x:50,y:10,w:100,h:40,radius:0,layer:3}
  ];
  const r=rasterize(scene);
  expect(r.scanlines[20].row[110]).toBe(3);
  expect(r.scanlines[20].row[150]).toBe(0);
});

test('higher palette layer wins regardless of geometric insertion order',()=>{
  const scene=demoScene();
  scene.shapes=[
    {id:1,x:0,y:0,w:200,h:100,radius:0,layer:7},
    {id:2,x:50,y:0,w:200,h:100,radius:0,layer:2}
  ];
  const r=rasterize(scene);
  expect(r.scanlines[5].row[75]).toBe(7);
  expect(r.scanlines[5].row[225]).toBe(2);
});

test('palette updates apply at requested scanline',()=>{
  const scene=demoScene();
  scene.paletteEvents=[{y:120,layer:2,color:'#8958ac'}];
  const r=rasterize(scene);
  expect(r.scanlines[119].palette[2]).toBe('#4b4b4b');
  expect(r.scanlines[120].palette[2]).toBe('#8958ac');
});

test('Y program is compact and shape-oriented',()=>{
  const program=compileY(demoScene());
  expect(program.some(ins=>ins.op==='ROUND_RECT')).toBe(true);
  expect(program.some(ins=>ins.op==='INSERT'||ins.op==='MOVE'||ins.op==='DELETE')).toBe(false);
  expect(program.length).toBeLessThanOrEqual(2*demoScene().shapes.length+2);
});

test('Y program is executable independently of scene geometry',()=>{
  const scene=demoScene();
  const program=compileY(scene);
  const baseline=runYProgram(scene,program);
  const withoutShapes={...scene,shapes:[]};
  const replay=runYProgram(withoutShapes,program);
  for(let y=0;y<HEIGHT;y++)expect([...replay.scanlines[y].row]).toEqual([...baseline.scanlines[y].row]);
});

test('editing Y bytecode changes X list and pixels',()=>{
  const scene={palette:demoScene().palette,shapes:[{id:1,x:10,y:5,w:30,h:10,radius:0,layer:3}],paletteEvents:[]};
  const program=compileY(scene);
  const rect=program.find(i=>i.op==='ROUND_RECT');
  expect(rect).toBeDefined();
  rect.rect.x=20;
  const result=runYProgram({...scene,shapes:[]},program);
  expect(result.scanlines[5].row[15]).toBe(0);
  expect(result.scanlines[5].row[25]).toBe(3);
  expect(result.scanlines[5].edges[0].x).toBe(20);
});

test('Y program waits until scheduled scanline to mutate X list',()=>{
  const scene={palette:demoScene().palette,shapes:[{id:1,x:10,y:5,w:30,h:10,radius:0,layer:3}],paletteEvents:[]};
  const result=runYProgram(scene,compileY(scene));
  expect(result.scanlines[4].edges).toHaveLength(0);
  expect(result.scanlines[5].edges).toHaveLength(2);
  expect(result.scanlines[15].edges).toHaveLength(0);
  expect(result.scanlines[5].executed.some(e=>e.ins.op==='ROUND_RECT')).toBe(true);
});

test('zero radius yields a sharp rectangle on every occupied row',()=>{
  const scene={...demoScene(),shapes:[{id:1,x:20,y:30,w:80,h:40,radius:0,layer:4}],paletteEvents:[]};
  const result=rasterize(scene);
  for(const y of [30,31,49,68,69])expect(result.scanlines[y].edges.map(e=>e.x)).toEqual([20,100]);
  expect(result.scanlines[29].edges).toHaveLength(0);
  expect(result.scanlines[70].edges).toHaveLength(0);
});

test('rounded rectangle corners follow a circle rather than an ellipse',()=>{
  const scene={...demoScene(),shapes:[{id:1,x:10,y:20,w:100,h:40,radius:10,layer:3}],paletteEvents:[]};
  const result=rasterize(scene);
  const inset=dy=>{
    let blank=10;
    while(blank>0){
      const candidate=blank-1;
      const dx=10-candidate-0.5;
      if(dx*dx + dy*dy <= 100) blank=candidate;
      else break;
    }
    return blank;
  };
  expect(result.scanlines[20].edges.map(e=>e.x)).toEqual([10+inset(9.5),110-inset(9.5)]);
  expect(result.scanlines[25].edges.map(e=>e.x)).toEqual([10+inset(4.5),110-inset(4.5)]);
  expect(result.scanlines[30].edges.map(e=>e.x)).toEqual([10,110]);
  expect(result.scanlines[59].edges.map(e=>e.x)).toEqual(result.scanlines[20].edges.map(e=>e.x));
});

test('corner radius is clamped to half the smaller dimension',()=>{
  const make=radius=>({...demoScene(),shapes:[{id:1,x:15,y:25,w:120,h:30,radius,layer:2}],paletteEvents:[]});
  const clamped=rasterize(make(15)),oversized=rasterize(make(500));
  for(let y=25;y<55;y++)expect(oversized.scanlines[y].edges.map(e=>e.x)).toEqual(clamped.scanlines[y].edges.map(e=>e.x));
});

test('rounded corners use symmetric coverage',()=>{
  const scene={...demoScene(),shapes:[{id:1,x:35,y:35,w:250,h:38,radius:12,layer:2}],paletteEvents:[]};
  const result=rasterize(scene);
  for(let y=35;y<73;y++){
    const row=result.scanlines[y].row;
    for(let dx=0;dx<125;dx++)expect(row[35+dx]).toBe(row[284-dx]);
  }
});

test('incremental integer arcs match exact circle coverage for radii 1–128',()=>{
  for(let radius=1;radius<=128;radius++){
    const actual=circleInsets(radius);
    expect(actual).toHaveLength(radius);
    for(let row=0;row<radius;row++){
      let expected=radius;
      const dy=radius-row-.5;
      while(expected>0){
        const dx=radius-(expected-1)-.5;
        if(dx*dx+dy*dy<=radius*radius)expected--;
        else break;
      }
      expect(actual[row]).toBe(expected);
      if(row>0)expect(actual[row]).toBeLessThanOrEqual(actual[row-1]);
    }
  }
});

test('default Paint scene preserves foregrounds, background, and palette',()=>{
  const r=rasterize(demoScene());
  expect(r.scanlines[15].row[175]).toBe(1); // desktop
  expect(r.scanlines[117].row[388]).toBe(4); // title bar background to the right of traffic lights
  expect(r.scanlines[192].row[325]).toBe(8); // sky
  expect(r.scanlines[387].row[595]).toBe(11); // house in front of grass
  expect(r.scanlines[342].row[805]).toBe(14); // canopy in front of sky
  expect(r.scanlines[552].row[379]).toBe(12); // color palette in status strip
});

test('default Paint scene uses macOS traffic lights, menu items, and a two-column sidebar toolbar',()=>{
  const r=rasterize(demoScene());
  expect(r.scanlines[111].row[250]).toBe(19); // red close button flush left
  expect(r.scanlines[111].row[286]).toBe(20); // yellow minimize button
  expect(r.scanlines[111].row[322]).toBe(21); // green maximize button
  expect(r.scanlines[147].row[250]).toBe(7);  // File menu block
  expect(r.scanlines[147].row[316]).toBe(7);  // Edit menu block
  expect(r.scanlines[147].row[445]).toBe(7);  // Image menu block
  expect(r.scanlines[198].row[241]).toBe(16); // left toolbar button column 1
  expect(r.scanlines[198].row[274]).toBe(16); // left toolbar button column 2
  expect(r.scanlines[210].row[259]).toBe(5);  // gap between columns remains sidebar bg
});

test('each corner has an independent circular radius',()=>{
  const scene={...demoScene(),shapes:[{id:1,x:40,y:20,w:100,h:60,radius:[12,4,8,0],layer:3}],paletteEvents:[]};
  const scanlines=rasterize(scene).scanlines;
  const first=scanlines[20].edges.map(e=>e.x);
  const middle=scanlines[50].edges.map(e=>e.x);
  const last=scanlines[79].edges.map(e=>e.x);
  expect(first[0]).toBeGreaterThan(40);
  expect(first[1]).toBeLessThan(140);
  expect(first[0]-40).toBeGreaterThan(140-first[1]);
  expect(middle).toEqual([40,140]);
  expect(last[0]).toBe(40);
  expect(last[1]).toBeLessThan(140);
});

test('CSS radius normalization prevents adjacent corners overlapping',()=>{
  const make=radius=>({...demoScene(),shapes:[{id:1,x:40,y:20,w:40,h:20,radius,layer:3}],paletteEvents:[]});
  const oversized=rasterize(make([50,50,50,50]));
  const clamped=rasterize(make(10));
  for(let y=20;y<40;y++)expect(oversized.scanlines[y].edges.map(e=>e.x)).toEqual(clamped.scanlines[y].edges.map(e=>e.x));
});

test('the window title has square bottom corners and the status strip fits rounded bottom corners',()=>{
  const scanlines=rasterize(demoScene()).scanlines;
  expect(scanlines[123].row[220]).toBe(4); // title bar remains square at bottom-left
  expect(scanlines[540].row[220]).toBe(5); // status strip starts square
  expect(scanlines[573].row[220]).not.toBe(5); // bottom strip no longer spills past window shell
  expect(scanlines[573].row[295]).toBe(5); // middle of status strip remains filled
});

test('1280x720 demo fills the HD frame and preserves circular scaled geometry',()=>{
  const scene=demoScene();
  expect([WIDTH,HEIGHT]).toEqual([1280,720]);
  const background=scene.shapes.find(s=>s.id===1);
  expect([background.x,background.y,background.w,background.h]).toEqual([0,0,1280,720]);
  const window=scene.shapes.find(s=>s.id===3);
  expect([window.x,window.y,window.w,window.h,window.radius]).toEqual([214,90,828,492,18]);
  const title=scene.shapes.find(s=>s.id===4);
  expect(title.radius).toEqual([14,14,0,0]);
});

test('720p window has subtle corners and compact traffic lights',()=>{
  const shapes=new Map(demoScene().shapes.map(shape=>[shape.id,shape]));
  expect(shapes.get(2).radius).toBe(18);
  expect(shapes.get(3).radius).toBe(18);
  expect(shapes.get(4).radius).toEqual([14,14,0,0]);
  expect(shapes.get(7).radius).toEqual([0,0,14,14]);
  for(const [id,x,layer] of [[22,241,19],[23,277,20],[24,313,21]]){
    const button=shapes.get(id);
    expect([button.x,button.y,button.w,button.h,button.radius,button.layer]).toEqual([x,102,18,18,9,layer]);
  }
  const scanlines=rasterize(demoScene()).scanlines;
  expect(scanlines[111].row[250]).toBe(19);
  expect(scanlines[111].row[286]).toBe(20);
  expect(scanlines[111].row[322]).toBe(21);
  expect(scanlines[111].row[268]).toBe(4); // title bar between the smaller buttons
});

test('the title bar matches the menu height and traffic lights are vertically centered',()=>{
  const shapes=new Map(demoScene().shapes.map(s=>[s.id,s]));
  const title=shapes.get(4),menu=shapes.get(5);
  expect(title.h).toBe(30);
  expect(title.h).toBe(menu.h);
  expect(menu.y).toBe(title.y+title.h+6);
  expect(shapes.get(6).y).toBe(menu.y+menu.h+6);
  for(const id of [22,23,24]){
    const button=shapes.get(id);
    expect(button.y+button.h/2).toBe(title.y+title.h/2);
    expect(title.h-button.h).toBe(12); // 6px of breathing room above and below
  }
  expect(shapes.get(3).h).toBe(492);
  expect(shapes.get(7).y+shapes.get(7).h+6).toBe(shapes.get(3).y+shapes.get(3).h);
});
