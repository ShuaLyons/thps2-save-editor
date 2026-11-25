"use strict";
// ---- core start ----
// Everything that reads or changes save data. No page code in here, so it can be tested on its own.
const Core = (() => {
  const CARD_SIZE = 131072, BLOCK = 8192, FRAME = 128, GME_HEADER = 3904;

  // --- memory card ---
  function parseMemoryCard(buf) {
    // look for the 128KB image. gme files have a 3904 byte header and some are cut short.
    // keep whatever is before/after it so the file can be written back the same way
    const all = new Uint8Array(buf);
    const isMC = o => o >= 0 && o + 1 < all.length && all[o] === 0x4D && all[o + 1] === 0x43;
    const sig = String.fromCharCode(...all.slice(0, 11));
    let start = -1;
    if (sig === "123-456-STD" && isMC(GME_HEADER)) start = GME_HEADER;
    else for (const o of [0, GME_HEADER, all.length - CARD_SIZE, 0x40, 0x80, 0x200]) if (isMC(o)) { start = o; break; }
    if (start < 0 || all.length - start < 16 * FRAME)
      throw new Error(`This doesn't look like a PS1 memory card file (it's ${all.length.toLocaleString("en-US")} bytes and has no memory card header). In your emulator's memory card folder, look for a file ending in .mcd, .mcr, .srm or .gme.`);
    const prefix = all.slice(0, start);
    const body = all.slice(start, start + CARD_SIZE);
    const suffix = all.slice(Math.min(all.length, start + CARD_SIZE));
    const bytes = new Uint8Array(CARD_SIZE); bytes.set(body);
    const dv = new DataView(bytes.buffer);
    const saves = [];
    for (let i = 1; i <= 15; i++) {
      const o = i * FRAME;
      if (bytes[o] !== 0x51) continue;
      const blocks = [i];
      let next = dv.getUint16(o + 8, true);
      while (next !== 0xFFFF && blocks.length < 15) {
        const b = next + 1;
        if (b < 1 || b > 15 || blocks.includes(b)) break;
        blocks.push(b);
        next = dv.getUint16(b * FRAME + 8, true);
      }
      let name = "";
      for (let k = 0; k < 20; k++) { const ch = bytes[o + 10 + k]; if (!ch) break; name += ch >= 0x20 && ch < 0x7F ? String.fromCharCode(ch) : "?"; }
      saves.push({ name, blocks });
    }
    return { bytes, gme: { prefix, suffix }, saves };
  }
  function readSave(card, s) {
    const out = new Uint8Array(s.blocks.length * BLOCK);
    s.blocks.forEach((b, k) => out.set(card.bytes.subarray(b * BLOCK, (b + 1) * BLOCK), k * BLOCK));
    return out;
  }
  function writeSave(card, s, data) {
    s.blocks.forEach((b, k) => card.bytes.set(data.subarray(k * BLOCK, (k + 1) * BLOCK), b * BLOCK));
  }
  function cardFile(card) {
    const g = card.gme, out = new Uint8Array(g.prefix.length + CARD_SIZE + g.suffix.length);
    out.set(g.prefix, 0); out.set(card.bytes, g.prefix.length); out.set(g.suffix, g.prefix.length + CARD_SIZE);
    return out;
  }

  // --- THPS2 US career save ---
  // Layout confirmed against real saves loaded in DuckStation. There is no checksum.
  // versions confirmed in the game: US (SLUS-01066, including Greatest Hits) and English European (SLES-02908) share one layout
  const SUPPORTED = [["BASLUS-01066", "US"], ["BESLES-02908", "Europe"]];
  const OTHER_VERSIONS = [["BESLES-02909", "another European version (SLES-02909)"], ["BESLES-02910", "another European version (SLES-02910)"], ["BISLPM-86751", "the Japanese version (SLPM-86751)"]];
  const FORMAT = [0x00, 0x28, 0x07, 0x00], FORMAT_AT = 0x200;  // same in every career save seen
  const REC = 0x204, REC_SIZE = 0xE4, SKATERS = 20;             // one record per skater
  const R_COUNT = 0x00, R_GOLDS = 0x03, R_EARN = 0x04, R_CASH = 0x08, R_GOALS = 0x0C, R_DECKS = 0x2C, R_STATS = 0x30, R_ICONS = 0x3C;
  const GAPS = 0x1694, GAP_SIZE = 12;   // shared gap checklist, one bit list per level
  const CHEATS = 0x17A8;                // 17 cheats x 4 bytes: unlocked, skater, state, pad
  const CAS_NAME = 0x18BC, CAS_SIZE = 0x80;
  const FLAGS = 0x1AC0;                 // unlock flags. 4 = Private Carrera; the rest open the secret levels
  const FLAG_CARRERA = 0x04, FLAG_SECRET_LEVELS = 0x3B;
  const HISCORES = 0x13D4, HS_TABLE = 64, HS_ENTRY = 8, HS_ROWS = 8; // tables 0-9 follow the levels; table 10 is left alone
  const MAX_SCORE = 9999999;
  const CAS_TEXT = /^[A-Za-z0-9 -]{1,15}$/;                           // what real saves contain; 16 bytes with an end marker
  const MAX_MONEY = 150000, MAX_STAT = 10;
  const GOAL_100 = 0x200, GOLD = 0x400, MEDALS = 0x1C00, COMP_ALL_CASH = 0x8000;

  const PROS = ["Tony Hawk", "Bob Burnquist", "Steve Caballero", "Kareem Campbell", "Rune Glifberg", "Eric Koston", "Bucky Lasek", "Rodney Mullen", "Chad Muska", "Andrew Reynolds", "Geoff Rowley", "Elissa Steamer", "Jamie Thomas"];
  const SECRET = ["Officer Dick", "Private Carrera", "Spider-Man"];
  const STATS = ["Air", "Hang time", "Ollie", "Speed", "Spin", "Landing", "Switch", "Rail balance", "Lip balance", "Manuals"];
  const score = (a, b, c) => [`High score: ${a}`, `Pro score: ${b}`, `Sick score: ${c}`, "Collect S-K-A-T-E"];
  const tail = ["Find the secret tape", "100% goals and cash"];
  // goal names in the order of the game's goal list (bit 0 first)
  const LEVELS = [
    { name: "Hangar", kind: "goals", icons: 8, gaps: 21, needs: "Open from the start.",
      goals: [...score("10,000", "25,000", "75,000"), "Hit 5 barrels", "Find 5 pilot wings", "3 hangtime gaps", "Nosegrind over the pipe", ...tail] },
    { name: "School II", kind: "goals", icons: 12, gaps: 43, needs: "Opens at a $1,000 career total.",
      goals: [...score("15,000", "40,000", "100,000"), "Wallride 5 bells", "Find 5 hall passes", "3 Roll Call rails", "Kickflip TC's roof", ...tail] },
    { name: "Marseille", kind: "comp", icons: 8, gaps: 33, needs: "Opens at a $2,500 career total." },
    { name: "NY City", kind: "goals", icons: 12, gaps: 41, needs: "Opens with 1 medal.",
      goals: [...score("20,000", "50,000", "150,000"), "Ollie 3 hydrants", "Find 5 subway tokens", "Grind the subway track", "50-50 Joey's sculpture", ...tail] },
    { name: "Venice", kind: "goals", icons: 12, gaps: 41, needs: "Opens at a $15,000 career total.",
      goals: [...score("40,000", "100,000", "200,000"), "Ollie the magic bum 5 times", "Find 5 spray cans", "4 VB transfers", "Tailslide the Venice ledge", ...tail] },
    { name: "Skatestreet", kind: "comp", icons: 8, gaps: 36, needs: "Opens at a $25,000 career total." },
    { name: "Philadelphia", kind: "goals", icons: 13, gaps: 41, needs: "Opens with 2 medals.",
      goals: [...score("50,000", "125,000", "250,000"), "Drain the fountain", "Find 5 liberty bells", "Lip 4 skatepark gaps", "Bluntslide the awning", ...tail] },
    { name: "Bullring", kind: "comp", icons: 10, gaps: 31, needs: "Opens at a $60,000 career total." },
    { name: "Chopper Drop", kind: "secret", icons: 0, gaps: 9, needs: "Opens for everyone when the secret levels are unlocked." },
    { name: "Skate Heaven", kind: "secret", icons: 0, gaps: 71, needs: "Opens for everyone when the secret levels are unlocked." },
  ];
  const TOTAL_GAPS = LEVELS.reduce((a, L) => a + L.gaps, 0);
  // gap names and points per level, in the order of the game's gap table (bit 0 first).
  // From DCxDemo's THPS2 Cumulative Patch; the count matches the save for every level.
  const GAP_NAMES = [
    [["HALFPIPE HANGTIME",500],["HALFPIPE GRIND",250],["ROLLIN GAP",100],["CHOPPER HOP",100],["WINGTIP HANGTIME",500],["SKYCRANE HANGTIME",500],["FLYIN HIGH",250],["AIR OVER THE DOOR",500],["ITS COLD UP HERE",250],["LIL LIGHT HOPPER",250],["BIG LIGHT HOPPER",500],["RAIL-GUIDED MISSILE",100],["RAILDROP",100],["LIGHT CORNER",500],["INSTRUMENT LANDING",500],["HIGH STEPPIN'",100],["ONE HALF PIPE LIP",100],["THE OTHER HALF PIPE LIP",100],["WIND TUNNEL BACK WALL",100],["UPWIND LIP",100],["DOWNWIND LIP",100]],
    [["LEAP OF FAITH!!!",500],["CARLSBAD GAP",750],["DROP OUT ROOF GAP!",500],["CRAZY ROOF GAP!!",750],["TC'S ROOF GAP",250],["SUICIDAL ROOF GAP!!!",1000],["AWNING HOP",500],["TABLE TRANSFER",250],["2 DA ROOF!!!",750],["HUGE TRANSFER!!!",750],["MAD SKEELZ ROOF GAP!!!",1000],["OVERHANG AIR",500],["BALCONY 2 AWNING!!!",1000],["ARE YOU SERIOUS?!!",2500],["OVER THE WALL...",250],["AND DOWN THE BANK!",500],["CARLSBAD 11 SET",500],["3 POINTS!!!",500],["ROLL CALL! GONZ RAIL!",250],["BIG RANCHO BENCH GAP",500],["GYM RAIL 2 RAIL",250],["OVERHANG STOMP!",250],["RACK 'EM UP",250],["POLE STOMP!",250],["POLE 2 BRIX!",500],["BANK 2 LEDGE",500],["FLYIN' THE FLAG!",750],["ROLL CALL! NIGHTMARE RAIL!",500],["BENDY'S CURB",500],["STAGE RAIL 2 RAIL",750],["ROLL CALL! OPUNSEZMEE RAIL!",250],["KICKER 2 HOOK",750],["BACKBOARD DANCE!",1000],["2 WHEELIN' TC'S ROOF",500],["LEDGE ON EDGE",500],["BENDY'S FLAT",500],["PLANTER ON EDGE",250],["ARCH EXTENSION",500],["LIL' GUPPY EXTENSION!",1000],["MID SQUID EXTENSION!!",2500],["HIGH DIVE EXTENSION!!!",5000],["STARTING BLOCKS EXTENSION!!!",500],["ROCK THE BELLS!",500]],
    [["OVER THE GATE",250],["OVER THE CROSSBAR",500],["FREAKIN' HUGE HIP",1000],["DUMPSTER POP",200],["TABLE POP",250],["2 THE BOX",250],["OVER THE TABLE",250],["BOX 2 BOX ACTION",250],["HUMPTEY HUMPS!!!",1000],["SHORTY DUMPSTER POP",150],["SHORTY TABLE POP",150],["OVER THE LIL' 4",100],["UP THE LIL' 4",250],["BIG OL' STANKY GAP",500],["WATER UP LE BACKSIDE",250],["BIG MOUTH GAP",1000],["UP!",250],["UP!!",500],["AND AWAY!!!",1000],["RAIL 2 LEDGE",250],["LEDGE 2 RAIL",250],["LAMP STOMP",2000],["RAIL 2 RAIL",50],["KNUCKLIN' FUTS!!!",2000],["DUMPSTER STOMP",1000],["KINK CLANK",1000],["KINK STOMP",1000],["THE HIDDEN 4 KINK!",500],["CROSSBAR STOMP",1500],["BOOMIN' EXTENSION",250],["STANKY EXTENSION",250],["U.U.A. EXTENSION",250],["WALL CRAWLER",500]],
    [["PIGEON PUDDIN' GAP",100],["RAMP TO PARK GAP",100],["RAMP TO STATUE SHORTY GAP",250],["POUNCER WAS HERE",250],["AWNING AIR",100],["KICK IT",50],["TAKE IT TO THE BRIDGE",150],["OVER THE ROAD",250],["BIG AIR OUT OF THE BANKS",250],["OVER THE BANKS BARRIER",100],["PILLAR AIR",500],["ROCK IT AIR",50],["BENCH-HOPPIN",100],["LEFT SIDE PIT RAIL STOMP",100],["BANKS SPANK",100],["PARKING METER GAP",100],["YOU'RE NEXT IN LINE",100],["THE EASY WAY",100],["THE HARD WAY",500],["JOEY'S SCULPTURE",100],["RIGHT SIDE PIT RAIL STOMP",100],["JAMIE'S STEPS",100],["BANKS FENCE GAP",100],["BANKS ROAD GAP",100],["REBAR TO RAIL GAP",100],["RIDE THE RAILS",100],["ACROSS THE PIT",100],["CORNER CUT",100],["PATH LESS TRAVELED",500],["PARK ENTRANCE GAP",100],["SIDEWALK BOMB",1000],["CHANGIN TRAINS",1000],["GRAB A SNACK AND SIT DOWN.",100],["BUUURP!  NOW GO SKATE.",100],["RE-REBAR",50],["SLAM DUNK",500],["THE BRIDGE",250],["GOING DOWN?",250],["PHAT LIP",100],["WAAAAY UP THERE",100],["BANKS BARRIER WALLRIDE",100]],
    [["MUSKA'S GAP",500],["TABLE POP",200],["TIGHT LANDING TRANSFER",500],["VB! HUGE TRANSFER!!!",1000],["CAKE TRANSFER",250],["WEST SIDE TRANSFER",250],["BIG DOUBLE 5 SET",500],["VB! PIT TRANSFER",500],["MASSIVE 20 SET!",1000],["WEE LIL' ROOF GAP",250],["NICE MID SIZE ROOF GAP",500],["SIIIIICK ROOF GAP!!!",1000],["SHORTY PLANTER POP",200],["PLANTER POP",500],["ROOF 2 RAMP",500],["RAMP 2 ROOF",750],["HUGE ROOF 2 RAMP",1000],["HUGE RAMP 2 ROOF",1500],["VB SKINNY TRANSFER",100],["FATTY TRANSFER",1000],["UP!",100],["UP!!",250],["AND AWAY!!!",500],["VB! LEDGE TRANSFER",500],["CANYON JUMP",250],["UPHILL CANYON JUMP",750],["LIL' VENT GAP",500],["BIG VENT GAP",1000],["VENT 2 ROOF GAP",750],["LEDGE 9 SET",250],["BENCH TRIPPIN'",500],["LEDGE 2 LEDGE",500],["THE VENICE LEDGE",250],["SEASIDE HANDRAIL",200],["10 POINT LANDING!",500],["'ROUND THE HORN!!!",2500],["THE HIGH WIRE",1000],["HE COULD GO...",250],["ALL THE WAY...",500],["TOUCHDOWN!!!",1000],["CANDY CANE MANUAL",750]],
    [["HP TO BOWL",100],["BOWL TO HP",100],["BULLET BOWL HOP",100],["OVER THE DECK",100],["DAAAAAY TRIPPER",100],["GIMME GAP REDUX",100],["SODEE POP GAP",100],["CUT THE CORNER",100],["HIGH STICKER",100],["RAILING HOP",50],["OVER THE BRIDGE",50],["OVER THE WALL",10],["SHOOT THE GAP",100],["NO KIDDING AROUND",150],["STAIRSET",150],["HEXBOX GAP",150],["HIGH JUMPER",250],["VAN SECRET AREA KEY",100],["RAIL SECRET AREA KEY",50],["NAIL THE RAIL",100],["HP TO RAILBOX",100],["WAVE WALL MINIGAP",100],["SURFIN U.S.A.",100],["SKATIN ON THE DOCK OF THE BAY",100],["CIRCLE THE POOL",500],["HAVIN A PICNIC",100],["EXTENSION TRANSFER",100],["BIG AIR RAILING GRIND",100],["RAIL TO RAIL",50],["FUNBOX WHEELIE",100],["BOWL LIP",100],["HP LIP",100],["RIDE THE WAVE",100],["GULLY LIP",100],["BOWL ENVY",100],["MR. SMALL LIPS",100]],
    [["THPS FOUNTAIN GAP",500],["CHILLIN' ON THE BALCONY",500],["STAIR SET",100],["UP THE SMALL STEP SET",100],["BENCH GAP",100],["PHILLYSIDE HP TRANSFER",250],["WORLDS MOST OBVIOUS GAP",100],["PHILLYSIDE HOP",100],["POST OLLIE",50],["EASY POST OLLIE",10],["STATUE HOP",50],["PILLAR FIGHT",250],["TELEPHONE CO. GAP",250],["WORLDS SECOND MOST OBVIOUS GAP",750],["GRIND OF FAITH",1500],["GRIND UP DEM STAIRS",500],["AWNING GRIND",500],["LITTLE CORNER GRIND",500],["FLY BY WIRE",500],["DEATH FROM ABOVE",500],["TRACK SMACK",50],["HOBO GRIND",100],["PLANTER TRANSFER",100],["RAILING TO PLANTER",100],["TRAIN HARD",500],["PILLAR HOP",150],["FUNBOX TRANSFER",250],["PLANTER DOUBLE PILLAR GAP",150],["JUST VISITING",150],["FOUNTAIN PING!",750],["SHORT STAIR",150],["MEDIUM STAIR",250],["LONG STAIR",500],["FUNBOX WHEELIE",100],["FLATLANDS TECHIN'",500],["ROCKIN' THE STAIRS",2500],["MANUAL STIMULATION",500],["PHILLYSIDE NEW BOWL LIP",100],["PHILLYSIDE HP LIP",100],["PHILLYSIDE BIG BOWL LIP",100],["PHILLYSIDE MID BOWL LIP",100]],
    [["LAUNCHIN ON UP",200],["LAUNCHIN THE PIPE",300],["TIGHT GAP",1000],["PLAT GAP",100],["WUSSY ROLLIN GAP",50],["ROLLIN GAP",300],["BIG ENCHILADA MAMA",600],["JUMPIN DA HUMPS",1500],["AIR TORO",400],["GATE GAP",150],["DONT LOOK DOWN!",500],["ENJOYIN THE VIEW",250],["GRINDIN THE PIPE",450],["BOX TO BANANA",1000],["KINK",400],["RAIL PLAT GAP",750],["LIL WEE WUSSY GAP",1],["RAMP RAIL TO BANANA",500],["LAUNCH TO BANANA",1000],["LAUNCH TO RAIL",2000],["BOX TO RAIL",500],["NICE FRIGGIN ANKLES",500],["NAILIN DA RAIL",500],["TAKIN THE HIGH ROAD",650],["WAY TO GO AMIGO",500],["RAMP RAIL TO RAIL",500],["CLENCHFEST!",1500],["FINESSE TEST",1500],["THREADIN THE NEEDLE",2000],["UP TO THE STANDS",50],["WAY TO GO GRINGO!!!",5000]],
    [["70FT",100],["80FT",200],["90FT",300],["INTO THE HELI",500],["HELI GRIND",500],["1 POTATO",100],["2 POTATO",200],["3 POTATO",400],["WHOOMAH",500]],
    [["DROPPING IN ON TONY",250],["UP 2 COMBI",1000],["DOWN 2 TONYS ISLAND",50],["GUTTER 2 SAN DIEGUITO ROOF",800],["ZIG GAP",1500],["ZAG GAP",2000],["WUSSY SNAKE GAP",800],["REVERSE ZIG GAP",2000],["REVERSE ZAG GAP",2000],["REVERSE WUSSY SNAKE GAP",1000],["ISLE OF TONY 2 SADLANDS",300],["SADLANDS PATH GAP",800],["HOUSE OF TONY 2 SADLANDS",500],["SAN DIEGUITO HALL 2 SADLANDS",50],["SAN DIEGUITO WINDOW 2 SADLANDS",500],["TIGHT LANDING",1500],["SAN DIEGUITO TEN SET",100],["BIG FAT GRASSY GAP",400],["GRASSY GAP",50],["FEED ME!!!",2000],["NORTHWEST SNAKE GAP",800],["NORTHEAST SNAKE GAP",800],["SOUTHERN SNAKE GAP",1000],["WEAK SAUCE ZIG GAP",50],["WEAK SAUCE ZAG GAP",50],["WEAK SAUCE WUSSY SNAKE GAP",50],["PLATFORM GAP",300],["AIRS HOLE",300],["SADLANDS UP 2 ISLE OF TONY",1000],["OVER THE DOME",1000],["CLEARING THE SWINGS",1000],["JUMPIN DA HUB",1000],["TUNNEL OF LUVIN",1000],["BLOWIN IT OUT THE HOLE!",500],["PIT O DOOM!!!",4000],["SADLANDS 2 SAN DIEGUITO HALL",500],["THE HOLY CRAIL",500],["RADRAMP 2 SNAKERUN",2000],["RADRAMP 2 ISLANDS EDGE",400],["GUTTER 2 SAN DIEGUITO ROOF",600],["UP 2 PIPE RAIL",1000],["LONGRAIL",2000],["RAIL 2 SNAKERUN",50],["RAMP 2 RAIL",300],["90 DEGREE SADLANDS RAIL GAP",300],["RAMP RAIL GAP",75],["90 DEGREE RAMP RAIL GAP",500],["FENCE 2 RADRAMP",500],["OFF THE ROOF 2 RAIL",2000],["TIME 2 FEED THE VOLCANO!!!",4000],["ISLE OF TONY 2 EDGE",600],["SAN DIEGUITO HALL 2 EDGE",500],["SAN DIEGUITO ROOF 2 EDGE",1600],["BENCH GAP",2000],["RIMRAIL GAP",450],["SWINGING THE SET",2000],["BENCH GAP SERIES",5000],["SOUTHERN SWINGRAIL",900],["NORTHERN SWINGRAIL",900],["MID INTERSECT SAD GAP",350],["SOUTHERN INTERSECT SAD GAP",200],["NORTHERN INTERSECT SAD GAP",200],["NORTHERN CROSSOVER SAD GAP",300],["SOUTHERN CROSSOVER SAD GAP",300],["TOP OF DA WORLD MA!!!",700],["KICKER 2 RAIL",4000],["KICKER 2 RAILSPAN",1500],["RAIL 2 KICKER 2 RAIL 2 BENCH",1500],["CHEN RAIL SERIES",300],["WOOHOOO OH HO YEEHEE!!!",2500],["CLEANING THE PIPES",5000]],
  ];
  const CHEAT_NAMES = ["McSqueeb", "Spider-Man", "Officer Dick", "Skip to restart", "Kid mode", "Perfect balance", "Always special", "Stud mode", "Weight", "Wireframe", "Slow-nic", "Big head", "Sim mode", "Smooth shading", "Moon physics", "Disco mode", "Level flip"];
  // which skater the game recorded as unlocking each cheat, taken from a 100% save made without codes
  const CHEAT_SKATER = [0, 13, 1, 7, 3, 2, 4, 5, 6, 8, 9, 10, 12, 11, 17, 18, 19];
  const CHEAT_DEFAULT_STATE = i => (i === 8 ? 100 : 0); // weight starts at 100 even while locked

  // --- small helpers ---
  const u16 = (d, o) => d[o] | d[o + 1] << 8;
  const set16 = (d, o, v) => { d[o] = v & 255; d[o + 1] = v >>> 8 & 255; };
  const i32 = (d, o) => d[o] | d[o + 1] << 8 | d[o + 2] << 16 | d[o + 3] << 24;
  const u32 = (d, o) => i32(d, o) >>> 0;
  const set32 = (d, o, v) => { d[o] = v & 255; d[o + 1] = v >>> 8 & 255; d[o + 2] = v >>> 16 & 255; d[o + 3] = v >>> 24 & 255; };
  const bitOn = (d, o, i) => (d[o + (i >> 3)] >> (i & 7) & 1) === 1;
  const setBit = (d, o, i, on) => { if (on) d[o + (i >> 3)] |= 1 << (i & 7); else d[o + (i >> 3)] &= ~(1 << (i & 7)) & 255; };
  const popcount = v => { v >>>= 0; let c = 0; while (v) { c += v & 1; v >>>= 1; } return c; };
  const countFirst = (d, o, n) => { let c = 0; for (let i = 0; i < n; i++) if (bitOn(d, o, i)) c++; return c; };
  function clampInt(v, lo, hi) { v = Math.floor(Number(v)); if (!Number.isFinite(v)) v = lo; return Math.min(hi, Math.max(lo, v)); }
  const rec = n => REC + n * REC_SIZE;
  const goalsAt = (n, l) => rec(n) + R_GOALS + 2 * l;
  const iconsAt = (n, l) => rec(n) + R_ICONS + 8 * l;

  // --- identify and check ---
  function sjisText(d, o, len) {
    const punct = { 0x8143: ",", 0x8144: ".", 0x8146: ":", 0x8147: ";", 0x8148: "?", 0x8149: "!", 0x815B: "-", 0x815C: "-", 0x815D: "-", 0x815E: "/", 0x8166: "'", 0x8168: "\"", 0x8169: "(", 0x816A: ")", 0x817B: "+", 0x817C: "-", 0x8181: "=", 0x8193: "%", 0x8194: "#", 0x8195: "&", 0x8196: "*", 0x8197: "@" };
    let s = "";
    for (let i = o; i < o + len;) {
      const a = d[i];
      if (!a) break;
      if (a < 0x80) { s += a >= 0x20 && a < 0x7F ? String.fromCharCode(a) : "?"; i++; continue; }
      const c = a << 8 | (d[i + 1] || 0); i += 2;
      if (c === 0x8140) s += " ";
      else if (c >= 0x824F && c <= 0x8258) s += String.fromCharCode(0x30 + c - 0x824F);
      else if (c >= 0x8260 && c <= 0x8279) s += String.fromCharCode(0x41 + c - 0x8260);
      else if (c >= 0x8281 && c <= 0x829A) s += String.fromCharCode(0x61 + c - 0x8281);
      else s += punct[c] || "?";
    }
    return s.replace(/\s+/g, " ").trim();
  }
  function careerName(d) {
    if (d.length < 68) return "";
    const t = sjisText(d, 4, 64), m = /^THPS2 CAREER-\s*(.+)$/.exec(t);
    return m ? m[1] : t;
  }
  const isCareer = d => d.length >= BLOCK && d[0] === 0x53 && d[1] === 0x43 && FORMAT.every((b, i) => d[FORMAT_AT + i] === b);
  function identify(name, d) {
    for (const [prefix, region] of SUPPORTED) if (name.startsWith(prefix)) {
      if (!isCareer(d)) return { ok: false, msg: "This Tony Hawk's Pro Skater 2 save isn't a career save (it may be a park). Only career saves can be edited." };
      return { ok: true, msg: "", region };
    }
    for (const [prefix, label] of OTHER_VERSIONS)
      if (name.startsWith(prefix)) return { ok: false, msg: `This is a save from ${label} of Tony Hawk's Pro Skater 2, which hasn't been tested yet. Only the US version and the English European version (SLES-02908) are supported for now.` };
    return { ok: false, msg: "This isn't a Tony Hawk's Pro Skater 2 save. Pick another save from the list." };
  }
  // values the game never writes on its own (for example from cheat devices)
  function oddValues(d) {
    const out = new Set();
    for (let n = 0; n < SKATERS; n++) {
      const r = rec(n), earn = i32(d, r + R_EARN), cash = i32(d, r + R_CASH);
      if (earn < 0 || earn > MAX_MONEY) out.add("career total outside $0 to $150,000");
      if (cash < 0 || cash > MAX_MONEY) out.add("cash outside $0 to $150,000");
      for (let i = 0; i < 10; i++) if (d[r + R_STATS + i] > MAX_STAT) out.add("stats above 10");
    }
    return [...out];
  }

  // --- skaters ---
  const kindOf = n => (n < 13 ? "pro" : n < 17 ? "created" : "secret");
  const deckRange = n => (kindOf(n) === "created" ? [10, 20] : [1, 8]);
  function skaterName(d, n) {
    if (n < 13) return PROS[n];
    if (n >= 17) return SECRET[n - 17];
    const o = CAS_NAME + (n - 13) * CAS_SIZE;
    let s = "";
    for (let i = 0; i < 16; i++) {
      const c = d[o + i];
      if (!c) break;
      if (c < 0x20 || c > 0x7E) { s = ""; break; }
      s += String.fromCharCode(c);
    }
    s = s.trim();
    return s || `Created skater ${n - 12}`;
  }
  function locked(d, n) {
    if (n === 17) return !cheatUnlocked(d, 2);
    if (n === 18) return !carrera(d);
    if (n === 19) return !cheatUnlocked(d, 1);
    return false;
  }
  function skater(d, n) {
    const r = rec(n);
    return {
      n, name: skaterName(d, n), kind: kindOf(n), locked: locked(d, n),
      earn: i32(d, r + R_EARN), cash: i32(d, r + R_CASH),
      decks: popcount(u32(d, r + R_DECKS)), deckRange: deckRange(n),
      stats: Array.from(d.subarray(r + R_STATS, r + R_STATS + 10)),
      levels: LEVELS.map((L, l) => {
        const g = u16(d, goalsAt(n, l));
        return { goals: g, icons: countFirst(d, iconsAt(n, l), L.icons), done: L.kind === "goals" ? popcount(g & 0x3FF) : 0, gold: (g & GOLD) !== 0, medal: (g & MEDALS) !== 0 };
      }),
    };
  }

  // keep the game's own bookkeeping in step after any career change
  const iconsFull = (d, n, l) => LEVELS[l].icons > 0 && countFirst(d, iconsAt(n, l), LEVELS[l].icons) === LEVELS[l].icons;
  function syncLevel(d, n, l) {
    const L = LEVELS[l], o = goalsAt(n, l);
    let g = u16(d, o);
    // the last goal is "100% goals and cash": the game only gives it with all 9 goals and every cash icon
    if (L.kind === "goals") g = (g & 0x1FF) === 0x1FF && iconsFull(d, n, l) ? g | GOAL_100 : g & ~GOAL_100;
    // competitions mark "all cash icons collected" in the top bit
    if (L.kind === "comp") g = iconsFull(d, n, l) ? g | COMP_ALL_CASH : g & ~COMP_ALL_CASH;
    set16(d, o, g & 0xFFFF);
  }
  function syncCounts(d, n) {
    // first byte = goals ticked, fourth byte = gold medals (matches every save checked)
    let goals = 0, golds = 0;
    for (let l = 0; l < LEVELS.length; l++) {
      const g = u16(d, goalsAt(n, l));
      goals += popcount(g & 0x3FF);
      if (LEVELS[l].kind === "comp" && (g & GOLD)) golds++;
    }
    d[rec(n) + R_COUNT] = goals; d[rec(n) + R_GOLDS] = golds;
  }

  function setEarnings(d, n, v) {
    v = clampInt(v, 0, MAX_MONEY); const r = rec(n);
    set32(d, r + R_EARN, v);
    if (i32(d, r + R_CASH) > v) set32(d, r + R_CASH, v);   // cash is what's left of earnings
  }
  function setCash(d, n, v) {
    v = clampInt(v, 0, MAX_MONEY); const r = rec(n);
    set32(d, r + R_CASH, v);
    if (i32(d, r + R_EARN) < v) set32(d, r + R_EARN, v);
  }
  function setStat(d, n, i, v) { d[rec(n) + R_STATS + i] = clampInt(v, 0, MAX_STAT); }
  function maxStats(d, n) { for (let i = 0; i < 10; i++) setStat(d, n, i, MAX_STAT); }
  function setDecks(d, n, k) {
    const [lo, hi] = deckRange(n); k = clampInt(k, lo, hi);
    set32(d, rec(n) + R_DECKS, 2 ** k - 1);
  }
  function setGoal(d, n, l, bit, on) {
    if (LEVELS[l].kind !== "goals" || bit < 0 || bit > 8) return;
    const o = goalsAt(n, l), g = u16(d, o);
    set16(d, o, on ? g | 1 << bit : g & ~(1 << bit));
    syncLevel(d, n, l); syncCounts(d, n);
  }
  function setGold(d, n, l, on) {
    if (LEVELS[l].kind !== "comp") return;
    const o = goalsAt(n, l), g = u16(d, o);
    set16(d, o, on ? g | GOLD : g & ~GOLD);
    syncCounts(d, n);
  }
  function setIcons(d, n, l, k) {
    const N = LEVELS[l].icons, o = iconsAt(n, l);
    if (!N) return;
    k = clampInt(k, 0, N);
    let cur = countFirst(d, o, N);
    // add the lowest missing icons, or take away the highest collected ones
    for (let i = 0; i < N && cur < k; i++) if (!bitOn(d, o, i)) { setBit(d, o, i, true); cur++; }
    for (let i = N - 1; i >= 0 && cur > k; i--) if (bitOn(d, o, i)) { setBit(d, o, i, false); cur--; }
    syncLevel(d, n, l); syncCounts(d, n);
  }
  function completeLevel(d, n, l) {
    const L = LEVELS[l], o = goalsAt(n, l);
    if (L.kind === "goals") set16(d, o, u16(d, o) | 0x1FF);
    if (L.kind === "comp") set16(d, o, u16(d, o) | GOLD);
    if (L.icons) setIcons(d, n, l, L.icons);
    syncLevel(d, n, l); syncCounts(d, n);
  }
  function completeCareer(d, n) {
    for (let l = 0; l < LEVELS.length; l++) completeLevel(d, n, l);
    if (i32(d, rec(n) + R_EARN) < MAX_MONEY) setEarnings(d, n, MAX_MONEY);
    setDecks(d, n, deckRange(n)[1]);
  }

  // --- shared: gaps, cheats, unlocks ---
  const gapsFound = (d, l) => countFirst(d, GAPS + GAP_SIZE * l, LEVELS[l].gaps);
  const totalFound = d => LEVELS.reduce((a, L, l) => a + gapsFound(d, l), 0);
  function setGaps(d, l, on) {
    const o = GAPS + GAP_SIZE * l;
    for (let i = 0; i < GAP_SIZE; i++) d[o + i] = 0;
    if (on) for (let i = 0; i < LEVELS[l].gaps; i++) setBit(d, o, i, true);
  }
  const gapOn = (d, l, i) => bitOn(d, GAPS + GAP_SIZE * l, i);
  function setGap(d, l, i, on) { if (i >= 0 && i < LEVELS[l].gaps) setBit(d, GAPS + GAP_SIZE * l, i, on); }
  const cheatUnlocked = (d, i) => d[CHEATS + 4 * i] !== 0;
  function setCheat(d, i, on) {
    const o = CHEATS + 4 * i;
    if (on) { if (!d[o]) { d[o] = 1; d[o + 1] = CHEAT_SKATER[i]; } }
    else { d[o] = 0; d[o + 1] = 0; d[o + 2] = CHEAT_DEFAULT_STATE(i); }
  }
  // --- high scores: 8 entries per level of initials (3 bytes), skater (1 byte) and score (4 bytes) ---
  function highScores(d, t) {
    return Array.from({ length: HS_ROWS }, (_, i) => {
      const o = HISCORES + t * HS_TABLE + i * HS_ENTRY;
      return { initials: String.fromCharCode(d[o], d[o + 1], d[o + 2]), skater: d[o + 3], score: u32(d, o + 4) };
    });
  }
  function cleanInitials(s) {
    const v = String(s).toUpperCase().replace(/[^A-Z ]/g, "").slice(0, 3);
    return /[A-Z]/.test(v) ? v.padEnd(3, " ") : null;
  }
  // change one entry, then keep the table in order from highest to lowest; returns where the entry ended up
  function setHighScore(d, t, i, e) {
    if (!(t >= 0 && t < LEVELS.length && i >= 0 && i < HS_ROWS)) return i;
    const rows = highScores(d, t).map((r, k) => ({ ...r, k }));
    rows[i] = { initials: cleanInitials(e.initials) || rows[i].initials, skater: clampInt(e.skater, 0, SKATERS - 1), score: clampInt(e.score, 0, MAX_SCORE), k: i };
    rows.sort((a, b) => b.score - a.score || a.k - b.k);
    rows.forEach((r, j) => {
      const o = HISCORES + t * HS_TABLE + j * HS_ENTRY;
      for (let c = 0; c < 3; c++) d[o + c] = r.initials.charCodeAt(c) & 255;
      d[o + 3] = r.skater; set32(d, o + 4, r.score);
    });
    return rows.findIndex(r => r.k === i);
  }
  // --- created skaters' name and hometown ---
  const casAt = (n, which) => CAS_NAME + (n - 13) * CAS_SIZE + (which === "town" ? 16 : 0);
  function casText(d, n, which) {
    if (n < 13 || n > 16) return "";
    let s = "";
    for (let i = 0, o = casAt(n, which); i < 16 && d[o + i]; i++) s += d[o + i] >= 0x20 && d[o + i] < 0x7F ? String.fromCharCode(d[o + i]) : "?";
    return s;
  }
  const validCasText = s => CAS_TEXT.test(s) && s.trim().length > 0;
  function setCasText(d, n, which, s) {
    if (n < 13 || n > 16 || !validCasText(s)) return false;
    const o = casAt(n, which);
    for (let i = 0; i < 16; i++) d[o + i] = i < s.length ? s.charCodeAt(i) : 0;
    return true;
  }
  const carrera = d => (u32(d, FLAGS) & FLAG_CARRERA) !== 0;
  const secretLevels = d => (u32(d, FLAGS) & FLAG_SECRET_LEVELS) === FLAG_SECRET_LEVELS;
  function setFlags(d, mask, on) { const v = u32(d, FLAGS); set32(d, FLAGS, on ? v | mask : v & ~mask); }
  const setCarrera = (d, on) => setFlags(d, FLAG_CARRERA, on);
  const setSecretLevels = (d, on) => setFlags(d, FLAG_SECRET_LEVELS, on);

  return {
    CARD_SIZE, BLOCK, SKATERS, MAX_MONEY, MAX_STAT, MAX_SCORE, LEVELS,
    highScores, cleanInitials, setHighScore, casText, validCasText, setCasText, STATS, CHEAT_NAMES, TOTAL_GAPS,
    parseMemoryCard, readSave, writeSave, cardFile, identify, careerName, oddValues,
    skater, skaterName, kindOf, deckRange,
    setEarnings, setCash, setStat, maxStats, setDecks, setGoal, setGold, setIcons, completeLevel, completeCareer,
    GAP_NAMES, gapsFound, totalFound, setGaps, gapOn, setGap, cheatUnlocked, setCheat, carrera, secretLevels, setCarrera, setSecretLevels,
  };
})();
// ---- core end ----

