/* 1280x720 HD scene data and viewport constants; safe to import in the browser.
   The previous 640x480 scene is scaled uniformly by 3/2 and centered
   horizontally (+160 px), preserving square pixels and circular corners. */
export const WIDTH=1280, HEIGHT=720, LAYERS=64;
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
    {id:1,x:0,y:0,w:1280,h:720,radius:0,layer:1},
    {id:2,x:226,y:102,w:828,h:510,radius:30,layer:2},
    {id:3,x:214,y:90,w:828,h:510,radius:30,layer:3},
    {id:4,x:220,y:96,w:816,h:48,radius:[24,24,0,0],layer:4},
    {id:5,x:220,y:150,w:816,h:30,radius:0,layer:5},
    // Left sidebar and bottom status / palette strip.
    {id:6,x:220,y:186,w:78,h:366,radius:0,layer:5},
    {id:7,x:220,y:558,w:816,h:36,radius:[0,0,24,24],layer:5},
    // Paper, sky, grass, sun and clouds.
    {id:8,x:301,y:186,w:735,h:366,radius:0,layer:7},
    {id:9,x:304,y:189,w:729,h:360,radius:0,layer:6},
    {id:10,x:307,y:192,w:723,h:162,radius:0,layer:8},
    {id:11,x:307,y:354,w:723,h:192,radius:0,layer:9},
    {id:12,x:346,y:216,w:60,h:60,radius:30,layer:10},
    {id:13,x:442,y:237,w:129,h:30,radius:15,layer:18},
    {id:14,x:472,y:222,w:72,h:48,radius:24,layer:18},
    // Little house: walls and roof in front of the grass.
    {id:15,x:556,y:336,w:168,h:102,radius:0,layer:11},
    {id:16,x:538,y:306,w:204,h:36,radius:6,layer:12},
    {id:17,x:619,y:378,w:42,h:60,radius:0,layer:15},
    {id:18,x:580,y:360,w:30,h:30,radius:0,layer:17},
    {id:19,x:673,y:360,w:30,h:30,radius:0,layer:17},
    // Tree: canopy in front of the trunk.
    {id:20,x:802,y:360,w:30,h:72,radius:0,layer:13},
    {id:21,x:754,y:300,w:126,h:84,radius:42,layer:14},
    // macOS-style traffic lights flush left in the title bar.
    {id:22,x:232,y:102,w:36,h:36,radius:18,layer:19},
    {id:23,x:280,y:102,w:36,h:36,radius:18,layer:20},
    {id:24,x:328,y:102,w:36,h:36,radius:18,layer:21},
    // Menu strip: File / Edit / View / Image / Help as tiny dark rectangles.
    {id:25,x:244,y:159,w:36,h:12,radius:0,layer:7},
    {id:26,x:304,y:159,w:36,h:12,radius:0,layer:7},
    {id:27,x:364,y:159,w:36,h:12,radius:0,layer:7},
    {id:28,x:424,y:159,w:48,h:12,radius:0,layer:7},
    {id:29,x:496,y:159,w:36,h:12,radius:0,layer:7},
    // Left sidebar toolbar as a two-column button grid.
    {id:30,x:232,y:204,w:24,h:24,radius:6,layer:16},
    {id:31,x:265,y:204,w:24,h:24,radius:6,layer:16},
    {id:32,x:232,y:243,w:24,h:24,radius:6,layer:16},
    {id:33,x:265,y:243,w:24,h:24,radius:6,layer:16},
    {id:34,x:232,y:282,w:24,h:24,radius:6,layer:16},
    {id:35,x:265,y:282,w:24,h:24,radius:6,layer:16},
    {id:36,x:232,y:321,w:24,h:24,radius:6,layer:16},
    {id:37,x:265,y:321,w:24,h:24,radius:6,layer:16},
    {id:38,x:232,y:360,w:24,h:24,radius:6,layer:16},
    {id:39,x:265,y:360,w:24,h:24,radius:6,layer:16},
    {id:40,x:232,y:399,w:24,h:24,radius:6,layer:16},
    {id:41,x:265,y:399,w:24,h:24,radius:6,layer:16},
    // Color palette in the bottom strip.
    {id:42,x:322,y:561,w:36,h:30,radius:0,layer:7},
    {id:43,x:364,y:561,w:36,h:30,radius:0,layer:12},
    {id:44,x:406,y:561,w:36,h:30,radius:0,layer:8},
    {id:45,x:448,y:561,w:36,h:30,radius:0,layer:9},
    {id:46,x:490,y:561,w:36,h:30,radius:0,layer:10}
  ],
  paletteEvents:[]
});
