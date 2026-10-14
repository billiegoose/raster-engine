/* 640x480 VGA scene data and viewport constants; safe to import in the browser.
   The original artwork is doubled uniformly and centered vertically (+40 px). */
export const WIDTH=640, HEIGHT=480, LAYERS=64;
export const initialPalette=()=>Array.from({length:LAYERS},(_,i)=>i===0?'#101827':'#ffffff');
export const demoScene=()=>({
  palette:Object.assign(initialPalette(),{
    1:'#0f6b78',  // desktop teal
    2:'#4b4b4b',  // drop shadow
    3:'#c3c7cb',  // window chrome
    4:'#0a5cc8',  // blue title bar
    5:'#e8e8e8',  // menus and toolbars
    6:'#ffffff',  // drawing paper
    7:'#000000',  // outlines / black swatch / menu text
    8:'#86c9ff',  // sky
    9:'#64b44e',  // grass
    10:'#ffd84a', // sun
    11:'#8c6239', // house walls
    12:'#d84a3a', // red roof
    13:'#73512f', // tree trunk
    14:'#2e8b57', // tree canopy
    15:'#7f7f7f', // door
    16:'#b7b7b7', // UI buttons / icons
    17:'#b9e6ff', // windows
    18:'#ffffff', // clouds
    19:'#ff5f57', // macOS close
    20:'#febc2e', // macOS minimize
    21:'#28c840'  // macOS maximize
  }),
  shapes:[
    // Desktop, shadow, and Paint-style application window.
    {id:1,x:0,y:0,w:640,h:480,radius:0,layer:1},
    {id:2,x:44,y:68,w:552,h:340,radius:20,layer:2},
    {id:3,x:36,y:60,w:552,h:340,radius:20,layer:3},
    {id:4,x:40,y:64,w:544,h:32,radius:[16,16,0,0],layer:4},
    {id:5,x:40,y:100,w:544,h:20,radius:0,layer:5},
    // Left sidebar and bottom status / palette strip.
    {id:6,x:40,y:124,w:52,h:244,radius:0,layer:5},
    {id:7,x:40,y:372,w:544,h:24,radius:[0,0,16,16],layer:5},
    // Paper, sky, grass, sun and clouds.
    {id:8,x:94,y:124,w:490,h:244,radius:0,layer:7},
    {id:9,x:96,y:126,w:486,h:240,radius:0,layer:6},
    {id:10,x:98,y:128,w:482,h:108,radius:0,layer:8},
    {id:11,x:98,y:236,w:482,h:128,radius:0,layer:9},
    {id:12,x:124,y:144,w:40,h:40,radius:20,layer:10},
    {id:13,x:188,y:158,w:86,h:20,radius:10,layer:18},
    {id:14,x:208,y:148,w:48,h:32,radius:16,layer:18},
    // Little house: walls and roof in front of the grass.
    {id:15,x:264,y:224,w:112,h:68,radius:0,layer:11},
    {id:16,x:252,y:204,w:136,h:24,radius:4,layer:12},
    {id:17,x:306,y:252,w:28,h:40,radius:0,layer:15},
    {id:18,x:280,y:240,w:20,h:20,radius:0,layer:17},
    {id:19,x:342,y:240,w:20,h:20,radius:0,layer:17},
    // Tree: canopy in front of the trunk.
    {id:20,x:428,y:240,w:20,h:48,radius:0,layer:13},
    {id:21,x:396,y:200,w:84,h:56,radius:28,layer:14},
    // macOS-style traffic lights flush left in the title bar.
    {id:22,x:48,y:68,w:24,h:24,radius:12,layer:19},
    {id:23,x:80,y:68,w:24,h:24,radius:12,layer:20},
    {id:24,x:112,y:68,w:24,h:24,radius:12,layer:21},
    // Menu strip: File / Edit / View / Image / Help as tiny dark rectangles.
    {id:25,x:56,y:106,w:24,h:8,radius:0,layer:7},
    {id:26,x:96,y:106,w:24,h:8,radius:0,layer:7},
    {id:27,x:136,y:106,w:24,h:8,radius:0,layer:7},
    {id:28,x:176,y:106,w:32,h:8,radius:0,layer:7},
    {id:29,x:224,y:106,w:24,h:8,radius:0,layer:7},
    // Left sidebar toolbar as a two-column button grid.
    {id:30,x:48,y:136,w:16,h:16,radius:4,layer:16},
    {id:31,x:70,y:136,w:16,h:16,radius:4,layer:16},
    {id:32,x:48,y:162,w:16,h:16,radius:4,layer:16},
    {id:33,x:70,y:162,w:16,h:16,radius:4,layer:16},
    {id:34,x:48,y:188,w:16,h:16,radius:4,layer:16},
    {id:35,x:70,y:188,w:16,h:16,radius:4,layer:16},
    {id:36,x:48,y:214,w:16,h:16,radius:4,layer:16},
    {id:37,x:70,y:214,w:16,h:16,radius:4,layer:16},
    {id:38,x:48,y:240,w:16,h:16,radius:4,layer:16},
    {id:39,x:70,y:240,w:16,h:16,radius:4,layer:16},
    {id:40,x:48,y:266,w:16,h:16,radius:4,layer:16},
    {id:41,x:70,y:266,w:16,h:16,radius:4,layer:16},
    // Color palette in the bottom strip.
    {id:42,x:108,y:374,w:24,h:20,radius:0,layer:7},
    {id:43,x:136,y:374,w:24,h:20,radius:0,layer:12},
    {id:44,x:164,y:374,w:24,h:20,radius:0,layer:8},
    {id:45,x:192,y:374,w:24,h:20,radius:0,layer:9},
    {id:46,x:220,y:374,w:24,h:20,radius:0,layer:10}
  ],
  paletteEvents:[]
});