// ---- page ----
const $ = id => document.getElementById(id);
const st = { card: null, fileName: "", saveIdx: -1, save: null, base: null, undo: [], skater: 0, tab: "skaters", open: new Set([0]), gapOpen: new Set(), gapQuery: "", hsOpen: new Set([0]) };
const fmt = n => n.toLocaleString("en-US");
const money = n => "$" + fmt(n);
const COMPS = [2, 5, 7];

// build elements safely: strings always become text, never HTML
const PROPS = new Set(["value", "checked", "disabled", "open", "indeterminate"]);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
// a steel panel with its tab label
const pnl = (tab, attrs, ...kids) => { const { label, ...rest } = attrs || {}; return h("section", { class: "pnl", ...rest }, h("h3", { class: "pnl-tab", text: tab, "aria-label": label }), ...kids); };

function sameBytes(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
const isDirty = () => !!(st.save && st.base) && !sameBytes(st.save, st.base);
function status(msg, kind = "") { const s = $("status"); s.textContent = msg; s.className = kind; }
function banner(text) {
  // one element per letter so each can bounce a little; the banner is decoration, hidden from screen readers
  const el = $("banner-text");
  // capitals and small letters take turns (each word starts with a capital), squeezed so they overlap
  let n = 0;
  el.replaceChildren(...[...text].map(ch => {
    const i = document.createElement("i");
    if (ch === " ") { i.className = "sp"; n = 0; return i; }
    i.textContent = n % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase();
    if (i.textContent !== ch.toUpperCase()) i.className = "lo";
    n++;
    return i;
  }));
  fitBanner();
}
function fitBanner() {
  // shrink long words until they fit the strip
  const el = $("banner-text"), strip = el.parentElement, vertical = getComputedStyle(el).writingMode.startsWith("vertical");
  el.style.removeProperty("--banner-size");
  const room = vertical ? strip.clientHeight - 76 : strip.clientWidth - 40;
  const used = vertical ? el.getBoundingClientRect().height : el.getBoundingClientRect().width;
  if (used > room) el.style.setProperty("--banner-size", (parseFloat(getComputedStyle(el).fontSize) * room / used).toFixed(1) + "px");
}
addEventListener("resize", fitBanner);
if (document.fonts) document.fonts.ready.then(fitBanner);
banner($("banner-text").textContent);

// every change goes through here so undo, reset and the unsaved warning stay in sync
function edit(fn, msg) {
  if (!st.save) return;
  const before = st.save.slice();
  fn(st.save);
  if (sameBytes(before, st.save)) { refresh(); status(msg ? msg + " (nothing changed)" : "Nothing changed."); return; }
  st.undo.push(before);
  if (st.undo.length > 300) st.undo.shift();
  refresh();
  status(msg || "You have unsaved changes.");
}
function refresh() {
  const focusId = document.activeElement && document.activeElement.id;
  renderRoster(); renderSkater(); renderGaps(); renderScores(); renderUnlocks();
  $("undo").disabled = !st.undo.length;
  $("reset").disabled = !isDirty();
  if (focusId && $(focusId)) $(focusId).focus();
}
function undo() {
  if (!st.save || !st.undo.length) return;
  st.save = st.undo.pop();
  refresh();
  status(isDirty() ? "Undid the last change." : "Undid the last change. No unsaved changes left.");
}
async function reset() {
  if (!isDirty()) return;
  if (!(await ask("Reset?", "<p>Put everything back to how it was when you opened this save (or last saved)? You can undo this.</p>"))) return;
  st.undo.push(st.save.slice());
  st.save = st.base.slice();
  refresh();
  status("Everything is back to how it was.");
}

// --- loading ---
async function loadFile(file) {
  if (!file) return;
  if (isDirty() && !(await ask("Leave?", "<p>You have unsaved changes. Open another file anyway?</p>"))) return;
  try {
    // cards are 128 KB, so don't read anything huge
    if (file.size > 4 * 1024 * 1024) throw new Error(`This file is too big to be a PS1 memory card (${(file.size / 1048576).toFixed(1)} MB). Memory cards are 128 KB.`);
    loadBuffer(file.name, await file.arrayBuffer());
  } catch (e) {
    $("insert-msg").textContent = e.message;
    if (!$("editor").hidden) status(e.message, "err");
  }
}
function loadBuffer(name, buf) {
  const card = Core.parseMemoryCard(buf);
  if (!card.saves.length) throw new Error("There are no saves on this memory card.");
  st.card = card; st.fileName = name;
  $("insert-msg").textContent = "";
  const sel = $("saves"); sel.replaceChildren();
  const careers = card.saves.map(s => {
    const data = Core.readSave(card, s), id = Core.identify(s.name, data);
    return { s, ok: id.ok, label: id.ok ? `${Core.careerName(data) || "Career"} (THPS2 career, ${id.region})` : s.name || "Unnamed save" };
  });
  careers.forEach((c, i) => sel.append(h("option", { value: i, text: c.label })));
  let pick = careers.findIndex(c => c.ok);
  if (pick < 0) pick = 0;
  sel.value = pick;
  $("file-name").textContent = name;
  $("insert").hidden = true;
  $("editor").hidden = false;
  openSave(pick);
}
function openSave(i) {
  const s = st.card.saves[i];
  const data = Core.readSave(st.card, s);
  st.saveIdx = i; st.save = null; st.base = null; st.undo = [];
  const id = Core.identify(s.name, data);
  if (!id.ok) {
    setEditable(false);
    banner("Memory Card");
    status(id.msg, "err");
    return;
  }
  st.save = data;
  st.base = data.slice();
  setEditable(true);
  showTab(st.tab);
  refresh();
  const odd = Core.oddValues(data);
  if (odd.length) status(`Opened "${Core.careerName(data)}". This save has values the game doesn't normally produce (${odd.join(", ")}), perhaps from a cheat device. You can still edit it.`, "err");
  else status(`Opened "${Core.careerName(data)}". Pick a skater to edit, or use the menu for the gap list, cheats and unlocks.`, "good");
}
function setEditable(on) {
  ["save", "undo", "reset"].forEach(id => $(id).disabled = !on);
  for (const t of document.querySelectorAll(".tab")) t.disabled = !on;
  if (!on) { $("roster").replaceChildren(); $("skater").replaceChildren(); $("panel-gaps").replaceChildren(); $("panel-scores").replaceChildren(); $("panel-unlocks").replaceChildren(); }
}

// ---- PS1-style spinning deck ----
// An original low-poly skateboard for each roster slot, spinning like a PS1 select screen.
// Tiny textures sampled without perspective correction (the PS1 texture warp), corners snapped
// to whole pixels, and 15-bit colour with dithering. The deck graphics are original patterns,
// not real board brands.
const Deck = (() => {
  const W = 112, H = 160, F = 340, DIST = 3.6, PITCH = .22, CY = -.04, TW = 16, TH = 48;
  const LEN = 1.6, WID = .42, THICK = .045;
  const hex = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const avg = ps => mul(ps.reduce(add, [0, 0, 0]), 1 / ps.length);

  // ---- deck graphics: original 16x48 pixel art, nose at the top, one per roster slot ----
  // Themed on each name (Hawk, Brazil, Knight, Campfire...), not on any real board art.
  // Each is [name, wheel colour, palette, pixels, width?, height?]; a pixel is one hex digit picking a
  // palette colour. Width and height default to 16x48; Tony's hand-drawn deck is 24x92.
  const CREATED = ["Created skater", "#ffc81e", "5791ce 3574b9 19171c 040203 2a354d 30598b ab861b d3a11f f8cb18 80541d f2b81a c64624 523116 fed210 f9e3d4 141218", "ffffffffffffffffffffff2222222f222fffffffffffffffffffffffffffffffffffffff222f24555555555555422222ffffffffffffffffffffffffffffff22ff44500000005555555554ff22fffffffffffffffffffffffffff2ff445550000000444444455554ff2ffffffffffffffffffffffff2ff4515544000000044444444455554ff2ffffffffffffffffffffffff455544440000000444444444444554ff2fffffffffffffffffff2f4550000000544444444444440000000554f2fffffffffffffffffff415410000004444444444444400000014514f2fffffffffffffff2f45544100000044444444444444000000144554f2fffffffffffffff2554441000000444444444444440000001444554ffffffffffffff2f5544441000000444444444444440000001444455f2fffffffffff2f454444410000004444444444444400000014444444f2ffffffffff2454444441000000444444444444440000001444444542fffffffff2f50000000544444400000000000000444444500000005f2ffffffff245000000054444440000000000000044444450000000542fffffff22551000000544444400000000000000444444500000015542ffffff24541000000544444400000000000000444444500000014542fffffff454100000054444440000000000000044444450000001454ffffff2255410000005444444000000000000004444445000000145522fffff25441000000544444400000000000000444444500000014452fffff2500054444441000011f33324444444440000001444444500052fff22500054444441000143cccccf3442444400000014444445000522ffff50005444444100043c7ddda69c33f244000000144444450005fffff40000544444410093c7ddddddda99c3f40000001444444500004ffff500005444444101236ddddddddddda6232400001444444500005ffff50100544444410b337dddd88ddddddd773351011444444500005fff251011544444411b33add89ff97a8ddddd7ff1105444444511015fff454444501000054b33adda33333f677ddd86324450010101444444ff444444100100054b336ddac3333333c6add7224440001001444444ff444444100110044b3398dd79c3c23333c8d8934440011001444444ff44244450111014cb3327ddd893cb9c333add934440011101444244ff444444110101144b93327ddd9344cf3398dd632441001011444444ff4511115444444515b333278d9324339a8ddd635154444445111114ff4111114424222501bcf233c7c32b339dddd89f5154224244111114ff4111114222222515439acc23332b339dddd6341152222224111114ff411111422422211b339dd879cf333398d86cf51152222224111114ff411111422222251b339ddddda66933299932511152222224111114ff411111422222251b339dddddddda66c33334111152222224111114ff411111422222251b33f688dddddddda76f33f51152222224111114ff442222511111142b33333f788dddddddd886332241111115222244ff442222511111142bb2f33333c7ddddddddda93f241111115222244ff4422225111111422bb9233fc968d8678ddda93f241111115222244ff442222511111142f233c996adddd73c97dda93f241111115222244ff442222511111142f33c7dddddddd73336dda93f241111115222244ff4422225111111429339ddddddddda9336dda932241111115222244ff442222511111142b339ddd88abadda937dda932241111115222244ff411111422222251b3398a79f336ddd88ddda935152222224111114ff411111422222251b33c933333337dddddddacf1152222224111114ff411111422222251b33c9933333326ddddd86341152222224111114ff411111422222251b339d899c3333f968d86c251152222224111114ff411111422222251b339dddd766f3332ccc32511152222224111114ff411111422222251b339dddddd877933333f5111152222224111114ff411111422222251b339ddddddddd8aa7233f411152222224111114ff455555444444455b339ddd8a8ddddddd886cff5554444444555554ff442222511111142b339ddd6c67ddddddddda93f241111115222244ff442222511111142b339ddd633cadddddddda93f241111115222244ff442222511111142b339ddd6333add797ddda93f241111115222244ff442222511111142b339ddd63337dd6336dda93f241111115222244ff442222511111142b3398dd63337dd6336dda93f241111115222244ff442222511111142b33337863337dd6336dda93f241111115222244ff444444555555544b232c23c333f29c336dda932241111115222244ff411111422222251bc39d89c3333333336dda934445555555444444ff411111422222251b339ddd79c333fc336dda931152222224111114ff411111422222251b339ddddd76f33233cc77931152222224111114ff411111422222251b339dddddd8763333333fff1152222224111114ff411111422222251b33326a8dddd8a6f33333411152222224111114ff411111422222251bf3333398dddddda93334111152222224111114ff455555444444455bbccf33caddaddddd9c32511152222224111114ff4422225111111422999233cadd99adddd89c341152222224111114ff4422225111111422f33333cadd23c96dddd7c34445555555444444ff442222511111142f33c9996add6999268dda932241111115222244ff455555422222255b339ddddddddddd88ddda932241111115222244ff411111422222251b339dddddddddddddddda932241111115222244ff411111422222251b339dddddddddddddddda93f241111115222244ff411111422222251b339a7666666666666666c3f241111115222244ff411111422222251b332c333333333333333333f241111115222244ff411111422222251b3333333333333333cf333f2241111115222244ff41111142222225199398c2233339b9336a7933f241111115222244ff442222511111144b339ddd7992333f336dda935152222224111154ff442222511111142b339dddddd76633336dda931152222224111114ff442222511111142b339adddddddd886c7dda931152222224111114ff442222511111142b332996adddddddddddda931152222224111114ff442222511111142b3333339968ddddddddda931152222224111114ff442222511111142bbbc333332cc78dddddda931152222224111114ff4422225111111422c9bbb3333332229addda931152222224111114ff44222251111114222222bbbbc23333336dda931152222224111114ff411111422222251115233333cbb9f3336dda932241111115222244ff4111114222222511122c99c2333c92336dda932241111115222244ff41111142222225112398dd876933fc336dda932241111115222244ff411111422222251b339dddddd876cc232c77c32241111115222244ff411111422222251b339dddddddddd8922333332241111115222244ff411111422222251b339ddddddddddddda99c332241111115222244ff411111422222251b339ddd697addddddddd7c3f241111115222244ff455555444444455b339ddd633cadddddddda934445555555444444ff442222511111142b339ddd63337dd76addda931152222224111114ff442222511111142b339ddd63337dd6f26dda931152222224111114ff442222511111142b339ddd63337dd6336dda931152222224111114ff442222511111142b33c9ad63337dd6336dda931152222224111114ff411111422222251b3333c66333c9a6336dda931152222224111114ff411111422222251bb32ccc33333333336dda931152222224111114ff4111114222222519c39dd799c33333336dda931152222224111114ff444444555555544b339ddddd76933333c98a934445555555444444ff442222511111142b339ddddddd8a7bc33322f3f241111115222244ff442222511111142b339dddddddddd8aa72ff332241111115222244ff442222511111142b339ddda6addddddddd8623f241111115222244ff442222511111142b339ddd63c66dddddddda93f241111115222244ff442222511111142b33cadd6333fc9778ddda93f241111115222244ff442222511111142b3337dda9333333297dda93f241111115222244ff442222511111142b93368dda6c3333336dda93f241111115222244ff4422225111111429b3337dddd8722f3f6dda932241111115222244ff4111114222222511bf33cadddddd86c6adda931152222224111114ff4111114222222511bbf33968dddddddddddac31152222224111114ff41111142222225111bbf33f968ddddddddd6321152222224111114ff411111422222251111bbf3332ccaddddddac351152222224111114ff4111114222222511111bbb333332caddd723411152222224111114ff411111422222251111119bbc333332222f34111152222224111114ff45555544444445555555444bbbc333333295555554444444555554ff44222251111114222222111119bcccccc922222241111115222244ff4422225111111422222211111119bbbb5122222241111115222244ff4422225111111422222f4444511111111122222241111115222244ff442222511111142222f3322f241111111122222241111115222244ff44222251111114222f3368dac35111111122222241111115222244ff4422225111111422f336dddd935144242522222241111115222244ff4424245555555422939adddd9353f2ccf332224245555555444444ff4111114222222515336ddd8a9339addd793f511152222224111114ff411111422222251b337dd89923c8ddddd89c251152222224111114ff411111422222251b337dd7333cadddddddd6351152222224111114ff411111422222251b336dd893c7ddddddddd7221152222224111114ff411111422222251b339add8a8dddda9f6ddd931152222224111114ff411111422222251b3336dddddddd863337dd631152222224111114ff455555444444455b2339adddddd8932ccadd935554444444555554ff442222511111142bb3339addddd9339ddddd932241111115222224ff4422225111111422c3333c96dd93339dddd893f241111115222244ff4422225111111422f3c6f333f233c39dddd723f241111115222244ff442222511111142b339d887ccf33f39adda23f2241111115222244ff442222511111142b339ddddd8663333ffff3322241111115222244ff442222511111142b339dddddddd8872c3333f22241111115222244ff444444555555544b33c66adddddddddd9cc3334445555555444444ff411111422222251b33333967dddddddddda9c31152222224111114ff411111422222251b9c33333297ddddddddda931152222224111114ff41111142222225119933333c7addd8adddda931152222224111114ff41111142222225115333777adddddd626a8a931152222224111114ff41111142222225114398ddddddddddd933f9c31152222224111114ff411111422222251b339dddddddd77ddd6c333f1152222224111114ff411111422222251b339dddd8a69327ddd8c3251152222224111114ff44222251111114cb339da76cf333326dddac3f2241111115222244ff442222511111142b3399c33333c33326ddd7c32241111115222244ff442222511111142b33976333f4bb33327dda932241111115222244ff442222511111142b339dda6f33fb9333f7da93f241111115222244ff442222511111142b339ddddd9233c933337a93f241111115222244ff442222511111142b339ddddddd9c32c3332693f241111115222244ff442222511111142b33fc6dddddd89c3c3333332241111115222244ff455555444444455b3333397dddddd7623333455554444444555554ff411111422222251bbc3333cadddddd87c33f511152222224111114ff41111142222225115bb233cadd96ddddd893f51152222224111114ff411111422222251114ff33cadd23c7adddd7c31152222224111114ff411111422222251153fccccaddc2229addda931152222224111114ff4111114222222515339dddddddddddaa8dda931152222224111114ff411111422222251b339dddddddddddddddda931152222224111114ff455555444444455b339dddddddddddddddda935554444444555554ff442222511111142b339d888888888888888a932241111115222244ff442222511111142b33c9f3fff333ff333ff33f2241111115222244ff442222511111142b33f2333333333333f233322241111115222244ff442222511111142bc398ccc3333fccf368ccf32241111115222244ff442222511111142b339ddd79923399c36ddac3f241111115222244ff442222511111142b339dddddd66933336dda93f241111115222244ff442222511111142b339dddddddd876c36dda932241111115222244ff411111422222251b333f688ddddddd888dda931152222224111114ff411111422222251bf33333c67addddddddda931152222224111114ff411111422222251bbcc333333c66adddddda931152222224111114ff41111142222225119bb9cc3333339678ddda931152222224111114ff411111422222251111599b992333332c7dda931152222224111114ff411111422222251114333ccc9bbc33336dda931152222224111114ff411111422222251153979c23f22bb9336dda931152222224111114ff4444445555555449339ddda7c333fc336dda934445555555444444ff442222511111142b339ddddd888cc233c98a93f241111115222244ff442222511111142b339dddddddddd799f3fcc32241111115222244ff442222511111142b339ddddddddddddd69c3332241111115222244ff442222511111142b339ddd76addddddddda6c3f241111115222244ff442222511111142b339ddd73227dddddddda93f241111115222244ff442222511111142b339ddd73337dda7addda93f241111115222244ff444444555555544b339ddd73337dd63c7dda934445555555444444ff411111422222251b339ddd73337dd6336dda931152222224111114ff411111422222251b339ddd73337dd6336dda931152222224111114ff411111422222251b332cc873339986336dda931152222224111114ff411111422222251b333332c3333322336dda931152222224111114ff411111422222251b939899c333333ff36dda931152222224111114ff411111422222251b339ddda6cff33f2397da931152222224111114ff411111422222251b339dddddd87cc2333366931152222224111114ff442222511111142b339ddddddddd879c3333332241111115222244ff442222511111142b33f26a8dddddddda76c2332241111115222244ff442222511111142bc3333326addddddddddac3f241111115222244ff4422225111111429bc333333268dddddddda93f241111115222244ff4422225111111422cb9232229add796addda93f241111115222244ff442222511111142ff32ccadddddd7339adda93f241111115222244ff442222511111142f339ddddddddd7f336dda932241111115222244ff4515554444444559339dddddddddd7236dda935554444444555554ff411111422222255b339dddda697dd8697dda931152222224111114ff411111422222251b339887ccf3c8dd88ddda931152222224111114ff411111422222251b33cc33333cc7dddddddac31152222224111114ff411111422222251b33333fc2cbbf68dddd86341152222224111114ff411111422222255bc3c933339bb33c6ad893251152222224111114ff411111422222251523cbbb297e7333fccc32511152222224111154ff4544544444444445433bb77bee72333333f5445444444444455454ff4422225111115422f333b7eeeeeb9c33c422222241111115222f24ff422222511111142223332b7eeeee7bc32522222241111115222224ff44222251111114222f339beeeeeeebbcf522222245111115222244fff4222251111114222f3fb7eeeeebcc33512222224111111522225ffff522225111111422233bbeebee733324512222224111111522225ffff522225515111422f3cbbbcb7e73f511152222224511115522225ffff254244555555422f3cbf33cb7b35555554422224555555422452fffff5555222222255533333333cbb32ff222555555522222245555ffffff55514222222555332455233cb3222222515515522222245555ffffff45554222222555555555523333222222555555522222245554ffffff255542222225555555555523f3222222555555522222245552fffff2255542222225555555555554522222225555555222222255522ffffff455422222255555555555555222222255555552222222554fffffff24554222222555555555555552222222555555522222245542ffffff2f4445555554222222222222455555542222224555555444f2fffffff244555555522222222222222555555522222225555555442ffffffff2f45555555222222222222225555555222222255555554f2fffffffff2f555555522222222222222555555522222225555555f2ffffffffff2f455555522222222222222555555522222225555554f2fffffffffff2f4555554222222222222255555552222222555554f2ffffffffffffff2555554222222222222255555552222222555552fffffffffffffffff25444444444444444444444444444444444454fffffffffffffffffff242255555555555555222222255555552242fffffffffffffffffff2f2425555555555555522222225555555244f2fffffffffffffffffffff44555555555555552222222555555544f2fffffffffffffffffffff2f245555555555555222222255555542f2fffffffffffffffffffffff22245555555555552222222555554222ffffffffffffffffffffffffff222f45555555552222222554222ffffffffffffffffffffffffffffffff2fff55555555555555fff2fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", 56, 234]; // one placeholder shared by all four created skaters
  const ART = [
    ["Hawk", "#c0262c", "f8f8f0 e2ded3 c2beb7 8f8c88 55534f 1c1c1c 140515 df1c24 b0141c 8c0f18 e0484f", "1111111111111111111111111111111211111111111111111111116666666666661111111111169898888988896111111111687777777777778611111111677777777777777611111110066666977796666601111100000006977796000000111100000006977796000000111100000006977796000000111000000006777796000000011000000005aaaa85000000011000000005aaaa85000000010000555555aaaa855555000000058aaaaaaaaaaaaaa85000000697777777777777796000000697777777777777796000000697777799999999996000000697777796666666660000000697777777966600000000000066977777779966000000000006667777777796600000000000069777777777960000000000069777997777796000000000069777969777776000000000069777969777776000000000069777997777796000000000069777777777960000000000669777777796600000000006677777779666666000000069777777966697796000000467777799977777796000000467777777777777796000000467777777777777796000000467777777779966666000000467777796666600000000000467777779666660000000000069777777777796600000000006977777777777860000000000666677777777796000000000000066668777776000000000000666697777776001000000066677777777776001000000687777777777786001000006977777777777860001000069777777779866600000000467777779666600000000000467777777996666600000000067777777777798666000000026777777777777796000000006697777777777796000000466666669877777796000000467777777777777796000000467777777777777796000000467777777777777796000000467777777777777796000000469998997779989996000000036666677779666660000000000006977777960000000000000069777777796000000000000067777777776600000000000697777977779600000000006677777677777860000000036777779697777766000000069777776667777796000000367777796069777776000000367777760006777776000000367777960006877776000000367777600000677776000000367778600000697776000000367776000000067776000000367796000000068776000000367760000000006776000000368660000000006686000000366600000035555553000000000000004500000000500000000335535055555000500000005053050050005000500200050530050050050003312200505510350005500003012211515115551115411131112216164566661114111141112116166126621112111411111126116164611161111111321121611636111166111113121112333351111116611111211112111111111113366666211111131111111133611112111111126663333336111121111111112211666661112211111111111122111111221111111111111111222222111111111", 24, 92],
    ["Brazil", "#f2d21b", "1e8f3a f2d21b 1f3d8c ffffff", "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000011000000000000001100000000000001111000000000000111100000000000111111000000000111111110000000011111111000000011222222110000001222222221000001222232222210001122222222221100112223333222110011333222233311001122222223221100012223222222100000122222322100000011222222110000000111111110000000011111111000000000111111000000000001111000000000000111100000000000001100000000000000110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"],
    ["Gold cat", "#e8b008", "b42000 a31302 951401 d73d1d c42a0c 1e0c12 e8b008 c09010 8a6210 543a17 7a0a14", "33333333333333333333333333333333333333333333333333333333333333331111111111333333333333333333333333333333333111111111111111133333333333333333333333333331111111111111111111133333333333333333333333311111111111111111111111133333333333333333333311111111111111111111111111333333333333333333311111111111111111111111111113333333333333333311111111111111111111111111111133333333333333311111111111111111111111111111111333333333333311111111111111111111111111111111113333333333331111111111111111111111111111111111333333333331111111111111111111111111111111111113333333331111111111111111111111111111111111111133333333111111111131113113131313131131131111113333333311111113111113131111111111111111111111333333311131313131313131313131313131313131313103333333131313131313131313131313131313131313131333333131313131313131313131313131313131313131313333131313131313131313131313131313131313131313333331313131313131313131313131313131313131303133331313131313131313131313131313131313131313133333313131313131313131313131313131313031303130333333333333333333333333333333333333333333333333333033333333333333333333333333333333333333333333033333333333333333333333333333333333333333033030333333333333333333333333333333333333303033300303033033333333333333333333333333333033030330303033333333333333333333333333333333033030033000030030303030303030303030303030303030030003300000000003030313030303030303030303000000000330000000000030303030303030303000300000000000033000000000000000050000000000500000000000000003300000000000000000500000000500000000000000000330000000000000000500000000005000000000000000033000000000000000000000000000000000000000000003300000000000000000000000000000000000000000000330000000000000000000000000000000000000000000033000000000000000000000000000000000000000000003300000000000000000000000000000000000000000000330000000000000000000000000000000000000000000033000000000000000000000000000000000000000000003300000000000000000000000000000000000000000000330000000000000000000000000000000000000000000033000000000000000050000000000500000000000000003300000000000000000500000000500000000000000000330000000000000000000000000000000000000000000033000000000000000000000000000000000000000000003300000000000000000000000000000000000000000000330000000000000000000000000000000000000000000033000000000000000000000000000000000000000000003300000000000000000000000000000000000000000000330000000000000000000000000000000000000000000033000000000000000000000000000000000000000000003300000000000000000000000000000000000000000000330000000000000000000000000000000000000000000033000000000000000000000000000000000000000000003300000000000000000000000000000000000000000000330000000000000000000000000000000000000600000033000000060000000000000000000000000600000000003300000060000000000000000000000000000000000000330000000000000055000000550000000000000000000033000000000000005650000595000000000000000000003300060000000000566500599500000000000000002000330066600000000056965559950000000000000000200033000600000000005698698855000000000000000122003300000000000005569867667850000000000000002000330000000000005588666556668500000000000000000033000000000000586666685168150000000000000000003300000000000586668666925866500055550000000000330000000000587885686667668550055675000000000033000000000056588566868556659055668500000000003300000000005578855566558557505668550006000000330000000000588688585586585550568550000000000033006000000556686685995876650056850000000000003300000000058686668899955550005675000000000000330000000005686886886955550000556655000000000033000000000568866886875795550005867555000000003300000000058856688685876885500055776550000000330000000005575686685966667655000555675500000033000000000055858665886666666655000556655000003300000000005589586586666866666655005568500000330000005555559885858666868666666550056850000033000005567688598858586686566666665055685000003300005566688885988858668558858666855785500000330000578685558959899586665956666688885500000033000056565505595559958668556666688855500000003300005858500005550555868855666688855000000000330000055500000000005566859566688885000000000033000000000000000000556685955866885500000000003300000000000000000556665555558665500000000000330000000000000005576668558666665500000000070033000000a000000005656565586566555000000000000033000000a00000000585858505555550000000000000003300000a4a000000000000000000000000000000007000330600000a000000000000000000000000000000000060330600000000000000000000000000000000000000070033006000000000000000000000000000000000000070003300070000000000000000000000000000000000070070330600607000000000000000000000000000000060700033000660600000000000000000000000000000066660703300666666000000000000000000000000000066660600330006616600000000000000000000000000006160660033000066a000700000000000000000000007000706600033000000000000000000000000000000000000000000003300005500000000000000000000000000000000555000330005665000000000000000000000000000000566650033005668650500000000000000000000000055086865003300565565565000000000000000000000556658656500330056505566755550000000000000055556566565650033005650056565666500550050055056675658756565003300566558656565665566556505655685566655786500330058665666656586586655650565568558656586500033000955565565666556565565056558665565655500003300000058556565665656556505650565556585000000330000000505656556566685650565056555855000000033000000000585658658586565056555666550000000003300000000005586656858656555667568550000000000330000000000005555650565666586855500000000000033000000000000000055058586855550000000000000003300000000000000000005555550000000000000000000330000000000000000000000000000000000000000000033000000000000000000000000000000000000000000003300000000000000000000000000000000000000000000330000000000000000000000000000000000000000000033000000000000000000000000000000000000000000003300000000000000000000000000000000000000000000330000000000000000500000000005000000000000000033000000000000000005000000005000000000000000003300000000000000000000000000000000000000000000330000000000000000000000000000000000000000000033000000000000000000000000000000000000000000003300000000000000000000000000000000000000000000330000000000000000000000000000000000000000000033000000000000000000000000000000000000000000003300000000000000000000000000000000000000000000330000000000000000000000000000000000000000000033000000000000000000000000000000000000000000003300000000000000000000000000000000000000000000330000000000000000050000000050000000000000000033000000000000000050000000000500000000000000003300000000000000000000000000000000000000000000330000000000000000000000000000000000000000000033300000000000303030030303030303030000000000033303000000303033333333333333333333030303000030333130303333333333333333333333333333333303031333030333333333333333333333333333333333333330303331333333333333333333333333333333333333333313330303333333333333333333333333333333333333303033313131333333333333333333333333333333331313133333231303133333333333333333333333333130313133333131313131313131313130313313031313031313131333332323231323132313131313313232313232313242333332323232323232323232313423232323231323132323333423232323232324232323424232323232323232314333324232323232323232323203232323232323242424233333242423232323242323232042323232423232324233333322024242324242424242422424242424241420223333332224242423242424242424424242424242422222333333122222224242422242424224242424242422222033333332222222222222422424242242222222222222243333333222222222222222222222222222222222222214333333332222222222222222222222222222222222223333333333222222222222222222222222222222222222333333333342222222222222222222222222222222222433333333333222222222222222222222222222222222143333333333332222222222222222222222222222222243333333333333322222222222222222222222222222233333333333333334222222222222222222222222222243333333333333333334222222222222222222222222443333333333333333333342222222222222222222222433333333333333333333333442222222222222222223433333333333333333333333333333322222222223333333333333333333333333333333333334444444444333333333333333333", 46, 173],
    ["Campbell", "#f04010", "e0b00c 0c0c0e f04010 b88a0c d09018 101438 142a5c f0c050 f8c818 f07020 c8a020", "11111111111111111111111111111111111111111111111111111111111111111111111111111177777777777711111111111111111111111111111111111111117777733333333337777711111111111111111111111111111111117773333333333333333337771111111111111111111111111111117773333333333333333333333777111111111111111111111111111773333333333333333333333333377511111111111111111111111773333333333333333333333333333337711111111111111111111177333333333333333333333333333333337711111111111111111117733333333333333333333333333333333337711111111111111111773333333333333333333333333333333333337711111111111111177333333333333333333333333333333333333337711111111111115733333333333333333333333333333333333333337111111111111177333333333333333333333333333333333333333377111111111111733333333333333333333333333333333333333333471111111111167333333333333333333333333333333333333333333771111111113733333333333333333333333333333333333333333333771111111137333333333333111111333333333333333333333333337711111111aa3333333333115566661113333333333333333333333337311111117a3333333331562222226661111333333333333333333337711111117a333333331652000000022256511133333333333333333771111114a3333333311620000000000002226511113333333333333373111117a3333333115200000000000000002225611133333333333377111117a43030321152000000000000000000002256113303030303771111173333332111520000000000000000000000026513333333333711111844303021115200000000000000000000000092510303030307111177333333211152000005652220000000000000002613333333373111a344303021115200002615665222000000000000025103030303311174400303211152000025111166662222000000000051303030303111734430302111520000025661111165662220000000261303030331117044030321115200000022555611111655632000000210303030311173333030211165200000002226111111111655000002130303043111704403032111152000000000061211111111152000021030303031117343303022111552000000000512216656611620000213030303311170000000021111562000000005121162222656000002100000003111a344303032211116520000000512115200020000000213030303a1117000000000215561566200000512115200000000000210000000a111a344303030215226566652200512115200000000002213030303a1117000000001115202225555622612115200000000002510000000a1118000000021115200002256665612115200000000025100000000a1118000000021115200000022665112116222000000255100000000a1117000000021115200000000222561116665222222661000000000a1117000000021115200000000000226511111565555110000000000a1117000000021115200000000000002256111111111100000000000a1117000000021116222000000000000022255111111000000000000a11170000000211115562200000000000000226511200000000000003111700000002211111566220000000000000022661110000000000031117000000002211111155620000000000000000226511000000000a1117000000000222111111620002200000000000002255100000000a1117000000000002222111620002522000000000000022510000000a1117000000000011111111620002555622200000000000250000000a1117000000000115566556520002511655622000000000250000000a1117000000001115222222220002656665565520000000250000000a1117000000021115200000000000000000022222000000250000000a11180000000211152000000000000000000000000000002500000003111700000002111520000000000000000000000000000025000000031117000000021115200000000000000000000000000000250000000311170000000211152000000000000000000000000000002500000003111700000002111522222222222200000000000000000025000000031117000000021115656655555665222222222222222222250000000a11170000000211155566555566655665555555555555556500000003111700000002211522225611111111111111111111111110000000031117000000002115200022256551111111111111111111000000000311170000000211152000000222256611122222222222200000000003111700000002111520000000000222265611100000000000000000031118000000021115200000000000002222565111100000000000000311170000000211152000000000000000002222655111100000000003111700000002111522000000000000000000002222655111000000031117000000021116662222000000000000000000002225550000000a111700000002111111555522220000000000000000000225000000031117000000022111111111555552200000000000000000250000000311170000000022156655566655665552220000000000002500000003111700000000021522222222222222222222000000000025000000031117000000001115200000000000000000000000000000250000000311170000000211152000000000000000000000000000002500000003111700000002111520000000000000000000000000000025000000031117000000021115220000000000000000000000000000250000000a1117000000021111552200000000022222222222222222250000000a1118000000021111156522000000000225665565555565550000000a111700000000211556555522000000000226561111111110000000031117000000002115222556552290000000022655111111100000000a1117000000021115202225556552200000000226551220000000000a1117000000021115200002222655622000000002266110000000000a1117000000021115200000000222255220000000022551100000000a1117000000021115200000000000022222200000000225610000000a1117000000021115200000000000000002220000000002250000000a1117000000021115220000000000000000000000000000250000000a1117000000021115552220000000000000000000000000250000000a1117000000021111156552222000000000000000000000250000000a1117000000022115561115655222200000000000000000250000000a1118000000002115222555111566622220000000000000250000000a1118000000021115200222255111156552222000000000250000000a1118000000021115200000022265511115555222200000250000000a1117000000021115200000000022225651111555522200250000000a1117000000021115200000000000002222566111155522250000000a1117000000021115200000000000000000222656611165550000000a1117000000021115220000000000000000000222265651100000000a1117000000021116552220000000000000000000022255510000000a1117000000021111155652222000000000000000000022250000000a1117000000022111111115565222000000000000000000250000000a1117000000002222111111115552000000000000000000250000000a1117000000000002222111111152000022220000000000250000000a1118000000000000002222211162000025652222000000250000000a1117000000000000000002221162000025155665520000250000000a1118000000000000000000021162000005511111520000250000000a1117000000000000000000021155200002555111520000250000000a1117000000000000000000021115200000225655500000250000000a11180000000000000000000211162000000002222000002500000003111700000000000111a000021111520000000000000000250000000a111700000000001555111a022111520000000000000000250000000a11170000000001152225551121111552000000000000025100000003111700000000111520222256551111662200000000002610000000031118000000021115200000222255551656220000000256100000000311170000000211152000000000222256555652222226510000000003111700000002111520000000000000222556555555511000000000031118000000021115200000000000000002222555511100000000000311170000000211152000000000000000000002222666510000000003111700000002111520000000000000000000000002225551000000031117000000021115200002220000000000000000000022250000000311170000000211152000025522200000000000000000002500000003111700000002111520000255555222000000000000000025000000031117000000021115200002511155520000200000000000250000000311170000000211152000002611116200002229200000002500000003111800000002111520000025551162000025665222000025000000031118000000021115200000022565200000251115520000250000000311180000000211115200000002220000002551115200002500000003111800000002211152000000000000000002551152000025000000031117000000002111552000000000000000002556200000250000000311170000000021111529000000000002000000222000002500000003111800000000021111552000000000022000000000000025000000031117000000000221111552220000002550000000000000250000000311170000000000156651155522222251650000000000025100000003111700000000011522256566555565111620000000002510000000031117000000001115200222565651111111522000000251100000000311180000000211152000002222566561111562222226510000000003111700000002111520000000002222555111155555511000000000031117000000021115200000000000002226556511111100000000000311180000000211152000000000000000022225555110000000000003111800000002111520000000000000000000022226551110000000031118000000021115200000000000000000000000022265510000000311170000000211152000022200000000000000000000222500000003111700000002111520000255222200000000000000000025000000031117000000021115200002555566200000000000000000250000000311180000000211152000025111162000022000000000002500000003111700000002111520000251111520000252222000000025000000031117000000021115200002512115200002555552220000250000000311180000000211152000025121162000025111155200002500000003111800000002111520000251211620000251111152000025000000031117000000021115522002512115200002522111520000250000000311170000000211115652225121162000025021115200002500000003111700000002211111565561211652220250211152000025000000031118000000002215655111102111655622502111520000250000000311180000000002152225555111111116555021115200002500000003111800000000011520022225551111111100211152000025000000031117000000021115200000022265551110002111522000250000000311170000000211152000000000222265511121116522222500000003111700000002111520000000000000222256551115655225000000031117000000021115200000000000000000222555111115550000000311170000000211152000000000000000000002222551111000000003111700000002111520000000000000000000000022226561000000031117000000021115200002220000000000000000000022260000000311170000000211152000025522220000000000000000002500000003111700000002111520000256655622220000000000000025000000031118000000021115200002511111655522200000000000250000000311170000000211152000025111111111665222200000002500000003111700000002111520000251221111111115656222000025000000031118000000021115200002512222211111111155552222250000000311180000000211152200025100022222111111111165565500000003111800000002111555222251000000022222111111111111000000031118000000021111156555510000000000222222111111100000000311180000000221111111111100000000000000222221110000000003111700000000221565655111000000000000000000222000000000031117000000000215202225666111000000000000000000000000000311170000000021152000022226661111000000000000000000000003111700000002111520000000022256651110000000000000000000031117000000021115200000000000222256611110000000000000000311170000000211152000000000000000222255511110000000000003111800000002111520000000000000000002222265611100000000031118000000021115200000000000000000000002222655110000000311170000000211152000022200000000000000000002222600000003111700000002111520000255222000000000000000000025000000035118000000021115200002556662222000000000000000250000000311180000000211152000025111156552220000000000002500000003111800000002111555000251111111566522200000000025000000031117000000021115556002512111111115556222000000250000000311180000000211152255025125561111111115552220002500000003511800000002111528255251552252111111111165522226000000035117000000021115288256552282622221111111111555650000000351170000000211152888256298226002222211111111111000000003111700000002111528888228882600000022222221111100000000031117303000002115228888888926000000000022222111003030000311170004030322256288888882610000000000000022200000003033511704000000025622809988826500000000000000000000303003031117343403033552988999988825603030303003030303030030303351170400003255298888998888825500000000000000000003030303511733340325598888888888888826503030303303030300303030331117030039252299999988899988825303000000303000030303030311173433022255655592888222222250303030030303003030303033111734043022222225698892555556630303003030300303030303031117733403033030225288256222203030303303030330303030337651117330303303032252882503030303030330303033030303033371111173333330303322599255030303030333030303033330333333a1111173333333030322552550303030303030303033330303333333a111114a3333333333022556333333333333333333303333333333303111111a33333333333222303030303030303030303333333333333a1111111a33333333333333333333333333333333333333333333333a1111111773333333333333333333333333333333333333333333337a1111111503333333333333333333333333333333333333333333337111111115033333333333333333333333333333333333333333333371111111113433333333333333333333333333333333333333333330351111111114333333333333333333333333333333333333333333371111111111173333333333333333333333333333333333333333337a1111111111133333333333333333333333333333333333333333337111111111111573333333333333333333333333333333333333333711111111111111773333333333333333333333333333333333333377111111111111111773333333333333333333333333333333333337711111111111111111773333333333333333333333333333333333771111111111111111111773333333333333333333333333333333377111111111111111111111773333333333333333333333333333337711111111111111111111111777333333333333333333333333337771111111111111111111111111577333333333333333333333333771111111111111111111111111111117773333333333333333337771111111111111111111111111111111111777733333333333377771511111111111111111111111111111111111113777777777777311111111111111111111111111111111111111111111111111111111111111111111111111111", 56, 224],
    ["New wave", "#2fb8b0", "201d24 2e2b31 46382f 110e17 18151d f7a82a 6e5031 26bcb5 6facb7 51545d b27a26 77818b 9e7c60 15819d 98cacc", "cccccccccccccccc26cccccccccccc62ccccccccccccccccccccccccccccc166c6222222222222ccc2cccccccccccccccccccccccccc2c62000000400000000026c2cccccccccccccccccccccc2c60000000004040000040000cc2ccccccccccccccccccc2c10040000400404400000004002c2ccccccccccccccccc6c1001400404004044004040040001c6ccccccccccccccc6c100004004044041440440400414001c6ccccccccccccc6c14004040040440304404404000040042c6ccccccccccc2c2040040440403443033443040440400402c2cccccccccc62004044034430344303344303443040040066ccccccccc66000404403443034430334430344303404000c2ccccccccc20043033034430344303344303443033040042cccccccc2c04043033034430344303344303443033034040c2cccccc620344303303443034430334430344303303444026ccccc2c0034430330344303443033443034430330344410c2cccc26403443033034430344303344303443033034430462ccccc240344303303443034430334430344303303443042ccccc60303443033034430344303344303443033034430306ccc6633034430330344303443033443034430330344303466cc6243034430330344303443033443034430330344303326cc6204034430330344303443033443034430330344304026c2c10003443033034430344303344303443033034430001cc2610000443033034430344303344303443033434441001cc2610010000033034430344303344303443033000001111cc261111001004003043034430334430344404000111111162c9111111101000004404403033044040001011011111119cc1111111111111110010010140000101111111111111111cc1111111111111111111110111111111111111111111111cc0101101111111111111111111111111111111111010010cc0100101001101111111111111111111101001000010010cc0100000001001010010110100100100001000000010000cc0000000000001000010010100000100041000000000000cc0040000000441400004000144004000040000004400400cc0040040000440404404404033444040440440400400400cc4044044040330344304443033444034430340304304404cc4044034430330344301443033441034430330344304404cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344301443033441034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344303303cc3033034430330344303443033443034430330344343303cc30330344303303043034430334430344303303443b9303cc3033034430330344303443033043034430330344be4303cc3033034430330344303443033401104441330318893303cc3033034430330344304b23449b88e144984301bd803303cc303303443099034430b839888d8b224088130bdd843303cc3033034433bb43444bdb18ddd81989318db308d8203303cc3033034433880344bd8228d883bddb3bddb3bddb303303cc303303443bddb333ed838ddb339dd818dd81ed89303303cc3033034438dde43bdd918d80333ed89ddd8b8d81303303cc3033034438dd813edd998d88e94ed88ddddeddb3303303cc30330344bddddb18d848ddd8b338d88de7d7d813303303cc303303448ddddebddb08dd89333bddd798ddd843303303cc30330339dd88d88d8997de13333bddd808dd7b44303303cc3033033bddb8dd7d818d7b3333397d7b3bdde444303303cc30330348d89bddddb18d89bb9143ed813977b344343343cc3033039dd84b7dd8097d77dd7ee0ed8330eb1330218eb2cc303303bd7b33edd838dddd78e943b893339239bee8e813cc3033027d80338d7918d788b333339e03349e1e777e9303cc30330b7db433bde49e8b0439333329333be2b777e43303cc3033487b3033288499010b4e93333334b7e1878b003303cc30334eb330333eb331e2be1b8933433b77b0e7e4343303cc3033bb3330bb384328e387227e93439e7e1b77e99e9303cc303309bb33e83439879287b187e343b778187777893303cc3198e77e398e331e7e087783878143e78998dd8b403303cc2be8777e3b7793b77b4e77e0b77b3977818dd893303303cc3012b77e0877b18789b7887b98de4bdd918d8244303303cc3033b77e9777eb77e3e7be7838d80ed829dd8431443303cc3033b77e8777ee78928d88d83bddeddb4bdd89be8bb243cc3033b77e78e787d80bddd8dd99dd8d7228dd8ddd88e943cc30334e7778bddddb38d8998db3eddd809dddd8e8b33303cc30330edddbbddd82bddb33bd83bddd93edd88b23303303cc303308dd8148ddb38d814398d99dd801eeb93343303303cc30330bdd844eddb9dd944338d908db49b0334344303303cc303309dd9038d81b8b3443408b388b4330330344303303cc303309d83038880ee03443039e0be34430330344303303cc303300893030e29e403443033b12934430330344303303cc303303e23030e320303443033433434430330344303303cc3033032330330343303443033433034430330344303303cc3033034430330343303443033443034430330344303303cc3033034430330222042202022322022224330344303303cc3033034430336555565a656553a5655550330344303303cc30330344303365a5565a656552a5655664330344303303cc303303443033656a565a656556a565a333330344303303cc303303443033656a565a65655aa565a333330344303303cc303303443033656a565a656555a565a333330344303303cc3033034430336555525a65655555655563330344303303cc3033034430336555a25a65655a55655a23330344303303cc303303443033656a565a6565525565a333330344303303cc303303443033656a565a6565515565a333330344303303cc303303443033656a565a656553a565a333330344303303cc303303443033656a565a656553a565a224330344303303cc303303443033656a5655556553a5655550330344303303cc3033034430332626602666366366266664330344303303cc3033033430333333333333333333333333330344303303cc30332aaa06a0336aa2aaaa2aaa4aaa2aaa20aaa1303303cc30335555aa523365565555655565556555aa5555303303cc30335505aa523345a25a006565655045aaaa5255303303cc30335505aa523345a15a336565655335aaaa5055303303cc30335545aa523345a15a336565655335aaaa50aa303303cc303355222a523345a15a206565655235aaaa5222303303cc303355a5aa523345a155526555055505556a5655303303cc30335525aa523345a15a6065a5655645a5aa5255303303cc30335505aa523345a15a336525655335aaaa5055303303cc30335545aa523345a15a336525655335aaaa5055303303cc30335545aa523345a15a336525655335aaaa5055303303cc303355a5aa5aa665525a3365a5655a25aaaa5a55303303cc3033a555aa555aa5565a336555255565aaa6555a303303cc3033001140001100141033010130014100031114303303cc3033034430334433443443443443443344330343303303cc3033034430334433443443443443443344330344303303cc3033034430334433443443443443443344330344303303cc3033034430334433443443443443443344330344303303cc3033034430334433443443443443443344330344303303cc3033034430334433443443443443443344334344303303cc3033034430334433443443443443443344330344303303cc3033034430334433441443443441443344330344303303cc3033034430334433440443443440443344330344303303cc3033034430334433443443443443443344330344303303cc3033034430334433443443443443443344334344303303cc3033034430334433443443443443443344334344303303cc3033034430334433443443443443443344334344303303cc3033034430334433443443443443443343334344303303cc3033034430334433443443443443443344334344303303cc3033034430334433043443443443443344330344303303cc3034034430334433043443403443403304340344303304cc4034034430444044044404404044404404440404303304cc4044040040440044004004004044004404440404404400cc4044040041440044001004004001004400400400404400cc0144040001000000101010000101010010001000414410cc0140100101001100110110110100110011001010010010cc0100101101001100110110110110110011011011010011cc1100111111111111111111111111111111111111110011cc1111111111111111111111bb1111111111111111111111cc111111111111111111111b119111111111111111111111cc11111111111111111111b1111b11111111111111111111cc11111111111111111119211111b1111111111111111111cc2111111111111111119bbbbbbbb9111111111111111112cc21111111111111111bbbbbbbbbbbb11111111111111116c62100101111111111bbbbbbbbbbbbbb111111101101101666210010010111111b9bb9b9999bb9b9911111101001001666610000000100009b00b1909b9990b1b91000100000001c22c04000000000091b01119412911190b29000000000000cc2c04444444040901b091494bbb30931b24904004404440cc1c14444444439131b2bb2b229b19b09b23094444444442cccc63444444431bbb31101011111399919bb234444444466cc6633333344341bb0199991b91919b909b24344333333c2cc2c333333333331b14b99b19b29b4b909933333333333c1cccc133333333333294911922221239999333333333331ccccc66333333333333292229922999299933333333333366cccc1c3333333333333113333333333123333333333334ccccccc613333333333333193333333319333333333333326cccccc2c33333333333333191433419933333333333333c2cccccccc2333333333333331bbbbbb9333333333333332ccccccccc2c3333333333333331bbbb2333333333333334c2ccccccccc663333333333333331bb933333333333333366cccccccccccc1333333333333333193333333333333332ccccccccccccc2c33333333333333333333333333333334c2ccccccccccccc2643333333333333333333333333333462ccccccccccccccc66333333333333333333333333333366ccccccccccccccccc664333333333333333333333333466ccccccccccccccccccc6c233333333333333333333332c6ccccccccccccccccccccc1c6033333333333333333306cccccccccccccccccccccccccc6cc6033333333333316cc2cccccccccccccccccccccccccccc26ccc62222226ccc62cccccccccccccccccccccccccccccccccc1cccccccccccccccccccccccccccc", 48, 182],
    ["Old timer", "#3c3450", "e9e4fd e7e2fc d2cae5 3b3e42 6f7771 5c675b 4f5953 43454c 302e36 19161f 231c29 aeaeac 180522 2c2431 898d88 d6cee8", "ffffffffffff222222222fffffffffffffffffffff222000000000222fffffffffffffffff20000000000000002ffffffffffffff220000000100000000022ffffffffff4e000000000110000000000e4ffffffffe20000000110011011000002bfffffff2f0000001111011111100001012fffff21100111111111111111111101012ffff21001110101111111111110111012ffff10001111111111111111111111011fff2101011111011111001101111110012ff2110010001010001101101101111112ff2100111011111011101111101111112f2000101111001011110111110101010022000010011011111111011110101100122000100010111111111101111111110122000000000000000000000000000000022000000000000000000000000000000022000000000000000000000000000000022000000000000000000000000000000022000000000000000000000000000000022000000000000000000000000000000022000000000000000000000000000000022000000000000000000000000000000022000000000000e01000e0000010110012200000000000120000120000000010012200010011001001000100001110010112200111111111111001001111111111102201111111111111111111111111101112200101111111111111111111101101112201111111111111111111101111100112200100111111100110000e222211001022001111111101a11101d2bb4e2221100220101110111112011012bbbbbee4b10022010010111111001101142bebbb466102200011111111100100107465bb4466f0220111111111111111101e5bb55b56e0122011111111111111110c5eeb5e4484112200111111111011111c2eeeeb23ab00122001111111111ccccc3225e55edb00112201111111101c33333922e5e5a01011022100100cccc83338839222ded1000000220111cc7773888888d8b22aa1000000022010c77777888888a98e2249101101002201c7788378d9989998e22e3c01000002211c7778887d9999998e2499c11100012210c788788899899998e9949c01110002210c77788899d999a8594bb9c00110002211c877788989999a8e4bb59c111111122110c7888888999d885e5559c111011022000c777388899896e555b39c111011022001c88778889d9ebb5ee299c0110110220010c88888889222b5e2299c1110111220010c8837889b222b9bb599c1110111220001c888889b22bbe9b4999c101001122000c888888bbbbbbe9e4999c001001022000c888887abbbeee9e5999c001000022001c888378daeee45959998100100012200c888888875a5538499999100110112211c888888775a999999999d101100012200c878888873e399999999df11100102201c8788888eeee3d999999ac10100112201c87883786e66e46999998d90101112201c77789cee7ee565119998c5eb20012211ccccc85eeee5e4511000c55d4b000220085385676e66635e000000a4d5b0102200057e54ee5ee34b000000000ab000022001676765e56434b001000000ab00102200005e54e666667e000001000ab00012200005454ee5e576e000000010a200002200115666e555776e100100100ae1000220010e4455555737e000100100a6b010220000e5eeee5e537e000001000886000220000e6ee4565737e00010100018d000220000e5ee5654735e00100000004d00022010066eee5ee655e0010010010ed000220100e5ee5656646e0001010000ed000220000e5ee55e5656e0000000001ed00022000015eee5ee36e10000000100ed0002200010666776735101001100100ed00122001005ee5ee467001001100000ed011220000e6ee5ee635100010000100ed310220000e666766355100010011100edd00220000e4ee5ee5661000000000001bd0022000066ee5ee37e1000000000001fd00220000e66766675e1000100000001fd00220000e5ee64473e1010010000001fd0022000055556443310000000000000fd00220000e67733337100000010001000d01220000e5ee64433100000000000000d00220000555664483100000000000001d00220010e67738373211110111110001800220010e6ee64466eebee1101110101810220100566665365ee45f1101000101800220000e67737588881000001000001800220111e5ee64470010000000100001800220000634664780010000000000001d002200001e3333eb01000000010000000012200010844eb2ba10000a0100000000002200110838342b2be460001101001000022001000011333861000011011001001022011000101011000000011011011011022011011111011010110110010011010022011010101111110000111110010011022000011011000101010101110000010022001011111011101100100100010010022000010010001900000901100000100022000010110000000000001000101100022001111101110111001010011001100122001001000011110100011000011000022000100000000010000000000000000022111111111111111111111111111111122111111111111111111111111111111122fffffffffffffffffffffffffffffff22fffffffffffffffffffffffffffffff22fffffffffffffffffffffffffffffff2f2fffffffffffffffffffffffffffff2ff2fffffffffffffffffffffffffffff2ff2fffffffffffffffffffffffffffff2fff2fffffffffffffffffffffffffff2ffff2fffffffffffffffffffffffffff2fffff2fffffffffffffffffffffffff2ffffff2fffffffffffffffffffffffff2fffffff2fffffffffffffffffffffff2ffffffff2fffffffffffffffffffffff2fffffffff2fffffffffffffffffffff2fffffffffff22fffffffffffffffff22fffffffffffffb2fffffffffffffff2bffffffffffffffff2fffffffffffff2ffffffffffffffffffff22fffffff22ffffffffffffffffffffffff2222222fffffffffffff", 33, 131],
    ["Cap bird", "#d01020", "11a245 3ab45c 0e753a 14a045 0c1a14 070610 c3071b 4f381f 975d0f 090814 f3c905 08060c d9e0e2 2f5371 1a0c10 c06d04", "1111111111111111111111111111111111111111111111111111111111111112222222222221111111111111111111111111111111322222222222222223111111111111111111111111113222222222222222222223111111111111111111111112222222222222222222222221111111111111111111112222222222222222222222222211111111111111111112222222222222222222222222222111111111111111112222222222222222222222222222221111111111111112222222222222222222222a22222222211111111111112222222222222222222222aa2222222222111111111112222222222aa22222222222aa22222222222111111111122222222aaaaa2222222222a2222a2a22222111111111222222aaaaa22a222222222aaaa2aa2a2222221111111222222aaa2a222a222222aa2aa2a2a2a2a22222211111122222aaa22a22a22a2a2a2a2aaa2aafaa222222211111122222aa22a2aa22aa2a2a222a2aaa2aa22222222111112222222222aaaaa2a2fa2af2aa222222a2222222221111222222222aa2222aa2aaa2aa22222222a22a2222221111222222222aa2222a2aa2222222222222a2aa2222221113222222222a2222aa2222a2222222222222a22222223112222222222a222aa2222aa2222222222222aaa22222211222222222aaaaaa2222a2a222222222222aa2a222222112222222222aaa222222a2a222222a22aa2aaa222222211202332020222202022aa2232222aa2a2a2a2a2aa220211023223202022023232a2202aa22a2faa2aa2aa2a202311232002023203202022a232aaa2a22aa2aaa222aa220211020223202322020202a22aa2a2aa2a2aa2202aa223201120200202023020222aa22a2aaa2aa2222022aa2002021102022320202202aaaaaaaaaa2202202222aaa2022020112020020202302aa2aa2222222022222aaaaa232002021102022020202202aaa2222222222aaaaaaa220232202311202002020203222222aaaaaaaaaaaaaa222020230202110000000000002aaaaaaaaaaaaaaaaa2200000000000011000000000002aaaaa22222222222220000000000000311000000000002aaaa240000000040003000000000000311000000000002aa2203030000000000000000000000031100000000000022030359559555900300000000000000110000000000030000956666666669b3000000000000001100000000000555955666666666666590000000000000110000000003988888896666666666666bb0000000000011000000000589558588955966666666666900000000031100000000035959b8588855566666666666b0000000001100000000058888859b9599566666666666b0000000001100000000985995566666666666666666666900000000110000000059396666676666666676666666650000000011000000033035666666669b995566666666650000000011000000000005655955595799559566666665000000031100000000039595997595755888885b66666500000003110000000005888885b7975b88b597859666690000000311000000000985598855855889cc95999b6669b0000000110000000000595c988985885ccc58999b566665550000110000000000305ccb858889ccccb85ddd9b966666b503110000000000335cc595855ccb4cb85d5dd595666666b0110000000000309cc5c955cc959c5855b5dd95566666651130000000000ba5c55955cc9c555bfff99d553b6666651103000000009aa99aaaa55c9555faaaaf995000b6666b11030000000045baaaaaaaf595bfaaaaaaf95530b6666b110000000030baaaaaa5faaffffaa5b5faf95530356695110333333335aaaaaa5faaaaaaaaaf5abf55353333953311303333335aaaaaaaaaaaaaaaaabbaaaf55033333330311003333335aaaaaaaaaaaaaaafbfaaff5b533333333331103333335aaaaaaaaaaaaf4bbbaaa5b553530333333331133333335aaaaaaaaaaf59faaaa5b555db33033333333110333333baaaaaaff99bfaaab5b55559d903030333333110333333baaaaf5bbaaaaa9b55555555dd955590333331103333335faafb035b5bbb335795555d99dddddb333331103333333baab303333333333b75559d5dddddddb003311033333335af533333333330357555d5dd5555ddd500311333333333b53333333333033b7555dbb955559dddb33113333333333533333333333307b55559b595555b9ddb01103333333333033333333333975555557755555599dd9b133333333035555333333335fb5565555b7555559b5dd51333333330bddd533333330575b6655555b755555559dd1333333335dd59533333339fb5665555555975555555b91333333335d5553333333bf5b66655555555b755555555103333333bd55533333305f56b9b555555555b775555551033333335d95330333335f695aaaa55555555777755551033333335555b003333bff65faaaaa5555555b779555510333355b555559333335ff69aaffaaa5555555bbaaaa5133095ddddd555db33335ff65aaaffaaa555559aaaaaaa130bd5d55997559d93335ff65aaaaafaa5555baaaaafff10355555555b7555d559dbf65bbaaaafa5555faaafffff133555555555755ddddd9bf95555aaafaa555aaaffffff1359d55555579559d99558599555baaafa55aaafffffeb135d5ddddd79755595958b5555555baafa55aafffffe31135d5555955575555588b5556555559aaf98affff5b3311359b555555575559dbb5966b555555bafbafffbb333311335d55555579555d9b6666e55595555ef5afbe559559413355ddddd7bd555d9666bb55559faaaffff5aaaaaaaa9133359599995559d5666e55555aaaaaaaffffffffaaaaa13335555559535d9b66b55555faaaaaafffff77fffffaa133333555533bd596ee555558aaaaaffffffffbeaaaffa1333333333335db5b5955555aaaaaffffffff777bbaaaf1333333333309d5555595558aaaaffffffff9bb9ddeaaa133333333334d9559a59555aaaaffffffffedddd995baa133333333339d555abb9555aaafffffbfff5d9955555ba133333333335d955a5ba555aafffff95ffbdd55b55555913333333333559aaa9aa555afffffb11bbdd559d55555513333333333555aaaaaa5f9affff91c17dd9b5d95555551333333333355aaaaaaaff5ffff51cc145995bd55555551033333333358aaaaaaaff9fffedccdd159597555555d5103333333335aaaaaaaaff5ffbddd997d17b75b55555d5103333333339aaaaaaaaff5ff59dbf9bdd979955555d95103333333335aafaaaafff9fff59ff95997b5955555d571333333333b5afaaaaaff9ffffffff5599b5595555dd5f10333333335aafaaaafffbffffffffd59555595d55d95f13333333335aaafaaffffbffffffff5dd5595dd55595ff10333333335aaafafffff9fffffffff99dddd995d957fa10333333335aaaaaffffefffffffffff89995b9d55bffa13333333335aaaaaffff5fffffffffffff9ddddd55ffff10333333335aaaaaaffeb7fffffffffffff87599fffaaf10333333335aaaaaaff939b7fffffffffffb935fffaaaa10333333335aaaaaafe93339beffffff7eb333bffaaaaa13333333335aafaaaf53330333bbebbb933330bffaaaaa1033333333bbafbaaf533333333333333333339ffaaaaa103333333355aefeae533333333333333333345ffeaaaa103333333339eff9a953333333333333333335ffefeaf11033333333395fafef50333333333333333335eeff5ae51033333333335aaa8a8403333333333333304785aa9e911033333333335faaaaf933333333333333339faaaaab311033333333335eaaaaaf5333333333333334faaaaafb0110333333333339aaaaaf5333333333333335faaaaae23110333333333339faaaaf503333333333334baaaaaa933110333333333335eaaaaaf40333333333339faaaaab9331103333333333335faaaaf9333333333333baaaaaa53331103333033333332eaaaaf93333333333347aaaaa7233311033333333333335aaaaaf933333333339faaaaa93333110333333333333397aaaaf93333333334faaaaa433333110333333333333029aaaaf9333333333baaaaaa503333110333333333333309aaaaf9303333332baaaaa7233333110333333333333339eaaaf93333333398aaaaf53333331103333333333333025aaaa8433333339aaaaa723333331103333333333333339aaaaa933333327aaaa8433333331103330003333333332eaaaa53333335faaaa53333333311033333033333333304aaaa53332045aaaaa90033333011033333333333333337aaaa5333235eaaaa843330333311033333333333333037aaaa9333335faaaa503333333311033333333333333335aaaa9333325aaaaa503333333311333333333333333335aaaa723339eaaaa8433333333311333333333333333239aaaaf53039faaaa933333033331103333322222222e77aaaaaae235eaaaaa77777722223110333229ee55eeefaaaaaaaaf925faaaaaaaafaa9994211033ebbeafbbfaaaaaaaaaaaae99ffaaaaaaaab9beaabe103bfaaabeaaaaaaaaaf99559a545945aaaaaaaaafbaaf135aaab9aaaaaaaaa54433333440333444baaaaaaaabaf10544459a444444444303333303033303344444444a54910b3033490333003003033333333333333300000034401103333333333333330333333333233333333333330333110333333333333333373333333343333333333333303311333333333333333333333000033303333333333033331133333033333333330333300000000000333330003333113303033303330303330303030303030303003030303311323232020232020232020232323232320203232323201120202020232323202020202020232023232332023232110232323232020232323232023202323232332323232311232023202323232323202323202323202323320232321132020232023232320232023202323232323323232323112323232323232323232323232323232323223232323211220222322222322232022232223222223222232223221122222222222222222222222222222222222222222222111222222222222222222222222222222222222222222111122222222222222222222222222222222222222222211112222222222222222222222222222222222222222221111222222222222222222222222222222222222222222111112222222222222222222222222222222222222222111111222222222222222222222222222222222222222211111122222222222222222222222222222222222222221111111222222222222222222222222222222222222221111111322222222222222222222222222222222222222211111111222222222222222222222222222222222222111111111122222222222222222222222222222222222211111111112222222222222222222222222222222222221111111111122222222222222222222222222222222221111111111111222222222222222222222222222222221111111111111112222222222222222222222222222221111111111111111122222222222222222222222222221111111111111111111122222222222222222222222211111111111111111111111122222222222222222222111111111111111111111111111122222222222222221111111111111111111111111111111112222222222111111111111111111", 46, 180],
    ["Mullen", "#c8401c", "24252a 353338 2e2f34 6e482d 2d2a2f 835839 212127 927054 3c3b41 58473d 010102 1b1a20 463731 a64225 c34023 0a0808", "ffffffffffffffffffaaaaaaaaaaaafffffffffffffffffffffffffffffffffaaa777777777777aaaffffffffffffffffffffffffffffaa777553555553355777aaffffffffffffffffffffffffaa7735555355555335553577aafffffffffffffffffffffa77533555535555533555353377afffffffffffffffffffa7555335555355555335553533357afffffffffffffffffa755553355553555553355535533557afffffffffffffffa75555533555553553333555555333537afffffffffffffa7555555335555535333535535553335357affffffffffffa5555555335555535333535535553335357afffffffffffa735555553355555553535355355533353537affffffffffa535553553355555535355355355533353537afffffffffa75355535533355555535553553553535553537affffffffa55355535533355555535553553553535553537afffffffa7555355535533355555555535355355355535337affffffa7355355535533355555555535355355355553537affffffa7355355535533355555555535355353555553537afffffa753553555355533355555553553553535555535357affffa753553555355533355555553535555535555535557affffa753553555355533355555553535535535555535557afffa75535535553555533555555535355353555555355357affa75535553553555533555555535355353555555355357affa75535553553555533555555353555535555555355357affa75535553553355533555555353555535555555355357afa7555355535553555535555535535555355555553553557aa7555555555555555555555535555555555555555555557aa7555555555555555555555555555555555555555555557aa7555555755755555557777757755555555555555555557aa7555555555555555555555555555555555555555555557aa7555555555555555555555555555555555555555555557aa7555555535553555535555555535553555555555553557aa7555535535553555535555535535553555355353553557aa7335535533539355395555535533359553999953533557aa7933595393539333993333393393339359999959335997aa7999393399399933999333393399939339999939393997aa799939999939c9999bf99999999b999999999999999cc7aa79999999c999c9999c9999999999999999cccc99999cc7aa79999999c99cc9999c999999999c99c999cccc99999cc7aa79999999c99ccc999cc99999999c9cc999cccc99999cc7aa79999999cc9ccc999cc9999c999cccc999cccc999c9cc7aa7c299999cc9ccc999ccc999c999ccccc99ccc199999cc7aa714c19191c9122191c1c11911cc2cc211c21411c1911c7aa7141111124122211122111111114224111244411111117aa7141111142122211144111111114424111244411111117aa7811111124144211144111111114444111444411111117aa7811111144144211144111111114424111444411111117aa78211111441444111bf11111111b444111444411111117aa781222114414441124412111121b444111404011121117aa7812111144244411244211121124444111400011111117aa7812222200204012200222222220040222000022222227aa7812222200200022200222222220000222000622222227aa7812222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7812222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7812222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7812222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7812222200200022260444eeeeeeeeeee2066622222227aa78122222002006224eeeeeeeeeeeeeeee2066622222227aa7882222200200eeeeeeeeeeeeeee060222066622222227aa7812222200200eeeeeeeeee24426000222066622222227aa7812222200200eeeeeeee1422220000222066622222227aa7812222200200eeeeeeeeeeeeee0006222066622222227aa78122222002000424eeeeeeeeeeeeee222066622222227aa781222220020002220622ddeeeeeeeeee2066622222227aa781222220020044114041444cceeeeeee2066622222227aa7812222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7822222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7812222200200eeeeeeeeeeeeeeeeeeee4066622222227aa7812222206200dddddddddddddddddddd4066622222227aa7812222200200622460244424426660224066622222227aa781222220020002243eeeeeeeeeeeeeee2066622222227aa781222220020062eeeeeeeeeeeeeeeeee2066622222227aa78222222002006eeeeeeeeeeeeeeeeeee2066622222227aa7812222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7822222200200eeeee0222222220000222066622222227aa7822222200200eeee00222222220006222066622222227aa7812222200200eeeee6222222220006222066622222227aa7822222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7822222200200deeeeeeeeeeeeeeeeeee2066622222227aa71422222002000eeeeeeeeeeeeeeeeeee2066622222227aa784222220020002eeeeeeeeeeeeeeeeee2066622222227aa724222220640002220eeeeeeeeeeeeeee2066622222227aa7822222200400022206222222220000122066622222227aa7222222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7112222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7822222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7222222206200eeeeeeeeeeeeeeeeeeee2066622222227aa7822222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7422222206200eeee60222222220000222066622222227aa7222222200200eeee00222222220000222066622222227aa7422222206200eeee00222222220000222066622222227aa7222222200200eeee06222222220000222066622222227aa7422222200200eeee00222222220000222066622222227aa7442222200200cccc06222222220000222066622222227aa7142222206200022200222222220000222066622222227aa7442222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7122222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7442222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7422222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7442222206200eeee44cccccccc4444cc2066622222227aa7222222200200eeee06222222220000222066622222227aa7442222206200eeee00222222220000222066622222227aa7442222200200eeee00222222220000222066622222227aa7222222200200eeee00222222220000222066622222227aa72422222002004ccc00222222220000222066622222227aa7242222200200dddddddddddddddddddd2066622222227aa7442222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7442222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7402222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7402222200200eeee44cceeeecc44eeee2066622222227aa7402222200200eeee0024eeee2200eeee2066622222227aa7422222200200eeee0024eeee2200eeee2066622222227aa7442222200200eeee0622eeee2200eeee2066622222227aa7422222200200eeee0622eeee2200eeee2066622222227aa74222222002004ccc00222224220044cc2066622222227aa7442222200200024200422222220600222066622222227aa7822222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7812222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7822222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7822222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7822222200200622460424deeeeeeeeee2066622222227aa7812222200200022460eeeeeeeeeee0422066622222227aa7812222200200624eeeeeeeeeee0000222066622222227aa7812222206200eeeeeeeeee11226000422066622222227aa7812222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7812222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7882222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7822222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7812222200200eeeeeeeeeeeeeeeeeeee2066622222227aa7882222200200622200222222220000222066622222227aa788222220020002220022222222b000222066622222227aa788222220020002226b222222226000222066622222227aa7882222200200022200222222220000222066622222227aa7882222200200022200222222220000222000022222227aa7882222200200022200222222220000222000022222227aa7882222200200022200222222220000222400022222227aa7882222244244022240222222224444222400022222227aa7882222244244422244222222224444122404022222227aa7881111144144412144111111114444112444411111127aa7888111124124411144111111114422111244411118117aa7888111122122411124111111112222111244211118887aa7888111122122211122111111112222111222211118887aa799811112212221112211111111b212111222211118887aa998888881181218812b188888886111888122288819887aa9999888811811188811888888881111888111188889887aa9999888811811188811888888881111888111188889995aa9999888811811188811888888881111888111188889995aa9999888811811188811888888881111888111188889995aa9889888811811188811888888881111888111188889999aa9888888822821288821888888881121888222288889999aa9218181822122211122111111812222118222288889889aa900261112212221112211111101222211224221168012aafa60411114414421112411111111442411140441112400affa4660004462bb40026b11020612b4461004b644611060affa46606066b0bb6660bb00660600b66b0066bb6666606baffa9bb666bbb6bbb666bb66666666bbbb666bbb0666666caffa9bb666bbb6bbb666bb66666666bbbb666bbbb666666cafffab6666bbb6bbb666bb66666666bbbb666bbbb666666affffab6666bbb6bbb666bb66666666bbbb666bbbb666666affffac6666bbb6bbb666bb66666666bbbb666bbbb66666cafffffa0666bbb6bbb666bb66666666bbbb666bbbb66666affffffac666bbb6bbb666bb66666666bbbb666bbbb6666caffffffac666bbb6bbb666bb66666666bbbb666bbbb6666aafffffffac66bbb6bbb666bb66666666bbbb666bbbb666caffffffffac66bbb6bbb666bb66666666bbbb666bbbb666affffffffffac6bbb6bbb666bb66666666bbbb666bbbb66caffffffffffac6bbb6bbb666bb66666666bbbb666bbbb66aafffffffffffacbbb6bbb666bb66666666bbbb666bbbb6cafffffffffffffabbb6bbb666bb66666666bbbb666bbbbcaffffffffffffffaabb6bbb666bb66666666bbbb666bbbbaffffffffffffffffaab6bbb666bb66666666bbbb666bbbafffffffffffffffffffabbbb666bb66666666bbbb666bcafffffffffffffffffffffacbb666bb66666666bbbb666cafffffffffffffffffffffffac6666bb66666666bbbb6caafffffffffffffffffffffffffaaac6bb66666666bbbcaaffffffffffffffffffffffffffffffaaccccccccccccaaffffffffffffffffffffffffffffffffffaaaaaaaaaaaaffffffffffffffffff", 48, 176],
    ["Muska stars", "#2c3c9c", "0e0e14 16161c 060606 3a3a3a 505050 2a2a2a 1e2a2a ffffff 2c3c9c 1c2470 9c9cb4 3a1a1a", "44444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444333333333333333344444444444444444444444444444444444444444444444433333333333333334444444444444444444444444444444444444444444433333333333333333333333344444444444444444444444444444444444444443333333333333333333333334444444444444444444444444444444444333333333333333333333333333333333333444444444444444444444444444433333333333333333333333333333333333344444444444444444444444444333333333333333333333333333333333333333344444444444444444444444433333333333333333333333333333333333333334444444444444444444444333333333333333333333333333333333333333333334444444444444444444433333333333333333333333333333333333333333333444444444444444444333333333333333333333333333333333333333333333333444444444444444433333333333333333333333333333333333333333333333344444444444444443333333333333333333333333333333333333333333333334444444444444444333333333333333333333333333333333333333333333333444444444444443333333333333333333333333333333333333333333333333333444444444444333333333333333333333333333333333333333333333333333344444444444433333333333333333333333333333333333333333333333333334444444444443333333333333333333333333333333333333333333333333333444444444433333333333333333333333333333333333333333333333333333333444444443333333333313131313131313131313131313131313133333333333344444444333335333333131313131313131313131313131313131336333333334444444431313131313131313131313131313131313131313131313131313133444444441313131313131363631313131313131313131313631313131313131344444444313131313131313131313131313131313131313131313131313131314444444413130313131313131313131313131313131313131313131313131303444444443130503131503535353535353535353535353535353530313131513144444415130505031505555555555555555555555555555555551503150505151544445051505051515055555555555555555555555555555555505050505050504444555555555555555555555555555555555555555555555555555555555555444450515050515150555555555555555555555555555555555051505051505044445555555555555555555555555555555555555555555555555555555555554444505050505050515051505050505050505050505050505051505050515051444455555555555555501100000000000000000000000010005555555555555544445050505050005000010000000000000000000000000000010050505050514444550000000000000000000000000000000000000000000000000005555555444400001010000000000000000000000000000000000000000000000000005044440000000000000000000000000000000000000000000000000000000000054444000000000000000000000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000000000000000000000000000000000000000000000004444000100000000000000100000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000000000000000000000000000000000000000000000004444000000000000000000000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000000000550000000000005500000000000000000000004444000000000000000000000055000000000000b500000000000000000000004444000000000000000000000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000000000000000000000000000000000000000000000004444000000000000000011000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000000000000000000000000000000000000000000000004444000100000000000000000000000000000000000000000000000000000000444400110000000000000000000000000000000000000000000000000000000044440000000001000000000000000000000000000000000000000100000000004444000000000000000000000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000000000000000000000000000000000000000000000004444000000000000000000000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000000000000000000000000000000000000000000000004444000000000000000000000000000000000000000000000000000000000000444400000000000000000000005500000000000055000000000000000000000044440000000000000000000000bb000000000000bb00000000000000000000004444000000000000000000000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000000000000000000000000000000000000000000000004444000000000000000000000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000100000000000000000000000000000000000000000004444000000000000000000000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000100000000000000000000100000000000000000000004444000000000000000010000000000000000000000000000000000000000000444400000000000000000000000000000000000000000010000000000000000044440000000000000000000000000000000000000000000000000000000000004444000000000000000000000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000000000000000000000000000000000000000000000004444000000000000000000000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000000000000000000000000000000000000000000000004444000000000000000000000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000044440000000000000000000000000000000000000000000000000000000000014444000000000000000000000000000000000000000000000000000000000000444400000000000000000000000000000000000000000000000000000000000034440000000000000000000000000000000000000000000000000000000000003434000000000000000000000000000000000000000000000000000000000000443300000000000000000000000000000000000000000000000000000000000044340000000000000000100000000000000000000010000000000000000000003434001100000010000011000000000000000000001100000000000000000000344400110000010000000000000000000000000011000000000000000000000033440010000000000000000000000000000000000000000000000000000000004344000000000000000000000000000000000000000000000000000000000000434300000000000000000000000000000000000000000000000000000000000043440000000000000000000000000000010000000000000000000001000000004344000000000000000000000000000000000000000000000000000000000000433400000000000000000000000000000000000000000000000000000000000043440000000000000000000000000000000000000000000000000000000000004343000000000000000000000000000000000000000000000000000001100000434300000000000000000000000000000000000000000000000000000880111043340000000000000000000000000000000000000000000000000000087484903334000000000000000000000000000000000000000000001110000018774700333300010000000000000000000000000000000000000011848100014477780033330000000000000000000000000000000000000000118847481009777774103333000000000100000000000000000000000100011188887778811099778780333400000000000000000000000000000000010001898808777798100078889033340011000000000000000000000000000001110087780877877880008100004334000100000000000000000000000000000188118778087788778811810000333400000000011110000000000010010011188888778808779977798810000033340000100001101000000000000001118888778877880877778877888000003333001000000110000010000001000188889887987788087778898778810000333300010000011000000000001110188877778a787788187788009977880000333300000000000000001100001188887777788a77777488878800008894000034330011000000000000001011189887778888887777778887880100990110003333000000000000000000019888778777888888877887774778011000110000333300000000000000001018a88877887777777787788877778800000000000033330000000000000011898877888778877777774877888888910000000000003333000000000000018847987798877889988847787788888000010000000001333300000000000008887778877888748011187788a88801100000000000000033330000000111110877777887788877819887778888880000000000000000003333000000018898187777778877887788a7777880890000000000000000000033330000008888788877787788778877897777888000000000000000000000003333000000887777888778877887777780888899000000000000000000000000333300000088777778877887788877778089880000000000000000000000000033330001001887787787788a7788877880000010000000000000000000000000333301080018877877787a8877a8888880100000000000000000000000000000333400888888887788777788877888800000000000000000000000000000000034340188787888779877778887880000000000000000000000000000000000003333188877880887788877808888100000011000001100000000000000000000333389777788188778887780880010000001000000110000000000000000000033341188777880887789888011011000000000000001000100000011000011103343010878888098778088801001000000000000110000001000000000000010333401088001000888810100001100000000000011000001000000000000001034330009800000088900000000000000000000000000000000000000000000003333000010000001000001000000000000000000000000000000000000000001333400110000100001000000100000000100000000000001000000000000000033341111000010010010000000000000001000000000000110000000000000003333000010000100000000000100000000000000000000000000000000000000333300000000000000000000000000000000000000000000000000000000000034430100000000000000000000000000000000000000000000000000000000003344000000000011000011010001001000001000000000000000000000000001333300010000001001000000000000000000000000000000000000000000000133340000000000000100000000000000000000000000000000000000000000003334000100000000000000000000000000000000000000000000000100000000333300000000000000000000000000000000000000000000000000000000000033330000000000000000000000000000000000000000000000000000000000003334000000000000000100000010000000000000010000000000000000000000333400000000000000000000000000000000000000000000000000000000000033330000000000000000000000000000000000000010000000000000000000003334001100000110000011000000100000011000000000000000000000000010333400010000001000001100000010000001100000000000000000000000001033330000000001100000110000000000000000000000000110000000000000003333000000000110000011000000100000000000000000011000000000000000333300110000011000000010000010000000000011000000000000000001000033330010000001100000000000001000000000001100000000000000000000003333111000000000000100000010000001100000110000000000000000111100333301000000000000010000000000000110000011000000000000000011010034330000000000000000000000000000000000000000000000000000000000003433000010000000000000000000000000000000000000000000000000000000333300000000000000000000000000000000000000000000000000000000000133330000000000000000000000000000000000000000000000000000000000003333000000000001000000100000000000100000000000000000000100000010334300000000000000000000000000000000000000000000000000000000000133330000000000100000000000000000000000000000000000000000000000013334000000000000000000000000000000000000000000000000000000000001333300000000000000000000001000000000000000000000000000000000000033340000100010100000100000011000001100001000001100000110000001103333000000000000000000000000000000000000000000000000000000000000333300000000010000000000001000000000000000000000000000000001000133330100000000000000000001000000000000000000000000000000000000003333000000000000000000000000000000000000000000000000000000000000333400110100011000001100000000000111100011000000000000100001000033330011010001100000110000001000011110001000000000000000000000003333001100000000000011000000100001100000000000011000001100001111333400000000000000000000000000000000000011000001100000000000000033330000000000000000000000000000000000001100000110000000000000003333000000000000000000000000000001100000110000000000000000000100333300000000000000000010000000000010000011000000000000000000110033340000000000000000000000000000000000000000000000000000001100003334000000000000000000000000000000000000000000000000000000110000333300000000000000000001000000000000000000000000000000000001000133340000000000000100000000000000000000000000000000000000001100003333000000000010000000000000000000000000000000000000000000000000333300000000000000001000005b000000000000b50000000000000000000000333300000000000000001000005510000010000055000000000000000100100033340000000000100000000000000000001000000000000000000100000000003333000000000000000000000000000000000000000000000000000000000000333400000000000000000000000000000000000000000010000000101100100033340000000000000000000000000000000000000000000010000000110100003333000000000000000000000000000000000000000000000000000000000001333300000000000000000000000000000000000000000000000000000000000033330011110000000000110000001000000000000000000000000000110000103333001111000111000001110000000000100000101100000000000100000010333300111000011110001111000010000110000010110001100000010000000133330011000001100000010000101000000000000000000000000001000000013333001100000100000011000011000000000000000000000000000100000000333300000000111000010000001100000010000000000000000000000000000033430000000101100000000100100000010000000000000000000000000000013334100000000000000000000000000000000000000000000000000000000000333366000000000000000000000000000000000000000000000000000000000533336666666666666666666666666666666666666666666666666666666666664333556666666665556666666655655565556656555655556656666655556666433366666656566555566666565555555555555655665555555666665566666633336655666556655665665556665555555665666666665566556666555666663333626555555666566555555566555555566565666666656555566655556662333426666665555555556655565565556665566566556665556666666556666633336266665555556655665556656555666555656655566555666666666552623333266256665555665555555666666555565555565556655566665666662626333362655666655566556666666666655656565555555665566666666262626233332626252666666666666666666666566656556665566655666666662626263333625252626262626252626262626262625262626262626262626262625262333326252626666655566566666666666666666566666556655666662626252243342252626262626262526262626262626262626262606262526262626262224333222626252526262525262625262626252626262625262626262526262622434443226252526262626262626262626262626252526262626262626222223444444362222526262626262626262626262626262626262626252126626222444444432226222262626262626262626262626262626262626262622222222244444444222222622222222222222222222222222222222222222222622222224444444422222222262262626262626262626262626262626262626222222222444444442222222222222222222222222222222222222222222222222222222244444444222222222222222222222222222222222222222222222222222222224444444422222222222222222222222222222222222222222222222222222222444444444322222222222222222222222222222222222222222222222222224344444444442222222222222222222222222222222222222222222222222222444444444444222222222222222222222222222222222222222222222222222244444444444422222222222222222222222222222222222222222222222222224444444444442222222222222222222222222222222222222222222222222222444444444444442222222222222222222222222222222222222222222222224444444444444444222222222222222222222222222222222222222222222222344444444444444422222222222222222222222222222222222222222222222234444444444444432222222222222222222222222222222222222222222222223444444444444444342222222222222222222222222222222222222222222243444444444444444444222222222222222222222222222222222222222222224344444444444444444422222222222222222222222222222222222222222222434444444444444444442222222222222222222222222222222222222222222244444444444444444444432222222222222222222222222222222222222222444444444444444444444443222222222222222222222222222222222222222234444444444444444444444434222222222222222222222222222222222222434444444444444444444444443422222222222222222222222222222222222243444444444444444444444444444443222222222222222222222222222234444444444444444444444444444444443322222222222222222222222222223433444444444444444444444444444444444444442222222222222222444444444444444444444444444444444444444444444444222222222222222244444344444444444444444444444444444444444444444444433333433333444444444444444444444444444444444444444444444444444444444344443444444444444444444444444444", 64, 250],
    ["Blue hood", "#f0a020", "d8a878 b88a60 0a0a0c 2a2a30 8a8a8a c4c4c4 f0f0f0 3a7ad0 2c5a9c 1c3a6a f0a020 c07818 b82030 7a1820 e01818 5a5a60", "11111111111111111111110000000000000000111111111111111111111111111111111111111111110000000000000000111111111111111111111111111111111111111100000000110000000011000011111111111111111111111111111111111100000000110000000011000011111111111111111111111111111111000000000000110000000011000000001111111111111111111111111111000000000001110000000011000000001111111111111111111111111100001000000011110000000001000000000011111111111111111111111100001100000000010000000000000000000011111111111111111111110000001100000000110000000000000000000000111111111111111111110000001100000000110000000000000000000000111111111111111111000000001100000000110000000000000000000000001111111111111111000000001100000000111000000000000000000000001111111111111100111000001100000000100000000000000100000000010011111111111100111000001100000000100000000000000000000000010011111111111100110000001100100000000000000001000000000000110011111111111100110000011100100001000000000001000000000000110011111111110011100010001101000010000000000001000000000000000000111111110011100000001101000000000000000001000000000000000100111111110033333333333333333333333333333333333333333333333300111111110033333333333333333333333333333333333333333333333300111111001133ffffffffffffffffffff44ffff44ffffffffffffffff331100111100f133ffffffffffffffffffff44ffff44ffffffffffffffff330100111100ff33ffff44ff44ffffff44ff44ff4444ff44ff44ffff44ff3300001111003333ffff44ff44ffffff44ff44ff4444ff44ff44ffff44ff33100011110033334444ffff44ffffff44ff44ff4444ff44ff44ffff44ff33110011110033334444ffff44ffffff44ff44ff4444ff44ff44ffff44ff331100111100333344444444ffffffff44ff44ff4444ff444444ffff44ff331100111100333344444444ffffffff44ff44ff4444ff444444ffff44ff3311001100113333444444444444ffff444444ff4444ff44444f44ff44443311110000113333444444444444ffff444444ff4444ff44444f44ff444433111100001133333344444444444444ff4444ff4444ff44444fff44444433111100001133333344444444444444ff4444ff4444ff44444fff444444331111000011333333333344444444ff4444ff4444ffffff444fffff4444331111000011333333333344444444ff4444ff4444ffffff444fffff4444331110000011333333334433334444ff44ff4444ff44ff44444ffff444443311110000113333333344333344454444ff4444ff444444444ffff444443311110000113333333344444433ff44444444444444ff44444ffff444443311110000113333333344444433ff44444444444444ff44444ffff44444331111000011333333334444ff4444334433444444444444ff4fffff4444331111000011333333334444444444334433444444444444ffffffff444433111100001133333333ffff44444444ff443333444444444444ffff444433411100001133333333ffff44444444ff443333444444444444ffff444433411100001133333333f444444444444f4444443333444444444444ff4433ff11000011333333334444444444444f4444443333444444444444ff4433ff1100001133333333f4444f4444f4ffff4ff444ff333344444444444433ff1100004133333333444444444444ffff4ff444f4333344444444444433ff110000ff333333334fffffffffffff4fffffffff4fff33334444444433ffff0000ff333333334fffffffffffff4ffffff4ff4f4f33334444444432ffff0000ff22333322ffffffffffff33ffffffff33ff222222aa22444422ffff0000ff22333322ffffffffffff33ffffffff33ff222222aa22444422ffff0000ff22333322ffffffffffffffffffffff222277778922aa333322ffff0000ff22333322ffffffffffffffffffffff222277778922aa333322ffff0000ff22333222ffffffffffffffffff2222777788398922bbbba322ffff0000ff22232322ffffffffffffffffff2222777788398922bbbba322ffff0000ff22222222ffffffffffffff22227777777788882222bbaaaa22ffff0000ff22222222ffffffffffffff22227777777788882222bbaaaa22ffff0001ff22222222ffffffffffff227777777777777788888822aabb223fff1001ff22222222ffffffffffff227777777777777788888822aabb223fff1011ff22222222ffffffff222277777777777777778888888822bb2233ff1111ff22222222ffffffff222277777777777777778888888822bb2233ff11113322222222ffffff229977777777777777777788888888882222333311113322222222ffffff229977777777777777777788888888882222333311113322222222ffffff227777337777777733777788888888888922333311113322222222ffffff227777337777777733777788888888888822333311113322222222ffff22777777888877777777778888888888888889223311113322222222ffff22777777888877777777778888888888888889223311113322222222ff2277777788888888888888888888888888888888932211113322222222ff2277777788888888888888888888888888888888332211113322222222227777777788888888888888888888888888888888882211113322222222227777777788888888888888888888888888888888882211113322222222997777778888888888888888888888888888888888883311113322222222997777778888888888888888888888888888888888883311113322222222777777778888888888888888888888888888888888888811113322222222777777778888888888888888888888888888888888888811113322222299777777888888888888888888888888888888888888888811113322222299777777888888888888888888888888888888888888888811113322222277777777888888888888888888888888888899998888888811113322222277777777888888888888888888888888888899998888888811113322222277777777778888888888888888888888999988888888888811113322222277777777778888888888888888888888999988888888888811113322229977777777887777888888888888889999888888888888888811113322229977777777887777888888888888889999888888888888888811113322227777777777778877778888999999998888888888888888888811113322227777777777778877778888999999998888888888888888888811113322227777777777777799777777777788888888888888888888888811113322227777777777777799777777777788888888888888888888888811113322227777999999777777999888988899887788888899999988888811113322227777999999777777939888998899887788888899999988888811113322227777992222997777779999998877777788992222228888888811113322227777992222997777779999998877777788992222228888888811113322227777772222222277777777777777779922222222998888888811113322227777772222222277777777777777779922222222398888888811113322227777772222ddee229977997777889922eedd2222888888888811113322227777772222ddee229977997777889922eedd222288888888881111332222777777992222eedd22229999222222ddee22223988888888881111332222777777992222eedd22229999222222ddec22229988888888881111333322777777772222222222227788222222222222228888888888881111333222777777772222222222227788222222222222228888888888881111333222777777777722222299777788992222222222888888888888881111333222777777777722222299777788932222222222888888888888881111333222987777777777777777777788889993999988888888888888881111333322997777777777777777777788889933333988888888888888881111332322997777777777777777778888888888888888888888888888881111332322997777777777777777778888888888888888888888888888881111332322997788777777777777888888888888888877777788888888881111332322997788777777777777888888888888888877777788888888881111332322397788887777777777888888888888887777777788888888881111332322997788887777777777888888888888887777777788888888881111332322897777888877777777888888888888887777777788888888881111332222997777888877777777888888888888887777777788888888881111332222777777778888777777888888888888888877778888888888881111332222777777778888777777888888888888888877778888888888881111332222777777778888777777888888888888888888888888888888881111332222777777778888777777888888888888888888888888888888881111332222777777777788777777778888888888888888888888888888931111332222777777777788777777778888888888888888888888888888931111222289777777777777777777777777778888888888888888888888881111222289777777777777777777777777778888888888888888888888881111bb2277887777777777777777777777778888888888888888888888931111bb2277887777777777777777777777778888888888888888888888931111aa2277778877777777777777777788888888888888888888888899221111aa2277778877777777777777777788888888888888888888888899221111aa2299777777777777777777777777888888888888888888889322221111aa2299777777777777777777777777888888888888888888889322221111aabb22777777777777777777777777888888888888888888882222221111aabb22777777777777777777777777888888888888888888883222221111bbaa22897777777777777777777777778888888888888888932222221111bbaa22897777777777777777777777778888888888888888932222221111bbaabb229977777777777777777777778888889988888893222222221111bbaabb229977777777777777777777778888889988888893222222221111bbbbaa222299777777777788887777888899998888889922222222221111bbbbaa22229977777777778888777788889999888888932222222222111122bbaabb222299777777777777999999938888778899222222222222111122bbaabb222299777777777777999939938888778899222222222222111122bbaabb222222229977777777777777777777889322222222222222111122bbaabb22222222987777777777777777777788932222222222222211112222bbaabb222222222288777777777777778922222222222222222211112222bbaabb22222222228977777777777777992222222222222222221111222222aabb22222222222222222222222222222222222222222222221111222222aabb22222222222222222222222222222222222222222222221111222222aabbaa222222222222224422ff2222222222222222222222221111222222aabbaa222222222222224422ff222222222222222222222222111122222222bbaaaa222222222222ff2222222222222222222222222222111122222222bbaaaa222222222222ff222222222222222222222222222211112222222222aabbaa222222222222442222222222222222222222222211112222222222aabbaa22222222222244222222222222222222222222221111222222222222bbaabb2222222222ff222222222222222222222222221111222222222222bbaabb2222222222ff222222222222222222222222221111222222222222bbaaaabb2222222222222222222222222222222222221111222222222222bbaaaabb222222222222222222222222222222222222111122222222222222aabbaabb2222222222222222222222ff5555222222111122222222222222aabbaabb2222222222222222222222ff555522222211112222222222222222bbaabb2222222222aaaaaabbaaaa22445566332211112222222222222222bbaabb2222222222aaaaaabbaaaa2244556633221111222222222222222222aabbaabb2222bbbbaaaaaabbaabb22554466441111222222222222222222aabbaabb2222bbbbaaaaaabbaabb2255456644111122222222222222222222bbaaaa22aaaaaabbbbbbbbaabb22ffff44ff111122222222222222222222bbaaaa22aaaaaabbbbbbbbaabb22ffff44ff11112222222222222222222222aa22bbbbaabb22222233fff3555466555511112222222222222222222222aa22bbbbaabb22222233fff355446655551111222222222222222222222222bbaaaabb22ff556666666666666666551111222222222222222222222222bbaaaabb22ff556666666666666666551111222222222222222222222222aaaaaa224466666666445444542222221111222222222222222222222222aaaaaa2244666666664454445522222211112222222222222222222222bbaabbdd2244446644ff33fff32222445511112222222222222222222222bbbbbb22ff444444442222fff35566665511112222222222222222222222bbaabb22ff2233332222223ff34566666611112222222222222222222222aaaabbdd2222445454556666666666666611112222222222222222222222aaaabbdd22224444445566666666666666111122222222222222222222bbaaaabbbb22556666666666666655552222111122222222222222222222bbaaaabbbb22546666666666666654552222111122222222222222222222bbaabb22bb2255556666f3ff222222224455111122222222222222222222bbaabb22bb2245556666f3ff222222224455111122222222222222222222bb33aa22bb3322223322223f444555666666111122222222222222222222bb33aa22bb332222f322223f444555666666111122222222222222222222aaaaaa2222bb224554456666666666666644111122222222222222222222aaaaaa2222bb2244544466666666666666441111222222222222222222bbaabb222222bb224466666666664445f3fff31111222222222222222222bbaabb222222bb225466666666664445f3fff31111222222222222222222bbbbaa222222bb22ff555533f32222335544551111222222222222222222bbbbaa222222bb22ff555533ff2222335544551111222222222222222222bbaabb22222222bb2222f344556666662222221111222222222222222222bbaabb22222222bb2222f3445566666622222211112222222222222222bbaaaabb22222222bb2244444466663f22bbaabb11112222222222222222bbaaaabb22222222bb2244444466663322bbaabb11112222222222222222bbaabb2222222222bbbb223ff32232bbaabbaabb11112222222222222222bbaabb2222222222bbbb223ff32222bbaabbaabb11112222222222222222bbbbaa222222222222aaaa22bbbbaabbaabb222211112222222222222222bbbbaa222222222222aaaa22bbbbaabbaabb222211112222222222222222bbaaaa332222222233aaaabb32bbbbbb2222223211112222222222222222bbaaaa332232222233aaaabb32bbbbbb2222222211113333333333333333bbaabb333333333333bbaabb323333333333333311113333333333333333bbaabb333333333333bbaabb233333333333333311113333333333333333bbbbaa33333333333333bbaaaa3333333333333311113333333333333333bbbbaa33333333333333bbaaaa3333333333333311113333333333333333bbaaaa33333333333333bbaabb333333333333331111333333333333c333bbaaaa3333c333333333bbaabb33333333333333111133333333333ccc33333333333cc33333333333bbbbbb33333333333311113333333333c33cc3333333333cc33333333333bbbbbb33333333333311113333333333c33cc3333333333cc333333333333333333c333333333311113333333333c33cc3c3cc33333cc3c3cc33ccc3c333333c33333333331111333333333cccccc3cc33c32cccc2cc2c3c32c3cc3cc23c33333333321111333333232cc33cc2cc3dc3c23cc2c3332ccc23cc3cc23c33322223321111333222332c333cc2c22cc2c22cc2c2222c32233c3cc2c332222222221111222222222c222cc2c22cc2cc2cc2c2222cc2222cc22cc2222222222211112222222222222cc2c22cc22ccc22c22222ccc222c22c2222222222221111222222222222222222222222222222222222222222222c22222222221111222222222ccc222222222222222222222222222c22222c2222222222111122222222cc22c2222222222222222222222222cc22222c2222222222111122222222cc22c2222222222222222222222222cc22222c222cd222221f111f222222cc22c222ccc2cc22c2cccdc222cc22cc22cccc22c22222f111111f222222cccc222c22c2cc22c2ccc2cc2c2cc2cc2cc22c22cd2222f11111ff222222cc2c222cdc222d22c2cc22cc2c22c2cc2cc22c222cc222ff1111ff222222cc22c22c222222ccc2cc22cc2c22c2cc2cc22c2222c222ff1111ff222222cc22c22cc222222c22cc22cc22cc22cc22cccd2d22d222ff1111ff222222cd22dc22cdd2222d22cc22dd22dc22dd222dd222cd2222ff1111111f2222c2222222222222c22abb2222222222222222bbbb2222f1111111111f222222222222222222d22abb2222222222222222bbbf2222f1111111111122222222222222222d22aaaabb222222222222aaaa2222221111111111ff2222222222222222c222aaaabb222222222222aaaa222222ff111111111111222222222222222222bbaaaabb22222222bbbbbb22221f111111111111f1222222222222222222bbaaaabb22222222aabbb12222111111111111111122222222222222222222bbaabbaaaabbaaaaaa222222f1111111111111ff22222222222222222222bbaabbaaaabbaaaaaa222222ff11111111111111ff22222222222222222222bbbbaaaaaabbbb222222ff1111111111111111ff22222222222222222222bbbbaaaaaabbbb222222ff111111111111111111112222222222222222222222222222222222221111111111111111111111ff222222222222222222222222222222222222ff1111111111111111111111ff22222222222222222222222222222222ff111111111111111111111111ff22222222222222222222222222222222ff1111111111111111111111111111112222222222222222222222221f111111111111111111111111111111ffff222222222222222222222222fff4111111111111111111111111111111111ff1ff222222222222ff1fff111111111111111111111111111111111111ffffff222222222222ffffff1111111111111111111111111111111111111111fffffff1ffffffff11111111111111111111111111111111111111111111ffffffffffffffff1111111111111111111111", 60, 236],
    ["Grin cat", "#e4e0f4", "010101 28262c e6e2fd e4defd 000000 474153 978eae d9d3fa 0f0e14 d0cbe8 655b6f 242328 221b31 bfb8dc", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1b0011111001aaaaaaaaaaaaaaaaaaaa1110000111000011aaaaaaaaaaaaaaaa00000404000040404000aaaaaaaaaaaaa410000b010040b0b0b400baaaaaaaaaaa0b0b0010b0b00b0b01000101aaaaaaaaa41010000101410414141000b01aaaaaaa410b0100b0b0b04b4b0b040b4b0baaaaaa0010b000010b0000b0b0040014b0aaaaab0b4000b0100000b400000b4b4400baaaa014000b010b004b0b0044b0b014014aaaab0b0014b0b000b0b0b40b014b0444baaaa0b8000b01410081010000b014100b0aaa8180040010b0000bb100400b8b400411aa00400000000000000004000000000000aa0c5c5c00000011040081180000011004aacc39cdcc000111100011110040111104a5c3336addc811111b0111111041111110a5c33335ddd5b1111101111110011111b0a5333333cdddac11100811118408111180a5333333cdddddcb004008880000088800a53333332cdddddccbbb04000bbb40404baa3333333cddddddc111b400b11bb004b1a63333333cdddd1d6c11b1011111100b11a633333333cddd6d6c111101111b100b11a633333333cdddddd1cbb00bbbb1b00b11a633333333cdddddddddddddd6cc004001a633333333ccccddddddddddddddd6cc00a633333cccdddddddddddddddddddddddaa6332cccdddddddddddddddddddddddddda633ccdddddddddddddddddddddddddddda6ccddddddddddddddddddddddddddddddaacddddddddddd1dddddd1dddddddddddda5ddddddddddddddddddddddddddddddddaaddddddddd5ccccccddddddddddddddddaadddddddccc33333cc6dddddddddddddda6dddddccc323333333ccdddddddddddddaaddddc7233333333333ccddddddddddddaadddc233333333233232c6dddddddddddaadd523336666666333333cddddddddcccaadd633362233333663333c6ddddccc332aad63336333333333263332cddcc122232a6d23363332332323262332cac32323233a69336232233333332363323c222323323aa333623c2333333333633233233236666a677633cc2233333233623333333662222a67763ccc3233333333623333326223332a67763c3c3223333332623332363222222a67763c3c3223333333633332622222222a67763cc23333333333633333622c22222a67763cc3233333333263333632cc22222a5a763332233333332633333632cc22222a6cc3623323333333363333362c2c22222a67c3623333332333622333362c2c22222aa77c362222222226322232362cc222222aac77c7666666666666d232262cc222322a67c97c7776cccccccccccc66333222222a677c77776cccc66666cccccc622222222a5c77c777ccccc666666cccccc63222222a67c77c77cccccccc66ccccccccc632222a677c7777cccc6cccccccccccccc666222a677777776cccc6cccccccccccccc67666aa777777776cccc6ccccccccccccc6777ca567777777777776cccccccc6cccc677c7a6c677777777776ccccccc6cccccc6773ca63cc7777777776cccccc666cccc677cc7a632cc6777777776cccccc676cc6777377a6222cccd77777776cccc677777777cccca622226ccc66666cccc777777777777777a622262226ccccc226cd77777777777777a622262222222222362cc677777777766ca62226222222222226223cc6777766ccc2a6626222222222226322226cccccccc222a636622222222222622222222362222222a622662222222222622222222262222222a626226622222226222222222262222222a626222266222226222222222362222222a626222222662226322222222622222662a512222222222666666622222622666223a6cc222222222262222266666666222226a676c52222222262222222223632222226a6776ccc222226222222222262322322cca677776ccc22262222222222622323cccda677777766ccc32222222222632cccc677a67777777776cccccccc22226cccc67777a5a67777777776666666ccccc667777776a100a677777777777777777777777776a0a51100a67777777777777777777776a00ba5111b0066777777777777777776600411a5111b001b00a66766766666a00b1b00b1a51571001b1b04670790040001111100b1a516b78001b110c8071b10400b11bb0001a5614d8007717074071700400b11b00440a170447060870710677040000000400400a170077b9707b7777790091bb0000b1b10a1701b79d65779a9b774111bbb04111111a10d1977117015761b009b111100111111a141151d1b00111111009b11110011111ba100b777b0000111b090d9b77000011114a10077ba7006701b9090db9170000011b4a107d740709777789090d0090949000000a57bd777d17110789171940907b7b00041a661b104ab711977757bdc709777b100b1a661b787ab7a751d77111667b1b71b0011aa111784719bb940b111b100b971a70011a5111d74b1b77500b111b1047b7b1b000ba51b057001b1b00001111009001b100000a10000d800008000000000890640000000a104010c0000001b00000b0b000000b0b0a100101010400bb010441414b4000b010ba10b0b0b0b04b4010b00410b0100b0b414ab4010b0b0000b10b404b0b0b0040b0b0bab0b41414b40b0014b000b410b00b414b0ab00b4b0b0004bb010000b80b4000b0b80aa000b0b400000bb000400bb000000bb40aa1104040011000000b144400011000440aa11b0000111100001111000011b10000baa11110011111b0011111100111111001baa11110011111100111111001111110011aaa1110011111b001111110011111100baaaa114000b111400411110000111b0004aaaab00004011000000110400001100000aaaaa0411040000110000001100004411aaaaaa4b11b04041111040011114000b11aaaaaaa111110011111b0011111100111aaaaaaaa51111001111110011111100115aaaaaaaaa111100111111401111110011aaaaaaaaaaab100001111004011110000aaaaaaaaaaaaa00000011400000110000aaaaaaaaaaaaaaaa1100000011000000aaaaaaaaaaaaaaaaaaaaa4040b11104aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 34, 132],
    ["Mon-star", "#d04a20", "eabc89 020101 edc699 d1aa7e 0e0e0e 212120 d3a031 fefefc f5f2e6 b55423 282726 a48665 ad8d68 403e3d c09c37 bcbcbc", "ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccdd44444444ddcccccccccccccccccccccccccccccccccccc444444444444ccccccccccccccccccccccccccccccccd4d444444444444444d4cccccccccccccccccccccccccc4d4d44444444444444444d4dccccccccccccccccccccccd4d444444444444444444444d4d4cccccccccccccccccccd4d4d444444444444444444441d4d4cccccccccccccccccd4d4d14444444444444444444454d1d4cccccccccccccccc4d1d4444444444444444444444441d4dccccccccccccccc4d4d1444444444444444444444444a4d4dcccccccccccccdd4d45444444444444444444444444444d4dccccccccccccd4d4444444444444444444444444444a1d1dcccccccccccc4d4d4444444444444444444444444444d4d4ccccccccccc4d1d444444444444444444444444444444d1d4ccccccccccd4d44444444444444444444444444444441d4dcccccccccd4d4444444444444444444444444444444444d4dcccccccc4d4d44444444444444444444444444444441d4d4ccccccccd4d4444444444444444444444444444444444d4dcccccccc4d444444444444444444444444444444444444d1ccccccc4d44444444444444444444444444444444444444d4ccccccd4d444444444444444444444444444444444444d4dcccccd4d44444444444444444444444444444444444444d4dcccc4d4444444444444444444444444444444444444444d5ccccd5d55555555555555555555555555555555555555d4dcccc5d5555555555555555555555555555555555555555d5cccdd5555a555aa5aa5aaaaaaaaaaaaaaa5aa5aa5aaaa55ddccdad5a5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaadadccdd5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaadccd5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5dcc5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaccaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaacc5555555555555555555555555555555555555555555545cc55555555555555555555555555555a5555555555555555cc5555555555555555544555555554455444444444444444cc5555555555555555544555555554455444444444444444cc44444444444444444aa44444444aa44111111141414144cc44444444444444444aa44444444aa44444414411444444cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc44444444444444444aa44444444aa44111111111111111cc44444444444444444aa44444444aa44111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc4444444444444444444444444444444111111111111111cc444444444444444ff44444444444444111111111111111cc4444444444444447744444444444444111111111111111cc4444444444444447744444444444444111111111111111cc4444444444444447777444444444444111111111111111cc44444444444444477ffdd44444444441111111d1111111cc4444444444444447711774444444444111111581111111cc444444444444444771177444444444411111fd11111111cc44444444444444477117744444444d41111a7111111111cc4444444444444447711ddff44444fd4111f7d111111111cc44444b44444b444771111774444474411b771111111111cc44444854444744477111188aa445744157781111111111cc444444db444df4477111111774b7744f7771111b111111cc44444447d444f4477111111ffd777dd777f111df111111cc4444444875444547711111111777777778144481111111cc4444444477c447c7711111111bbbbbb771b77d11111ccbcc444444448775477771111111111111177477f111111777cc444444444777477771111111111111177777111111a773cc44b444444c777771111111111111111117777777777111cc44f4aaaadd777ff1111dddddddddd1111ffffffffff111cc4444777777777111141777777777711111111111111111cc444444f7777ff11dd77f5554454ff77dd111111111111bcc4444444877711117778469999994187771111111111117cc444444447771111777496eeee6994177711111111111b2cc44444447711117777196eaaaae6994f777711111111770cc4444444771111777746e422224e699177774411111a820cc4447777111177777166100180216691777499111177000ccadaffff111dfff77166ac0aa0356e917f569da11177000cc7771111111711177166612020462991716917711177000cc7771111114d46477162291111921891716917711177000cc1111111117771617161869999644991771647771177000cc1111111117771617794166eee666617771e94771177000cc1111111117771617716669111966917777169171177000cc4441111117784e47719691212196947777169171177000cc7771111117716177716611111116964777469171177000cc87811111177161771e6611212116666111691771177000cc0007711117749644e46699999996696eee947771177000cc00088111177719661666e66666696e9944177771177000cc000007711117719166ee1669966144e666947711177000cc0000077111177716699166919661994999691711177000cc0000077111177166914169141661999149661111118000cc0000087111171669499169491966199991961111141000cc00000007711116619994669191961999949e1116e61000bc0000000771111e91999916949196499919e111165e1200cc0000000711111191999946199919619949115116b41770cc000000071d111111999469499919e4999111e116161782cc000000001dd1dd1119169199911619911116161e1e1117cc000000001ddddd111119199991e191114416e611111117bc000000001d1d1d1111141111111111116e161611111117bc000000001d111d1ddd1611611116e61e61161e11111118bc0000000044171d1d1d16646111164411611e1117777111cc000000000007111d1d16e661e61ee611e141478888811abc000000000007711ddd1616611111161111000000000777cc0000000000077111111e11e1771eee1880000000000882cc0000000000077111111141117711111000000000000000cc0000000000077111111870777777777000000000000000cc0000000000077111177000000000000000000000000000bc0000000002077111177000000000000000000000000000bc0000000007711117700000000000000000000000000000bc0000000007711117700000000000000000000000000000bc0000000007711770000000000000000000000000000000bc0000000007711770000000000000000000000000000000bc0000000007777000000000000000000000000000000000bc0000000007777000000000000000000000000000000000bc0000000007700000000000000000000000000000000000bc0000000007700000000000000000000000000000000000bc0000000000000000000000000000000000000000000000bc0000000000000000000000000000000000000000000000cc0000000000000000000000000000000000000000000000bc0000000000000000000000000000000000000000000000bc00000000000000000aa00000000da00000000000000000bc00000000000000000aa00000000da00000000000000000bc0000000000000000000000000000000000000000000000bc0000000000000000000000000000000000000000000000bc0000000000000000000000000000000000000000000000cc0000000000000000000000000000000000000000000000cc2222222222222222222222222222222222222222222222bc2222222222222222222222222222222222222222222222cc2222222222222222222222222222222222222222222222cc2222222222222222222222222222222222222222222222cc2222222222222222222222222222222222222222222222cc2222222222222222222222222222222222222222222222cc22222222222222222aa22222222aa22222222222222222cc22222222222222222aa22222222aa22222222222222222cc2222222222222222222222222222222222222222222222cc2222222222222222222222222222222222222222222222cc2222222222222222222222222222222222222222222222cc2222222222222222222222222222222222222222222222bb2322222222222222222222222222222222222222222200bb2222222222222222222222222222222222222222222000bbb30000000000000000000000000000000000000000000bbbb0b000000000000000000000000000000000000000003bbbb30000000000000000000000000000000000000000033bbbc0b030303030303030303030303030303030303030330bbcbb0b33333333333333333333333333333333333333c0bbccbbb0333333333333333333333333333333333333333bbbccbb3c33333333333333333333333333333333333333c3bbcccbb3c333333333333333333333333333333333333333bbcccb3c3b33333333333333333333333333333333333c3bbccccbb3b3333333333333333333333333333333333333cbbcccccbb3c33333333333333333333333333333333333c3bcccccccbb3b333333333333333333333333333333333b3bccccccccb3b3b3333333333333333333333333333333b3bbccccccccbb3b333333333333333333333333333333333bcbcccccccccbb3bb333333333333333333333333333333c3cccccccccccbbc33c3333333333333333333333333333b3bbcccccccccccbbcb3c33333333333333333333333333b3bbcccccccccccccbb3c3c333333333333333333333333c3bcccccccccccccccbbb3b3c3333333333333333333333c3bbbcccccccccccccccbbb3b3c33333333333333333333b3bcbccccccccccccccccccbb3bb3c333333333333333b3c3bbccccccccccccccccccccbbbb3b3c3333333333333c3b3bbbcccccccccccccccccccccccbb3b3b3c3333333c3b3c3bbccccccccccccccccccccccccbbbbcb3b3b33333b3c3ccbbcccccccccccccccccccccccccccccbbccbcccbbbbbcbcccccccccccccccccccccccccccccccccbbbbbbbbbbbbbbbbcccccccccccccccc", 48, 181],
    ["Fist bolt", "#c41a24", "1e1e1e 060606 3c3c3c 2a2a2a 585858 c41a24 8a1018 ffffff b8b8b8 7a7a7a", "111111111111111111111111111111111111111111111111111222222222111111111111111111111111122212211221122211111111111111111111222200320032013222211111111111111111222002201220122012202111111111111111202333323022333230323021111111111111222012201221122113211321211111111111220132313230320132013201322111111111202112201220122012201220122121111111122022003200320032003231323122111111122202200221022002200321132112231111112002002201100000000010023132112111112200200220330002202312002012211231111212202300022020320200200302212213111121320023020020200200200002201321311122210020020000000000003002002211220112320200002000000000005000200000033011210002000000000000000500000030220021120022030000000000000050000000300230112002000000000000000005000000000023011202000000000000000000550000000000021120000000000000000000055000000000002112000000000000000000005500000000000011200000000000000000000555000000000001120000000000000000000055500000000000112000000000000100000001550000000000011200000000000000000000555000000000001120000000000000000000055550000000000112000000000000000000005555000000000011200000000000000000000555500000000001120000000000000000000055555000000000112000000000000000000005555500000000011200000000000000000000555550000000001120000000000000000000055555000000000112000000000000000000005555550000000011200000000000011000000155555000000001120000000000000000000055555500000000112000000000000000000005555550000000011200000000000000006000555555500000001120000000000000000550055555550000000112000000000000000055505555555000000011200000000000000035555555555550000001120000000000000003555555555555000000112000000000000000055555555555500000011200000000000000035555555555550000001120000000000000000555555555555500000112000000000000000055555555555550000011200000000000000005555555500555000001120000000000000000555555550005550000112000000000000000355555555000055000011200000000000000035555555500000500001120000000000000003555555550000000000112000000000011111355555555000000000011200000000011740135555555500000000001120000000011771110555555551111100000112000000011777111055555551117211000011211100011777911655555111177777110001127721001377701165551117077777721000112738111177770116561177777777777100011211112127777111661177777777777110001120011810777711111371777777901110000112001371777777111112711199777771100011200013177770111111177777777977711001120001111977711100777077779779772100112000011177790110007773777077777110011200001139777711037777777777777211001120000019777773111131011110931111000112000011777777931111111777777777110011200000117177774111177077777777771101120000011119777831131117777477777110112000001117777772111131177477717110011200000011977774116177711277771110001120000000137777756371171111111110000112000000011777773057117187722111000011200000001177774663707311777721000001120000000117779266377735117771100000112000000001170790097777551121110000011200000000112779878777755511110000001120000000001171977777775550000000000112000000000019197777777750001000000011200000000001138777777735000000000001120000000000011111377779500000000000112000000000000006611130550000000000011200000005500000655555555000000000001120000000055000065555555500000000000112000000005550006555555550000000000011200000000555556655555555000000000001120000000055555555555555500000000000112000000000555555555555550000000000011200000000055555555555555000000000001120000000005555555555555500000000000112000000000555555555555550000000000011200000000055555555555555000000000001120000000000555555555055500000000000112000000000055555555500550000000000011200000000005555555550015000000000001120000000000555555555000000000000000112000000000055555555500000000000000011200000000000555555550000000000000001120000000000055555550000000000000000112000000000005555555000000000000000011200000000000555555500000000000000001120000000000031655550012000000000000112000000000000655555000000000000000011200000000000055555500000000000000001120000000000005555550000000000000000112000000000000555555000000000000000011200000000000006555600000000000000001120000000000000655560000000000000000112000000000000065556000000000000000011200000000000006556000000000000000001120000000000000655600000000000000000112200000000001006560000100000000000011220000000000211656000120000000000201121020000000000065600000000000000212112200200000000006560000000000000203211202000200000000366000000000020000201122020202000000006600000000002020202112020202020202030360002020202020202111200202020200000036020020202020202001120000020200202033030200202020200000112000000020203030030202002020000000011200000000002030330303020200000000001112000000000000300302000000000000001111200000000000000000000000000000000111120000000000000000000000000000000011111200000000000000000000000000000011111120000000000000000000000000000001111111200000000000000000000000000001111111120000000000000000000000000000111111111200000000000000000000000000111111111120000000000000000000000000111111111111200000000000000000000000111111111111112000000000000000000000111111111111111110000000000000000000111111111111111111100000000000000000111111111111111111111100000000000001111111111111111111111111111111111111111111111111", 37, 138],
    CREATED,
    CREATED,
    CREATED,
    CREATED,
    ["Siren", "#f2f2ee", "c0262c ffd6d6 ffffff f2f2ee 17171c 1f4fbf d6e4ff", "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000010000000000100001000010000001000100010000000011111010000000001122110000000000122221000000111112222101111000001122110000000000011110000000000010000010000000010001000100000010000100001000000000010000000000000001000000000000000000000003333333333333333444444444444444455555555555555555555555555555555555555556555555555555555655555555556555565555655555565556555655555555666665655555555566226655555555556222265555556666622226566665555566226655555555555666655555555555655555655555555655565556555555655556555565555555555655555555555555565555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555"],
    ["Camo", "#3d4a2a", "7a8a52 55693a 1d221a 3d4a2a 6b5a3a", "000112200000000000112222000000330112222200000333011222220000033331122222000033333112222200003333311122220000333333112220000033333331140000003333333444333000034433334431110004443333331111133444333332111133344433333311113334443333331111333444333332111111134433333211111111113333321111111111333322111111111123322211111111112222201111111111332204444111111133301444441111113333444444411111333344444444111113334444444431111133444444443333111344444444333311134444444443331113444444444333111244444444433311322444444444441122224444444444222222244044444422222224400444442222222441344444222222111334444422222111113444442222211111344444022222111133444402222211113344440222221111333444022222011233333300222002223333310002000222233311000000022221111100000002221111110000000002111110"],
    ["Skyline", "#ffd23f", "1a1440 e9e3ff f4f0d8 ffffff 2a1d5c 10101c ffd23f 4a2a6e", "000000000000000000000000000000000000000000000000000000001000000000001000000000000000000000222000003000000222220000000000022222000000000000222000000000000000000000010000000001000000000000000000000000300000003000030000000000004444444444441444444444444444444443444444444444444444444344444444344144444344444444444444444444444444414444444444444444444444444444444444444444444444444444444444444554444444444444455444444444445555677777777777555557777775555556555777777555555555677777756565555557777775555556555777777555555555677777756565555555555555555555555555555555555555555555656555555555555555555556555555555555555555656555556565555555555555555555555555555555555555556555655565555555555555555555555555555555555555556565556555555555555555555555555555555555555555555555555555"]
  ];
  const DESIGNS = ART.map(([name, wheels, pal, px, w = TW, h = TH]) => {
    const p = pal.split(" ").map(h => hex("#" + h)), tex = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) tex.set(p[parseInt(px[i], 16)], i * 3);
    tex.w = w; tex.h = h;
    return { name, wheels: hex(wheels), tex };
  });
  const GRIP = (() => { // dark grip tape with a little grit
    const t = new Uint8Array(TW * TH * 3); let s = 9;
    for (let i = 0; i < TW * TH; i++) { s = (s * 1103515245 + 12345) >>> 0; t.set((s >>> 16) % 5 === 0 ? [62, 65, 71] : [36, 38, 43], i * 3); }
    t.w = TW; t.h = TH;
    return t;
  })();
  const WOOD = hex("#c9a46b"), TRUCK = hex("#aab4bf"), PLATE = hex("#7d8794");

  // ---- the board: a curved, rounded deck with trucks and wheels underneath ----
  function face(out, v, uv, tex, col, hint) {
    let n = cross(sub(v[1], v[0]), sub(v[2], v[0]));
    if (dot(n, hint) < 0) { v = v.slice().reverse(); uv = uv && uv.slice().reverse(); n = mul(n, -1); }
    if (Math.hypot(...n) > 1e-9) out.push({ v, uv, tex, col, n: norm(n) });
  }
  function box(out, p, size, col) {
    const k = [];
    for (const dz of [-1, 1]) for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) k.push([p[0] + dx * size[0] / 2, p[1] + dy * size[1] / 2, p[2] + dz * size[2] / 2]);
    for (const q of [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) {
      const v = q.map(i => k[i]); face(out, v, null, null, col, sub(avg(v), p));
    }
  }
  function wheel(out, c, r, w, col) { // a 6-sided wheel turning on the x axis
    const ring = s => Array.from({ length: 6 }, (_, k) => add(c, [s * w / 2, Math.cos(k * Math.PI / 3) * r, Math.sin(k * Math.PI / 3) * r]));
    const a = ring(-1), b = ring(1);
    face(out, a, null, null, col, [-1, 0, 0]); face(out, b, null, null, col, [1, 0, 0]);
    for (let k = 0; k < 6; k++) { const v = [a[k], a[(k + 1) % 6], b[(k + 1) % 6], b[k]]; face(out, v, null, null, col, sub(avg(v), c)); }
  }
  function board(design) {
    const out = [], N = 16, R = WID / 2;
    const half = y => { const a = Math.abs(y), s = LEN / 2 - R; return a <= s ? R : Math.sqrt(Math.max(0, R * R - (a - s) ** 2)); };
    const lift = y => { const a = Math.abs(y), s = LEN / 2 - .3; return a > s ? (a - s) ** 2 * 1.4 : 0; };   // kicktails curve up
    const st = Array.from({ length: N + 1 }, (_, i) => { const y = LEN / 2 - LEN * i / N; return { y, h: half(y), z: lift(y), v: i / N }; });
    for (let i = 0; i < N; i++) {
      const a = st[i], b = st[i + 1];
      for (const side of [-1, 1]) {
        const P = (s, x, top) => [x * s.h, s.y, s.z + (top ? THICK / 2 : -THICK / 2)];
        const U = (s, x) => [.5 + x * s.h / WID, s.v];
        // grip on top, the graphic underneath, wood along the edge
        face(out, [P(a, 0, 1), P(a, side, 1), P(b, side, 1), P(b, 0, 1)], [U(a, 0), U(a, side), U(b, side), U(b, 0)], GRIP, null, [0, 0, 1]);
        face(out, [P(a, 0, 0), P(a, side, 0), P(b, side, 0), P(b, 0, 0)], [U(a, 0), U(a, side), U(b, side), U(b, 0)], design.tex, null, [0, 0, -1]);
        face(out, [P(a, side, 1), P(b, side, 1), P(b, side, 0), P(a, side, 0)], null, null, WOOD, [side, 0, 0]);
      }
    }
    for (const y of [LEN / 2 - .34, -(LEN / 2 - .34)]) {
      box(out, [0, y, -THICK / 2 - .015], [.17, .11, .03], PLATE);
      box(out, [0, y, -THICK / 2 - .06], [.36, .05, .05], TRUCK);
      for (const x of [-.2, .2]) wheel(out, [x, y, -THICK / 2 - .075], .062, .055, design.wheels);
    }
    return out;
  }

  // ---- drawing ----
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const LIGHT = norm([-.4, .6, -.7]);
  let canvas = null, ctx = null, img = null, theta = .35, boost = 0, last = 0, running = false, who = -1, faces = [], design = DESIGNS[0];
  function draw() {
    const px = img.data; px.fill(0);
    const ct = Math.cos(theta), sn = Math.sin(theta), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
    const rot = q => { const x = q[0] * ct + q[2] * sn, z = -q[0] * sn + q[2] * ct; return [x, q[1] * cp - z * sp, q[1] * sp + z * cp]; };
    const view = q => { const r = rot(q); return [r[0], r[1] - CY, r[2] + DIST]; };
    const proj = q => [Math.round(W / 2 + F * q[0] / q[2]), Math.round(H / 2 - F * q[1] / q[2])];
    const plot = (x, y, c, a) => {
      const i = (y * W + x) * 4, off = BAYER[(y & 3) * 4 + (x & 3)] / 2 - 4;
      for (let k = 0; k < 3; k++) {
        let v = a < 1 ? px[i + k] * (1 - a) + c[k] * a : c[k];
        v = Math.max(0, Math.min(255, v + off)) >> 3;              // PS1 colour depth: 5 bits per channel, dithered
        px[i + k] = (v << 3) | (v >> 2);
      }
      px[i + 3] = a < 1 ? Math.max(px[i + 3], Math.round(a * 255)) : 255;
    };
    // affine texturing: texture position is blended in screen space, so it warps like on a PS1
    const tri = (a, b, c, ua, ub, uc, tex, col, shade, alpha) => {
      let area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (area === 0) return;
      if (area < 0) { [b, c] = [c, b]; [ub, uc] = [uc, ub]; area = -area; }
      const x0 = Math.max(0, Math.min(a[0], b[0], c[0])), x1 = Math.min(W - 1, Math.max(a[0], b[0], c[0]));
      const y0 = Math.max(0, Math.min(a[1], b[1], c[1])), y1 = Math.min(H - 1, Math.max(a[1], b[1], c[1]));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const qx = x + .5, qy = y + .5;
        const w0 = (c[0] - b[0]) * (qy - b[1]) - (c[1] - b[1]) * (qx - b[0]);
        const w1 = (a[0] - c[0]) * (qy - c[1]) - (a[1] - c[1]) * (qx - c[0]);
        const w2 = (b[0] - a[0]) * (qy - a[1]) - (b[1] - a[1]) * (qx - a[0]);
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        let rgb = col;
        if (tex) {
          const u = (w0 * ua[0] + w1 * ub[0] + w2 * uc[0]) / area, v = (w0 * ua[1] + w1 * ub[1] + w2 * uc[1]) / area;
          const tw = tex.w, th = tex.h;
          const t = (Math.min(th - 1, Math.max(0, v * th | 0)) * tw + Math.min(tw - 1, Math.max(0, u * tw | 0))) * 3;
          rgb = [tex[t], tex[t + 1], tex[t + 2]];
        }
        plot(x, y, [rgb[0] * shade, rgb[1] * shade, rgb[2] * shade], alpha);
      }
    };
    const sh = Array.from({ length: 12 }, (_, k) => proj(view([Math.cos(k / 12 * 2 * Math.PI) * .32, -LEN / 2 - .14, Math.sin(k / 12 * 2 * Math.PI) * .2])));
    for (let k = 1; k < 11; k++) tri(sh[0], sh[k], sh[k + 1], null, null, null, null, [0, 0, 0], 1, .35);
    const list = [];
    for (const f of faces) {
      const v = f.v.map(view), n = rot(f.n);
      if (dot(n, v[0]) >= 0) continue;                              // facing away from the camera
      list.push({ s: v.map(proj), uv: f.uv, tex: f.tex, col: f.col, z: v.reduce((s, q) => s + q[2], 0) / v.length, shade: Math.min(1.15, .45 + .7 * Math.max(0, dot(n, LIGHT))) });
    }
    list.sort((a, b) => b.z - a.z);                                 // far faces first
    for (const f of list) for (let k = 1; k + 1 < f.s.length; k++)
      tri(f.s[0], f.s[k], f.s[k + 1], f.uv && f.uv[0], f.uv && f.uv[k], f.uv && f.uv[k + 1], f.tex, f.col, f.shade, 1);
    ctx.putImageData(img, 0, 0);
  }
  function loop(t) {
    if (!canvas || !canvas.isConnected) { running = false; return; }
    if (t - last >= 1000 / 24) {                                    // about 24 frames a second, like a PS1 select screen
      if (last && canvas.offsetParent) {
        const dt = Math.min(100, t - last) / 1000;
        theta += dt * (1 + boost); boost *= Math.exp(-dt * 4); draw();
      }
      last = t;
    }
    requestAnimationFrame(loop);
  }
  function use(n) {
    n = ((n | 0) % DESIGNS.length + DESIGNS.length) % DESIGNS.length;
    if (n === who) return;
    if (who >= 0) boost = 9;                                // a quick extra spin when the deck changes
    who = n; design = DESIGNS[n]; faces = board(design);
    if (ctx) draw();
  }
  // the same canvas moves into each re-render, so the spin carries on smoothly
  function el(n) {
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H; canvas.className = "deck-view";
      canvas.setAttribute("aria-hidden", "true");
      try { ctx = canvas.getContext("2d"); } catch (e) { ctx = null; }
      if (ctx) img = ctx.createImageData(W, H);
    }
    use(n);
    canvas.title = `${design.name} deck`;
    start();
    return canvas;
  }
  function start() { if (ctx && !running && typeof requestAnimationFrame === "function") { running = true; last = 0; requestAnimationFrame(loop); } }
  // draw one exact pose (used to check the decks frame by frame)
  function pose(a, n) { if (!ctx) return null; use(n); boost = 0; theta = a; draw(); return canvas.toDataURL(); }
  return { el, pose, names: () => DESIGNS.map(d => d.name) };
})();

// --- skaters tab ---
function renderRoster() {
  // a game-style carousel: one skater at a time, with arrows either side (it wraps around)
  const box = $("roster"), d = st.save, n = st.skater, total = Core.SKATERS, s = Core.skater(d, n);
  const prev = (n + total - 1) % total, next = (n + 1) % total;
  const kindText = { pro: "Pro skater", created: "Created skater", secret: "Secret skater" }[s.kind];
  const groups = [["Pros", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]], ["Created skaters", [13, 14, 15, 16]], ["Secret skaters", [17, 18, 19]]];
  const pick = h("select", { class: "roster-pick", id: "roster-pick", "aria-label": "Jump to a skater" });
  for (const [title, list] of groups) {
    const og = h("optgroup", { label: title });
    for (const k of list) { const o = Core.skater(d, k); og.append(h("option", { value: k, text: o.name + (o.locked ? " (locked)" : "") })); }
    pick.append(og);
  }
  pick.value = n;
  box.replaceChildren(
    h("span", { class: "pnl-tab", "aria-hidden": "true" }, "Select skater"),
    h("div", { class: "picker-row" },
      h("button", { class: "picker-arrow prev", type: "button", id: "sk-prev", "data-act": "skater", "data-n": prev, "aria-label": `Previous skater: ${Core.skaterName(d, prev)}`, title: `Previous: ${Core.skaterName(d, prev)}` }),
      h("div", { class: "picker-mid" },
        Deck.el(n),
        h("h2", { class: "picker-name" + (st.slide ? ` slide-${st.slide}` : ""), id: "picker-name", text: s.name }),
        h("p", { class: "picker-sub" }, `${kindText}, ${n + 1} of ${total}`, s.locked ? h("span", { class: "lock", text: "Locked" }) : null)),
      h("button", { class: "picker-arrow next", type: "button", id: "sk-next", "data-act": "skater", "data-n": next, "aria-label": `Next skater: ${Core.skaterName(d, next)}`, title: `Next: ${Core.skaterName(d, next)}` })),
    h("label", { class: "picker-jump", for: "roster-pick" }, h("span", { class: "m-lab", text: "Jump to:" }), pick));
  st.slide = null;
}

function stepper(id, label, value, lo, hi, act, extra = {}) {
  return h("div", { class: "stepper", role: "group", "aria-label": label },
    h("button", { class: "step", type: "button", id: `${id}-minus`, "data-act": act, "data-d": -1, "aria-label": `${label}: one less`, disabled: value <= lo, ...extra }, "−"),
    h("output", { text: `${value} of ${hi}` }),
    h("button", { class: "step", type: "button", id: `${id}-plus`, "data-act": act, "data-d": 1, "aria-label": `${label}: one more`, disabled: value >= hi, ...extra }, "+"));
}

function renderSkater() {
  const d = st.save, n = st.skater, s = Core.skater(d, n);
  const stats = h("div", { class: "stats" }, Core.STATS.flatMap((name, i) => {
    const v = s.stats[i];
    const dots = h("span", { class: "dots", "aria-hidden": "true" });
    for (let k = 1; k <= Core.MAX_STAT; k++) dots.append(h("span", { class: "blk" + (k <= v ? " on" : ""), "data-act": "stat-set", "data-i": i, "data-v": k, title: `Set ${name} to ${k}` }));
    return [
      h("span", { class: "stat-name", id: `stat-name-${i}`, text: name }),
      dots,
      h("span", { class: "stat-ctl" },
        h("button", { class: "step", type: "button", id: `stat-${i}-minus`, "data-act": "stat", "data-i": i, "data-d": -1, "aria-label": `${name}: one less`, disabled: v <= 0 }, "−"),
        h("button", { class: "step", type: "button", id: `stat-${i}-plus`, "data-act": "stat", "data-i": i, "data-d": 1, "aria-label": `${name}: one more`, disabled: v >= Core.MAX_STAT }, "+"),
        h("span", { class: "stat-val", text: v, "aria-label": `${name} is ${v} of 10` })),
    ];
  }));
  const statsCard = pnl("Stats", { label: `${s.name}'s stats` },
    stats,
    h("div", { class: "row-acts" },
      h("button", { class: "btn", type: "button", id: "max-stats", "data-act": "max-stats" }, "Max all stats"),
      h("button", { class: "btn", type: "button", id: "complete-career", "data-act": "complete-career" }, "Complete career")));

  const [dlo, dhi] = s.deckRange;
  const moneyCard = pnl("$$$", { label: "Money and decks" },
    h("div", { class: "money" },
      h("label", { class: "m-lab", for: "earn", text: "Career total:" }),
      h("span", { class: "m-val" }, h("span", { class: "m-cur", text: "$" }),
        h("input", { type: "number", id: "earn", min: 0, max: Core.MAX_MONEY, step: 1, inputmode: "numeric", value: s.earn })),
      h("label", { class: "m-lab", for: "cash", text: "Cash:" }),
      h("span", { class: "m-val" }, h("span", { class: "m-cur", text: "$" }),
        h("input", { type: "number", id: "cash", min: 0, max: Core.MAX_MONEY, step: 1, inputmode: "numeric", value: s.cash })),
      h("span", { class: "m-lab", text: "Decks:" }),
      stepper("decks", "Decks unlocked", s.decks, dlo, dhi, "decks")),
    h("p", { class: "hint", style: "margin:14px 0 0", text: "Levels open as the career total grows, and with medals for some levels, just like in the game. Cash is what's left to spend, so it can't be more than the career total. The most a skater can earn is $150,000." }));

  const profileCard = s.kind === "created" ? pnl("Profile", { label: "Created skater's name and hometown" },
    h("div", { class: "money" },
      h("label", { class: "m-lab", for: "cas-name", text: "Name:" }),
      h("input", { type: "text", id: "cas-name", class: "cas-text", value: Core.casText(d, n, "name"), maxlength: 15, autocomplete: "off", spellcheck: "false", "data-act": "cas-name" }),
      h("label", { class: "m-lab", for: "cas-town", text: "Hometown:" }),
      h("input", { type: "text", id: "cas-town", class: "cas-text", value: Core.casText(d, n, "town"), maxlength: 15, autocomplete: "off", spellcheck: "false", "data-act": "cas-town" })),
    h("p", { class: "hint", style: "margin:12px 0 0", text: "Letters, numbers, spaces and hyphens, up to 15 characters." })) : null;

  const medalsCard = pnl("Medals", null,
    h("div", { class: "medals" }, COMPS.map((l, k) => {
      const L = Core.LEVELS[l], gold = s.levels[l].gold;
      return h("div", { class: "medal" },
        h("button", { class: "coin", type: "button", id: `coin-${l}`, "data-act": "medal", "data-l": l, "aria-pressed": gold ? "true" : "false", "aria-label": `${L.name} gold medal`, title: gold ? `Take away the ${L.name} gold medal` : `Give the ${L.name} gold medal` }, String(k + 1)),
        h("span", { class: "medal-name", text: L.name }));
    })));

  const career = pnl("Career", null,
    h("div", { class: "levels" }, Core.LEVELS.map((L, l) => levelRow(L, l, s.levels[l]))));

  $("skater").replaceChildren(h("div", { class: "sk-grid" }, statsCard, h("div", { class: "sk-side" }, profileCard, moneyCard, medalsCard)), career);
}

function levelRow(L, l, lv) {
  let prog, done = false;
  if (L.kind === "goals") { prog = `${lv.done} of 10 goals`; done = lv.done === 10; }
  else if (L.kind === "comp") { prog = lv.gold ? "Gold medal" : lv.medal ? "Medal, not gold" : "No medal"; done = lv.gold; }
  else prog = "Secret level, no goals";
  const cash = L.icons ? `${lv.icons} of ${L.icons} cash icons` : "";
  const det = h("details", { class: "level", open: st.open.has(l) },
    h("summary", { id: `lv-${l}` }, h("span", { class: "lv-name", text: L.name }), h("span", { class: "lv-prog" + (done ? " done" : ""), text: prog }), h("span", { class: "lv-cash", text: cash })));
  det.addEventListener("toggle", () => { if (det.open) st.open.add(l); else st.open.delete(l); });

  const body = h("div", { class: "lv-body" }, h("p", { class: "hint", text: L.needs }));
  if (L.kind === "goals") {
    body.append(h("ul", { class: "goals" }, L.goals.map((g, b) => {
      const on = (lv.goals >> b & 1) === 1;
      if (b === 9) return h("li", null, h("label", { class: "auto", title: "Ticks itself when every other goal and cash icon is done" },
        h("input", { type: "checkbox", checked: on, disabled: true }), `${g} (ticks itself)`));
      return h("li", null, h("label", { for: `g-${l}-${b}` },
        h("input", { type: "checkbox", id: `g-${l}-${b}`, checked: on, "data-act": "goal", "data-l": l, "data-b": b }), g));
    })));
  }
  if (L.kind === "comp") {
    body.append(h("label", { class: "check", for: `gold-${l}` },
      h("input", { type: "checkbox", id: `gold-${l}`, checked: lv.gold, "data-act": "gold", "data-l": l }), "Gold medal"));
  }
  if (L.icons) {
    body.append(h("div", { class: "lv-tools" },
      h("span", { class: "m-lab", text: "Cash icons:" }), stepper(`icons-${l}`, `${L.name} cash icons`, lv.icons, 0, L.icons, "icons", { "data-l": l }),
      h("button", { class: "btn small", type: "button", id: `complete-${l}`, "data-act": "complete-level", "data-l": l }, "Complete this level")));
  }
  det.append(body);
  return det;
}

// --- gap list tab ---
function renderGaps() {
  const d = st.save, found = Core.totalFound(d);
  const levels = Core.LEVELS.map((L, l) => {
    const f = Core.gapsFound(d, l);
    const det = h("details", { class: "level gap-level", open: st.gapOpen.has(l), "data-l": l },
      h("summary", { id: `gl-${l}` },
        h("span", { class: "lv-name", text: L.name }),
        h("span", { class: "lv-prog" + (f === L.gaps ? " done" : ""), text: `${f} of ${L.gaps} found` }),
        h("span", { class: "meter", "aria-hidden": "true" }, h("i", { style: `width:${(100 * f / L.gaps).toFixed(1)}%` }))));
    // while searching, levels open and close with the results, so don't remember that
    det.addEventListener("toggle", () => { if (st.gapQuery.trim()) return; if (det.open) st.gapOpen.add(l); else st.gapOpen.delete(l); });
    det.append(h("div", { class: "lv-body" },
      h("div", { class: "row-acts", style: "margin:2px 0 10px" },
        h("button", { class: "btn small", type: "button", id: `gaps-all-${l}`, "data-act": "gaps", "data-l": l, "data-on": 1, disabled: f === L.gaps, "aria-label": `Tick off every gap in ${L.name}` }, "Tick all"),
        h("button", { class: "btn small", type: "button", id: `gaps-none-${l}`, "data-act": "gaps", "data-l": l, "data-on": 0, disabled: f === 0, "aria-label": `Untick every gap in ${L.name}` }, "Untick all")),
      h("ul", { class: "gap-grid" }, Core.GAP_NAMES[l].map(([name, pts], i) =>
        h("li", { class: "gap-item", "data-name": name.toLowerCase() },
          h("label", { for: `gap-${l}-${i}` },
            h("input", { type: "checkbox", id: `gap-${l}-${i}`, checked: Core.gapOn(d, l, i), "data-act": "gap", "data-l": l, "data-i": i }),
            h("span", { class: "gap-name", text: name }),
            h("span", { class: "gap-pts", text: fmt(pts), "aria-label": `${fmt(pts)} points` })))))));
    return det;
  });
  $("panel-gaps").replaceChildren(pnl("Gap list", null,
    h("p", { class: "gap-total", text: `${found} of ${Core.TOTAL_GAPS} gaps found` }),
    h("p", { class: "hint", text: "Tick off the gaps you've landed. The gap list is shared by all skaters. When every gap is found, the game unlocks Private Carrera the next time you land a gap. To unlock her straight away, use Cheats and unlocks." }),
    h("div", { class: "gap-tools" },
      h("button", { class: "btn", type: "button", id: "gaps-everything", "data-act": "gaps-everything", disabled: found === Core.TOTAL_GAPS }, "Tick every gap"),
      h("label", { for: "gap-search" }, h("span", { class: "caps", text: "Find a gap" }),
        h("input", { type: "search", id: "gap-search", value: st.gapQuery, placeholder: "Gap name", autocomplete: "off", spellcheck: "false" })),
      h("span", { id: "gap-search-msg", class: "hint", role: "status" })),
    h("div", { class: "levels" }, levels)));
  applyGapFilter();
}
// show only gaps whose name contains the search text, and open the levels that have matches
function applyGapFilter() {
  const q = st.gapQuery.trim().toLowerCase();
  let shown = 0;
  for (const det of document.querySelectorAll(".gap-level")) {
    let any = false;
    for (const li of det.querySelectorAll(".gap-item")) { const on = !q || li.getAttribute("data-name").includes(q); li.hidden = !on; if (on) { any = true; shown++; } }
    det.hidden = !!q && !any;
    det.open = q ? any : st.gapOpen.has(Number(det.getAttribute("data-l")));
  }
  const msg = $("gap-search-msg");
  if (msg) msg.textContent = !q ? "" : shown ? `${shown} ${shown === 1 ? "gap matches" : "gaps match"}.` : "No gaps match that name.";
}

// --- high scores tab ---
function renderScores() {
  const d = st.save;
  const names = Array.from({ length: Core.SKATERS }, (_, n) => Core.skaterName(d, n));
  const show = ini => ini.replace(/[^\x20-\x7E]/g, "?");
  const levels = Core.LEVELS.map((L, t) => {
    const rows = Core.highScores(d, t);
    const det = h("details", { class: "level hs-level", open: st.hsOpen.has(t) },
      h("summary", { id: `hl-${t}` },
        h("span", { class: "lv-name", text: L.name }),
        h("span", { class: "lv-prog", text: `Top score ${fmt(rows[0].score)}` }),
        h("span", { class: "lv-cash", text: show(rows[0].initials).trim() })));
    det.addEventListener("toggle", () => { if (det.open) st.hsOpen.add(t); else st.hsOpen.delete(t); });
    det.append(h("div", { class: "lv-body" }, h("div", { class: "wide-scroll" }, h("table", { class: "hs-table" },
      h("thead", null, h("tr", null, h("th", { text: "#" }), h("th", { text: "Initials" }), h("th", { text: "Skater" }), h("th", { text: "Score" }))),
      h("tbody", null, rows.map((r, i) => {
        const where = `${L.name}, place ${i + 1}`;
        const pick = h("select", { id: `hs-${t}-${i}-sk`, "data-act": "hs-skater", "data-t": t, "data-i": i, "aria-label": `${where}, skater` },
          names.map((nm, n) => h("option", { value: n, text: nm })));
        if (r.skater < Core.SKATERS) pick.value = r.skater; else pick.prepend(h("option", { value: r.skater, text: "Unknown", selected: true }));
        return h("tr", null,
          h("td", { class: "hs-rank", text: i + 1 }),
          h("td", null, h("input", { type: "text", class: "ini", id: `hs-${t}-${i}-ini`, value: show(r.initials).trimEnd(), maxlength: 3, autocomplete: "off", spellcheck: "false", "data-act": "hs-ini", "data-t": t, "data-i": i, "aria-label": `${where}, initials` })),
          h("td", null, pick),
          h("td", null, h("input", { type: "number", id: `hs-${t}-${i}-score`, min: 0, max: Core.MAX_SCORE, step: 1, inputmode: "numeric", value: r.score, "data-act": "hs-score", "data-t": t, "data-i": i, "aria-label": `${where}, score` })));
      }))))));
    return det;
  });
  $("panel-scores").replaceChildren(pnl("High scores", null,
    h("p", { class: "hint", text: "Each level keeps its top 8 scores. Initials are up to 3 letters and scores go up to 9,999,999. Each table stays in order from highest to lowest, like in the game." }),
    h("div", { class: "levels" }, levels)));
}
function onScore(el) {
  const act = el.getAttribute("data-act"), t = num(el, "data-t"), i = num(el, "data-i"), L = Core.LEVELS[t];
  const cur = Core.highScores(st.save, t)[i], entry = { ...cur };
  if (act === "hs-ini") {
    const v = Core.cleanInitials(el.value);
    if (!v) { el.value = cur.initials.trimEnd(); status("Initials need at least one letter from A to Z.", "err"); return; }
    entry.initials = v;
  } else if (act === "hs-score") entry.score = Math.max(0, Math.min(Core.MAX_SCORE, Math.floor(Number(el.value) || 0)));
  else entry.skater = Number(el.value);
  const at = Core.setHighScore(st.save.slice(), t, i, entry);   // where it will land once the table re-sorts
  edit(x => Core.setHighScore(x, t, i, entry),
    `${L.name} high scores: ${entry.initials.trim()} with ${fmt(entry.score)} by ${Core.skaterName(st.save, entry.skater)}` + (at !== i ? `, now in place ${at + 1}.` : "."));
  // the table re-sorts, so follow the entry to its new place
  const want = $(`hs-${t}-${at}-${act === "hs-ini" ? "ini" : act === "hs-score" ? "score" : "sk"}`);
  if (want) want.focus();
}
function onCasText(el) {
  const n = st.skater, which = el.id === "cas-name" ? "name" : "town", v = el.value.trim(), old = Core.casText(st.save, n, which);
  if (!Core.validCasText(v)) { el.value = old; status("Use letters, numbers, spaces and hyphens only, from 1 to 15 characters.", "err"); return; }
  edit(x => Core.setCasText(x, n, which, v), which === "name" ? `Created skater renamed to ${v}.` : `Hometown set to ${v}.`);
}

// --- cheats and unlocks tab ---
function check(id, act, on, label, small, extra = {}) {
  return h("label", { class: "check", for: id }, h("input", { type: "checkbox", id, checked: on, "data-act": act, ...extra }), h("span", null, label, small ? h("small", { text: small }) : null));
}
function renderUnlocks() {
  const d = st.save;
  const cheats = [];
  for (let i = 3; i < Core.CHEAT_NAMES.length; i++) cheats.push(check(`cheat-${i}`, "cheat", Core.cheatUnlocked(d, i), Core.CHEAT_NAMES[i], null, { "data-i": i }));
  const allCheats = Core.CHEAT_NAMES.every((_, i) => i < 3 || Core.cheatUnlocked(d, i));
  $("panel-unlocks").replaceChildren(
    pnl("Secret skaters", null,
      h("p", { class: "hint", text: "Unlocked secret skaters appear on the skater select screen." }),
      h("div", { class: "checks" },
        check("cheat-0", "cheat", Core.cheatUnlocked(d, 0), "McSqueeb", "Tony Hawk's 1980s style", { "data-i": 0 }),
        check("cheat-1", "cheat", Core.cheatUnlocked(d, 1), "Spider-Man", null, { "data-i": 1 }),
        check("cheat-2", "cheat", Core.cheatUnlocked(d, 2), "Officer Dick", null, { "data-i": 2 }),
        check("carrera", "carrera", Core.carrera(d), "Private Carrera", null))),
    pnl("Secret levels", { style: "margin-top:34px" },
      h("div", { class: "checks" },
        check("secret-levels", "secret-levels", Core.secretLevels(d), "Chopper Drop and Skate Heaven", "Open for every skater"))),
    pnl("Cheats", { style: "margin-top:34px" },
      h("p", { class: "hint", text: "Unlocked cheats appear in the game's cheat menu, where you can turn each one on or off." }),
      h("div", { class: "checks" }, cheats),
      h("div", { class: "row-acts" }, h("button", { class: "btn", type: "button", id: "all-cheats", "data-act": "all-cheats", disabled: allCheats }, "Unlock all cheats"))));
}

// --- menu ---
const TABS = { skaters: "Skaters", gaps: "Gap List", scores: "High Scores", unlocks: "Unlocks" };
function showTab(name) {
  st.tab = name;
  for (const t of Object.keys(TABS)) {
    const on = t === name, tab = $(`tab-${t}`);
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.classList.toggle("sel-arrows", on);
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  banner(TABS[name]);
}

// --- dialog ---
function modal(title, html, buttons) {
  return new Promise(res => {
    const back = $("dlg-back"), box = $("dlg-btns"), opener = document.activeElement;
    $("dlg-title").textContent = title; $("dlg-body").innerHTML = html; box.replaceChildren();
    const done = v => { back.classList.remove("on"); document.removeEventListener("keydown", onKey, true); if (opener && opener.focus) opener.focus(); res(v); };
    const onKey = e => {
      if (e.key === "Escape") { e.preventDefault(); done(null); }
      if (e.key === "Tab") { // keep focus inside the dialog
        const f = [...box.querySelectorAll("button")], i = f.indexOf(document.activeElement);
        e.preventDefault(); f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
    };
    for (const b of buttons) box.append(h("button", { class: "btn" + (b.primary ? " primary" : ""), type: "button" }, b.label));
    [...box.children].forEach((el, k) => el.addEventListener("click", () => done(buttons[k].value ?? null)));
    back.classList.add("on");
    document.addEventListener("keydown", onKey, true);
    box.firstChild.focus();
  });
}
const ask = (title, html) => modal(title, html, [{ label: "Yes", value: true, primary: true }, { label: "No", value: false }]).then(v => v === true);

// --- saving ---
// claude.ai offers files through its downloads capability; anywhere else a normal download link works
let downloadsP = null;
function getDownloads() {
  if (!downloadsP) downloadsP = window.claude && typeof window.claude.use === "function" ? window.claude.use("downloads").catch(() => null) : Promise.resolve(null);
  return downloadsP;
}
async function saveAll() {
  if (!st.save) return;
  if (!(await ask("Save?", "<p>Make a new copy of your memory card with these changes? Your original file isn't changed.</p>"))) return;
  const card = st.card;
  Core.writeSave(card, card.saves[st.saveIdx], st.save);
  const out = Core.cardFile(card);
  const name = st.fileName || "memorycard.mcd";
  const base = name.replace(/\.[^.]+$/, "") || "memorycard";
  let savedAs;
  try {
    const downloads = await getDownloads();
    if (downloads) {
      // memory card extensions aren't allowed here, so the card goes inside a zip
      const zipName = `${base}-edited.zip`;
      await downloads.save({ filename: zipName, data: makeZip(name, out) });
      savedAs = `Saved as ${zipName}. Unzip it, then swap the memory card file into your emulator's memory card folder.`;
    } else {
      const a = h("a", { href: URL.createObjectURL(new Blob([out], { type: "application/octet-stream" })), download: name });
      document.body.append(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      savedAs = `Saved as ${name}. Check your downloads folder, then swap it into your emulator's memory card folder.`;
    }
    st.base = st.save.slice();
    $("reset").disabled = true;
    status(savedAs, "good");
  } catch (e) {
    status(e && e.code === "declined" ? "Save cancelled. Your changes are still here." : "The download couldn't start. Try again.", "err");
  }
}
// zip with one stored (uncompressed) file
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip(filename, data) {
  const name = new TextEncoder().encode(filename), crc = crc32(data), size = data.length;
  const local = new Uint8Array(30 + name.length), central = new Uint8Array(46 + name.length), end = new Uint8Array(22);
  const L = new DataView(local.buffer), C = new DataView(central.buffer), E = new DataView(end.buffer);
  L.setUint32(0, 0x04034b50, true); L.setUint16(4, 20, true); L.setUint16(8, 0, true);
  L.setUint32(14, crc, true); L.setUint32(18, size, true); L.setUint32(22, size, true); L.setUint16(26, name.length, true);
  local.set(name, 30);
  C.setUint32(0, 0x02014b50, true); C.setUint16(4, 20, true); C.setUint16(6, 20, true);
  C.setUint32(16, crc, true); C.setUint32(20, size, true); C.setUint32(24, size, true); C.setUint16(28, name.length, true);
  C.setUint32(42, 0, true); central.set(name, 46);
  E.setUint32(0, 0x06054b50, true); E.setUint16(8, 1, true); E.setUint16(10, 1, true);
  E.setUint32(12, central.length, true); E.setUint32(16, local.length + size, true);
  return new Blob([local, data, central, end], { type: "application/zip" });
}

// --- events ---
const num = (el, k) => Number(el.getAttribute(k));
function onAct(el) {
  const act = el.getAttribute("data-act"), n = st.skater, d = st.save, name = Core.skaterName(d, n);
  const L = el.hasAttribute("data-l") ? Core.LEVELS[num(el, "data-l")] : null, l = num(el, "data-l");
  switch (act) {
    case "skater":
      st.slide = el.id === "sk-prev" ? "prev" : el.id === "sk-next" ? "next" : null;
      st.skater = num(el, "data-n"); refresh(); status(`Editing ${Core.skaterName(d, st.skater)}.`); break;
    case "stat": {
      const i = num(el, "data-i"), v = Core.skater(d, n).stats[i] + num(el, "data-d");
      edit(x => Core.setStat(x, n, i, v), `${name}'s ${Core.STATS[i].toLowerCase()} set to ${Math.max(0, Math.min(10, v))}.`); break;
    }
    case "stat-set": {
      const i = num(el, "data-i"), v = num(el, "data-v");
      edit(x => Core.setStat(x, n, i, v), `${name}'s ${Core.STATS[i].toLowerCase()} set to ${v}.`); break;
    }
    case "decks": {
      const k = Core.skater(d, n).decks + num(el, "data-d");
      edit(x => Core.setDecks(x, n, k), `${name} now has ${k} decks unlocked.`); break;
    }
    case "medal": {
      const on = !Core.skater(d, n).levels[l].gold;
      edit(x => Core.setGold(x, n, l, on), `${L.name}: gold medal ${on ? "given to" : "taken from"} ${name}.`); break;
    }
    case "complete-career":
      edit(x => Core.completeCareer(x, n), `${name}'s career is complete: every goal, gold medals, all cash icons, a $150,000 career total and every deck.`); break;
    case "max-stats":
      edit(x => Core.maxStats(x, n), `All of ${name}'s stats set to 10.`); break;
    case "icons": {
      const k = Core.skater(d, n).levels[l].icons + num(el, "data-d");
      edit(x => Core.setIcons(x, n, l, k), `${L.name}: ${Math.max(0, Math.min(L.icons, k))} of ${L.icons} cash icons collected.`); break;
    }
    case "complete-level":
      edit(x => Core.completeLevel(x, n, l), `${L.name} complete for ${name}.`); break;
    case "gaps":
      edit(x => Core.setGaps(x, l, num(el, "data-on") === 1), num(el, "data-on") === 1 ? `Every gap in ${L.name} ticked off.` : `Every gap in ${L.name} unticked.`); break;
    case "gaps-everything":
      edit(x => Core.LEVELS.forEach((_, k) => Core.setGaps(x, k, true)), `All ${Core.TOTAL_GAPS} gaps ticked off.`); break;
    case "all-cheats":
      edit(x => { for (let i = 3; i < Core.CHEAT_NAMES.length; i++) Core.setCheat(x, i, true); }, "Every cheat unlocked."); break;
  }
}
function onCheck(el) {
  const act = el.getAttribute("data-act"), n = st.skater, name = Core.skaterName(st.save, n), on = el.checked;
  const l = num(el, "data-l"), L = Core.LEVELS[l];
  switch (act) {
    case "goal": { const b = num(el, "data-b"); edit(x => Core.setGoal(x, n, l, b, on), `${L.name}: "${L.goals[b]}" ${on ? "ticked" : "unticked"} for ${name}.`); break; }
    case "gold": edit(x => Core.setGold(x, n, l, on), `${L.name}: gold medal ${on ? "given to" : "taken from"} ${name}.`); break;
    case "gap": { const i = num(el, "data-i"); edit(x => Core.setGap(x, l, i, on), `${L.name}: ${Core.GAP_NAMES[l][i][0]} ${on ? "ticked off" : "unticked"}.`); break; }
    case "cheat": { const i = num(el, "data-i"); edit(x => Core.setCheat(x, i, on), `${Core.CHEAT_NAMES[i]} ${on ? "unlocked" : "locked"}.`); break; }
    case "carrera": edit(x => Core.setCarrera(x, on), `Private Carrera ${on ? "unlocked" : "locked"}.`); break;
    case "secret-levels": edit(x => Core.setSecretLevels(x, on), `Chopper Drop and Skate Heaven ${on ? "unlocked" : "locked"}.`); break;
  }
}
function onMoney(el) {
  const n = st.skater, name = Core.skaterName(st.save, n);
  const v = Math.max(0, Math.min(Core.MAX_MONEY, Math.floor(Number(el.value) || 0)));
  if (el.id === "cash") edit(x => Core.setCash(x, n, v), `${name}'s cash set to ${money(v)}.` + (v > Core.skater(st.save, n).earn ? " The career total went up to match." : ""));
  else edit(x => Core.setEarnings(x, n, v), `${name}'s career total set to ${money(v)}.` + (v < Core.skater(st.save, n).cash ? " Cash came down to match." : ""));
}

$("pick").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; loadFile(f); });
const drop = $("drop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); loadFile(e.dataTransfer.files[0]); });
$("other").addEventListener("click", () => $("file").click());
$("saves").addEventListener("change", async e => {
  const i = Number(e.target.value);
  if (isDirty() && !(await ask("Switch save?", "<p>You have unsaved changes to this save. Switch to another save anyway?</p>"))) { e.target.value = st.saveIdx; return; }
  openSave(i);
});
$("undo").addEventListener("click", undo);
$("reset").addEventListener("click", reset);
$("save").addEventListener("click", saveAll);
for (const t of Object.keys(TABS)) $(`tab-${t}`).addEventListener("click", () => showTab(t));
$("editor").querySelector(".tabs").addEventListener("keydown", e => {
  const order = Object.keys(TABS), i = order.indexOf(st.tab);
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const next = order[(i + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
  showTab(next); $(`tab-${next}`).focus();
});
const ed = $("editor");
ed.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if (!el || !st.save || el.disabled || el.matches("input")) return;
  onAct(el);
});
ed.addEventListener("input", e => { if (e.target.id === "gap-search") { st.gapQuery = e.target.value; applyGapFilter(); } });
ed.addEventListener("change", e => {
  const el = e.target;
  if (!st.save) return;
  if (el.id === "roster-pick") { st.skater = Number(el.value); refresh(); status(`Editing ${Core.skaterName(st.save, st.skater)}.`); return; }
  if (el.id === "cash" || el.id === "earn") { onMoney(el); return; }
  if (el.matches("[data-act^=hs-]")) { onScore(el); return; }
  if (el.id === "cas-name" || el.id === "cas-town") { onCasText(el); return; }
  if (el.matches("input[type=checkbox][data-act]")) onCheck(el);
});
document.addEventListener("keydown", e => {
  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && st.save && st.tab === "skaters" && !$("dlg-back").classList.contains("on") &&
      !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.target.closest("input, select, textarea, [role=tab], summary")) {
    e.preventDefault();
    onAct($(e.key === "ArrowLeft" ? "sk-prev" : "sk-next"));
    return;
  }
  // ctrl+z = undo, unless typing in a box
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !e.target.closest("input, textarea, select") && !$("dlg-back").classList.contains("on")) {
    e.preventDefault(); undo();
  }
});
window.addEventListener("beforeunload", e => { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } });
getDownloads();
