#!/usr/bin/env node
// WebStationX asset generator - Leonardo.ai REST v1 + sharp post-processing.
//
// Usage:
//   node tools/gen-assets.mjs                 generate every asset whose output is missing
//   node tools/gen-assets.mjs --only bg-main  generate one asset (comma-separate for several)
//   node tools/gen-assets.mjs --force         regenerate even if the output exists
//   node tools/gen-assets.mjs --test          one cheap 512x512 probe to validate the recipe
//   node tools/gen-assets.mjs --candidates 2  raw candidates per asset (default 2)
//   node tools/gen-assets.mjs --pick bg-main=2 --finish-only
//                                             re-encode from an existing raw candidate (no API)
//   node tools/gen-assets.mjs --dry           print the plan without calling the API
//
// Raw generations land in work/leonardo/<id>-<n>.png, finished files in public/assets/,
// and public/assets/manifest.json lists what was produced.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW_DIR = path.join(ROOT, "work", "leonardo");
const OUT_DIR = path.join(ROOT, "public", "assets");
const API = "https://cloud.leonardo.ai/api/rest/v1";

const MODELS = {
  phoenix: "de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3", // Phoenix 1.0
  lightning: "b24e16ff-06e3-43eb-8d33-4416c2d75876", // Leonardo Lightning XL
  kino: "aa77f04e-3eec-4034-9c07-d0f619684628", // Leonardo Kino XL
  flux: "b2614463-296c-462a-9586-aafdb8f00e36", // Flux Dev
  lucid: "7b592283-e8a7-4c5a-9ba6-d18c31f258b9", // Lucid Origin
};

// Spend guard: total credits this run may burn, and the balance we never dip below.
const BUDGET_CREDITS = 700;
const FLOOR_CREDITS = 1800;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const STYLE =
  "early-2000s Y2K futurism, aqua and chrome, glossy, elegant, polished, high quality digital render";

const NEG_COMMON =
  "text, letters, words, typography, watermark, signature, logo, brand, caption, ui, frame, border, " +
  "low quality, blurry, jpeg artifacts, deformed, duplicate, cropped, people, faces, hands";

const NEG_ISOLATED =
  NEG_COMMON +
  ", background scenery, gradient background, grey background, floor, ground plane, horizon, surface, table, " +
  "reflection floor, cast shadow, vignette, multiple objects";

const ON_BLACK =
  "floating in an empty pure solid black void, background is 100% black (#000000), no floor, no ground, no horizon, no cast shadow";

/**
 * @typedef {object} Asset
 * @property {string} id
 * @property {string} purpose
 * @property {string} prompt
 * @property {string} negative
 * @property {[number, number]} gen      generation size sent to the API (multiples of 8)
 * @property {[number, number]} size     final output size
 * @property {"phoenix"|"lightning"|"kino"|"flux"|"lucid"} model
 * @property {string} file               output filename in public/assets
 * @property {"jpg"|"png"} format
 * @property {number} [quality]
 * @property {number} [thumb]            optional thumbnail width -> <name>.thumb.jpg
 * @property {boolean} [alchemy]
 * @property {string} [presetStyle]
 * @property {number} [contrast]
 * @property {number} [guidance]
 */

/** @type {Asset[]} */
const ASSETS = [
  {
    id: "bg-main",
    purpose: "Main menu / library background",
    file: "bg-main.jpg",
    format: "jpg",
    quality: 82,
    gen: [1536, 864],
    size: [1920, 1080],
    thumb: 480,
    model: "phoenix",
    alchemy: true,
    presetStyle: "CINEMATIC",
    contrast: 3,
    prompt:
      "Abstract early-2000s game console user interface background, deep navy blue fading to black, " +
      "sweeping translucent cyan and aqua light ribbons flowing diagonally, soft glowing lens flares, " +
      "faint perspective grid receding into the distance, tiny sparkles, very subtle, minimal, calm, " +
      "dark and spacious with lots of negative space suitable for white overlay text, smooth gradients, " +
      "glossy Y2K futurism, wallpaper, ultra clean, no objects",
    negative: NEG_COMMON + ", busy, cluttered, bright, characters, buildings, planets, sun, sharp shapes",
  },
  {
    id: "bg-boot",
    purpose: "Boot screen background",
    file: "bg-boot.jpg",
    format: "jpg",
    quality: 82,
    gen: [1536, 864],
    size: [1920, 1080],
    thumb: 480,
    model: "phoenix",
    alchemy: true,
    presetStyle: "CINEMATIC",
    contrast: 3,
    prompt:
      "Near-black empty void of deep space, a very faint distant blue-violet nebula haze, a single soft " +
      "horizontal horizon glow of pale cyan light near the lower third, extremely dark and minimal, " +
      "atmospheric, cinematic, smooth gradients, no stars clusters, no planets, no objects, wallpaper",
    negative: NEG_COMMON + ", bright, planet, sun, stars field, galaxy spiral, mountains, ground, clouds detailed",
  },
  {
    id: "bg-play",
    purpose: "Behind-the-game-screen background",
    file: "bg-play.jpg",
    format: "jpg",
    quality: 82,
    gen: [1536, 864],
    size: [1920, 1080],
    thumb: 480,
    model: "phoenix",
    alchemy: true,
    presetStyle: "CINEMATIC",
    contrast: 3,
    prompt:
      "Almost completely black background with a soft dark vignette, a barely visible fine brushed-metal " +
      "texture with faint horizontal grain, a hint of very dark charcoal-grey in the center fading to " +
      "pure black at the edges, extremely subtle, minimal, matte, wallpaper, no objects",
    negative: NEG_COMMON + ", bright, colorful, light, glow, shapes, scratches, dust, noise, pattern",
  },
  {
    id: "emblem",
    purpose: "Logo emblem (screen-blend over dark UI)",
    file: "emblem.png",
    format: "png",
    gen: [1024, 1024],
    size: [1024, 1024],
    model: "phoenix",
    alchemy: true,
    presetStyle: "DYNAMIC",
    contrast: 3.5,
    prompt:
      "A glossy chrome and aqua 3D emblem shaped like a bold stylised letter X fused with a spinning " +
      "optical disc ring, Y2K futurism, polished mirror chrome with cyan glow highlights, thin light " +
      "trails, centered, symmetrical, product render, " + ON_BLACK + ", studio lighting, no text",
    negative: NEG_ISOLATED + ", letters other than X, alphabet, words, wings",
  },
  {
    id: "hero-controller",
    purpose: "Hero image: grey dual-analog controller",
    file: "hero-controller.png",
    format: "png",
    gen: [1024, 1024],
    size: [1024, 1024],
    model: "phoenix",
    alchemy: true,
    presetStyle: "CINEMATIC",
    contrast: 3.5,
    prompt:
      "A classic light-grey 1990s dual-analog video game controller with two analog thumbsticks, a " +
      "directional pad, four plain unlabeled round action buttons and two long handles, three-quarter " +
      "view, glossy plastic, studio product photography lighting, sharp focus, centered, " + ON_BLACK + ", " +
      "generic design without any logos or symbols on the buttons",
    negative: NEG_ISOLATED + ", symbols on buttons, triangle circle cross square glyphs, cables, wires, hands, brand, playstation",
  },
  {
    id: "hero-memcard",
    purpose: "Hero image: grey memory card",
    file: "hero-memcard.png",
    format: "png",
    gen: [1024, 1024],
    size: [1024, 1024],
    model: "phoenix",
    alchemy: true,
    presetStyle: "CINEMATIC",
    contrast: 3.5,
    prompt:
      "A small rectangular light-grey 1990s video game console memory card, plain matte plastic with a " +
      "narrow ridged grip at one end and a blank label area, three-quarter view, studio product " +
      "photography lighting, sharp focus, centered, " + ON_BLACK + ", no text",
    negative: NEG_ISOLATED + ", sd card, usb, circuit board exposed, sticker text, buttons, screen",
  },
  {
    id: "hero-disc",
    purpose: "Hero image: black-bottomed game disc",
    file: "hero-disc.png",
    format: "png",
    gen: [1024, 1024],
    size: [1024, 1024],
    model: "phoenix",
    alchemy: true,
    presetStyle: "CINEMATIC",
    contrast: 3.5,
    prompt:
      "A 1990s video game console compact disc with a black-tinted underside, iridescent rainbow " +
      "reflections shimmering across the surface, top-down view at a slight angle, single disc, " +
      "studio lighting, sharp focus, centered, " + ON_BLACK + ", no text",
    negative: NEG_ISOLATED + ", vinyl record, printed label art, case, jewel case, multiple discs, hand",
  },
  {
    id: "texture-metal",
    purpose: "Seamless brushed aluminium tile",
    file: "texture-metal.jpg",
    format: "jpg",
    quality: 82,
    gen: [1024, 1024],
    size: [1024, 1024],
    model: "phoenix",
    alchemy: true,
    presetStyle: "NONE",
    contrast: 2.5,
    prompt:
      "Seamless tileable brushed aluminium texture, medium grey, fine straight horizontal grain, subtle, " +
      "even lighting, flat, no highlights, no edges, no objects, material texture close-up, uniform",
    negative: NEG_COMMON + ", scratches, dents, rust, edges, panels, screws, perspective, shadow, dramatic lighting",
  },
  {
    id: "texture-glass",
    purpose: "Aqua glass button sheen strip",
    file: "texture-glass.png",
    format: "png",
    gen: [1024, 256],
    size: [1024, 256],
    model: "phoenix",
    alchemy: true,
    presetStyle: "NONE",
    contrast: 3,
    prompt:
      "Horizontal glossy aqua glass button highlight strip, Y2K web button style, bright white-cyan " +
      "specular sheen across the top half fading smoothly into deep dark teal at the bottom, smooth " +
      "gradient, rounded glass, clean, abstract, full-bleed, no objects, no text",
    negative: NEG_COMMON + ", bubbles, water, drops, pattern, edges, border, shapes, icons",
  },
  {
    id: "cover-crash-bash",
    purpose: "Placeholder box art: cartoon party arena",
    file: "cover-crash-bash.jpg",
    format: "jpg",
    quality: 82,
    gen: [768, 1072],
    size: [600, 840],
    thumb: 200,
    model: "phoenix",
    alchemy: true,
    presetStyle: "ILLUSTRATION",
    contrast: 3.5,
    prompt:
      "Stylised video game box-art illustration, a chaotic colourful cartoon party-game arena, four " +
      "cartoon animal contestants mid-action leaping and tumbling, wooden crates, cartoon explosions, " +
      "tropical jungle stone temple in the background, bold saturated 2000s cartoon style, dynamic " +
      "composition, thick outlines, vibrant, portrait orientation, no text, no logos",
    negative: NEG_COMMON + ", realistic, photo, dark, humans, title, box, packaging, gore",
  },
  {
    id: "cover-medievil",
    purpose: "Placeholder box art: skeleton knight",
    file: "cover-medievil.jpg",
    format: "jpg",
    quality: 82,
    gen: [768, 1072],
    size: [600, 840],
    thumb: 200,
    model: "phoenix",
    alchemy: true,
    presetStyle: "ILLUSTRATION",
    contrast: 3.5,
    prompt:
      "Stylised video game box-art illustration, a heroic one-eyed skeleton knight in dented medieval " +
      "armour raising a sword, standing in a gothic misty graveyard with crooked tombstones and bare " +
      "trees under a huge glowing green moon, dark comedic 2000s fantasy cartoon style, dramatic " +
      "lighting, portrait orientation, no text, no logos",
    negative: NEG_COMMON + ", realistic, photo, gore, blood, humans, title, box, packaging",
  },
  ...[
    ["01", "a polished mirror chrome sphere reflecting soft blue studio light"],
    ["02", "a translucent glowing aqua cyan glass orb with a bright specular highlight"],
    ["03", "a glossy orb filled with swirling orange fire and embers"],
    ["04", "a glossy green glass orb with a single stylised leaf suspended inside"],
    ["05", "a glossy deep-blue orb with a glowing gold five-pointed star inside"],
    ["06", "a glossy dark-purple orb with a small stylised cartoon skull glowing inside"],
  ].map(([n, subject]) => ({
    id: `avatar-${n}`,
    purpose: `Profile avatar orb ${n}`,
    file: `avatar-${n}.png`,
    format: "png",
    gen: [768, 768],
    size: [512, 512],
    model: "phoenix",
    alchemy: true,
    presetStyle: "DYNAMIC",
    contrast: 3.5,
    prompt:
      `Y2K glossy profile icon, ${subject}, Aqua interface style, single perfectly round sphere, ` +
      "centered, 3D render, soft studio lighting, crisp reflections, " + ON_BLACK + ", no text",
    negative: NEG_ISOLATED + ", face, eyes, multiple spheres, cube, ring, base, pedestal",
  })),
];

// ---------------------------------------------------------------------------
// CLI + env
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { only: null, force: false, test: false, candidates: 2, pick: {}, finishOnly: false, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") args.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--force") args.force = true;
    else if (a === "--test") args.test = true;
    else if (a === "--dry") args.dry = true;
    else if (a === "--finish-only") args.finishOnly = true;
    else if (a === "--candidates") args.candidates = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--pick") {
      for (const pair of argv[++i].split(",")) {
        const [id, n] = pair.split("=");
        if (id && n) args.pick[id.trim()] = parseInt(n, 10);
      }
    } else if (a === "--help" || a === "-h") {
      console.log(helpText());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function helpText() {
  return `gen-assets: see header comment in tools/gen-assets.mjs. Assets: ${ASSETS.map((a) => a.id).join(", ")}`;
}

async function readEnvKey(name) {
  const raw = await fs.readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    if (k !== name) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  }
  throw new Error(`${name} not found in .env`);
}

// ---------------------------------------------------------------------------
// Leonardo API
// ---------------------------------------------------------------------------

class Leo {
  constructor(key) {
    this.key = key;
    this.spent = 0;
    this.start = null;
  }

  async req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`${method} ${url} -> ${res.status}: ${json.error || json.message || text}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  async balance() {
    const me = await this.req("GET", `${API}/me`);
    const d = me.user_details?.[0];
    return Number(d?.apiPaidTokens ?? 0) + Number(d?.apiSubscriptionTokens ?? 0);
  }

  /**
   * Create a generation, adaptively dropping optional fields the model rejects.
   * Returns { generationId, cost }.
   */
  async create(body) {
    const optional = ["contrast", "presetStyle", "alchemy", "guidance_scale", "negative_prompt", "enhancePrompt"];
    let attempt = { ...body };
    for (let i = 0; i <= optional.length; i++) {
      try {
        const r = await this.req("POST", `${API}/generations`, attempt);
        const job = r.sdGenerationJob;
        if (!job?.generationId) throw new Error(`Unexpected create response: ${JSON.stringify(r)}`);
        return { generationId: job.generationId, cost: Number(job.apiCreditCost ?? 0), body: attempt };
      } catch (e) {
        if (e.status !== 400) throw e;
        const msg = String(e.body?.error || e.body?.message || e.message);
        // Try to find which field the API complains about; otherwise drop the next optional field.
        const named = optional.find((f) => attempt[f] !== undefined && msg.toLowerCase().includes(f.toLowerCase()));
        const drop = named ?? optional.find((f) => attempt[f] !== undefined);
        if (!drop) throw e;
        console.warn(`    400 (${msg.slice(0, 120)}) -> retrying without "${drop}"`);
        const next = { ...attempt };
        delete next[drop];
        if (drop === "alchemy") delete next.contrast; // contrast only valid alongside alchemy on Phoenix
        attempt = next;
      }
    }
    throw new Error("Exhausted field fallbacks");
  }

  async waitFor(generationId, { intervalMs = 3000, timeoutMs = 300_000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const r = await this.req("GET", `${API}/generations/${generationId}`);
      const g = r.generations_by_pk;
      if (g?.status === "COMPLETE") return g;
      if (g?.status === "FAILED") throw new Error(`Generation ${generationId} FAILED`);
      if (Date.now() - t0 > timeoutMs) throw new Error(`Generation ${generationId} timed out`);
      await sleep(intervalMs);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

async function finish(asset, rawPath) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const [w, h] = asset.size;
  const outPath = path.join(OUT_DIR, asset.file);
  // Raw candidates are always saved as PNG, so read that regardless of final format.
  let img = sharp(rawPath).resize(w, h, { fit: "cover", position: "centre", kernel: "lanczos3" });
  if (asset.format === "jpg") {
    img = img.jpeg({ quality: asset.quality ?? 82, mozjpeg: true, chromaSubsampling: "4:4:4" });
  } else {
    img = img.png({ compressionLevel: 9, adaptiveFiltering: true });
  }
  await img.toFile(outPath);

  let thumbFile = null;
  if (asset.thumb) {
    const base = asset.file.replace(/\.[^.]+$/, "");
    thumbFile = `${base}.thumb.jpg`;
    await sharp(outPath)
      .resize(asset.thumb, null, { kernel: "lanczos3" })
      .jpeg({ quality: 78, mozjpeg: true })
      .toFile(path.join(OUT_DIR, thumbFile));
  }
  return { outPath, thumbFile };
}

async function writeManifest(entries) {
  const manifestPath = path.join(OUT_DIR, "manifest.json");
  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(manifestPath, "utf8")).assets ?? [];
  } catch {
    /* fresh */
  }
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const e of entries) byId.set(e.id, e);
  // Keep manifest order aligned with ASSETS, drop entries whose files vanished.
  const ordered = [];
  for (const a of ASSETS) {
    const e = byId.get(a.id);
    if (!e) continue;
    if (await exists(path.join(OUT_DIR, e.file))) ordered.push(e);
  }
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), assets: ordered }, null, 2) + "\n",
  );
  return manifestPath;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function buildBody(asset, numImages) {
  const body = {
    prompt: asset.prompt,
    negative_prompt: asset.negative,
    modelId: MODELS[asset.model],
    width: asset.gen[0],
    height: asset.gen[1],
    num_images: numImages,
    public: false,
  };
  if (asset.alchemy) body.alchemy = true;
  if (asset.presetStyle) body.presetStyle = asset.presetStyle;
  if (asset.contrast !== undefined) body.contrast = asset.contrast;
  if (asset.guidance !== undefined) body.guidance_scale = asset.guidance;
  return body;
}

function manifestEntry(asset, extra = {}) {
  return {
    id: asset.id,
    file: asset.file,
    width: asset.size[0],
    height: asset.size[1],
    purpose: asset.purpose,
    format: asset.format,
    model: asset.model,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const selected = args.only ? ASSETS.filter((a) => args.only.includes(a.id)) : ASSETS;
  if (args.only) {
    const missing = args.only.filter((id) => !ASSETS.some((a) => a.id === id));
    if (missing.length) throw new Error(`Unknown asset id(s): ${missing.join(", ")}`);
  }

  // ---- finish-only: re-encode from existing raw candidates, no API ----
  if (args.finishOnly) {
    const entries = [];
    for (const asset of selected) {
      const n = args.pick[asset.id] ?? 1;
      const raw = path.join(RAW_DIR, `${asset.id}-${n}.png`);
      if (!(await exists(raw))) {
        console.warn(`[${asset.id}] raw candidate ${n} missing, skipped`);
        continue;
      }
      const { thumbFile } = await finish(asset, raw);
      entries.push(manifestEntry(asset, { candidate: n, ...(thumbFile ? { thumb: thumbFile } : {}) }));
      console.log(`[${asset.id}] finished from candidate ${n} -> public/assets/${asset.file}`);
    }
    const mp = await writeManifest(entries);
    console.log(`manifest -> ${path.relative(ROOT, mp)}`);
    return;
  }

  const key = await readEnvKey("LEONARDO_API_KEY");
  const leo = new Leo(key);

  // ---- test probe ----
  if (args.test) {
    const before = await leo.balance();
    console.log(`balance before: ${before}`);
    if (before < FLOOR_CREDITS) throw new Error(`Balance ${before} is below floor ${FLOOR_CREDITS}, refusing`);
    const probe = ASSETS.find((a) => a.id === "avatar-02");
    const body = buildBody({ ...probe, gen: [512, 512] }, 1);
    console.log("probe body:", { ...body, prompt: body.prompt.slice(0, 60) + "...", negative_prompt: "(...)" });
    const { generationId, cost, body: used } = await leo.create(body);
    console.log(`probe generationId=${generationId} apiCreditCost=${cost}`);
    console.log("fields accepted:", Object.keys(used).join(", "));
    const g = await leo.waitFor(generationId);
    const url = g.generated_images?.[0]?.url;
    const dest = path.join(RAW_DIR, "_probe.png");
    await download(url, dest);
    const after = await leo.balance();
    console.log(`probe saved -> ${path.relative(ROOT, dest)}; balance after: ${after} (delta ${before - after})`);
    return;
  }

  // ---- plan ----
  const todo = [];
  for (const asset of selected) {
    const outPath = path.join(OUT_DIR, asset.file);
    if (!args.force && (await exists(outPath))) {
      console.log(`[${asset.id}] exists, skipped (use --force)`);
      continue;
    }
    todo.push(asset);
  }
  if (!todo.length) {
    console.log("nothing to do");
    return;
  }
  console.log(`plan: ${todo.length} asset(s) x ${args.candidates} candidate(s)`);
  for (const a of todo) console.log(`  - ${a.id}  ${a.gen.join("x")} -> ${a.size.join("x")}  ${a.model}  ${a.file}`);
  if (args.dry) return;

  const before = await leo.balance();
  console.log(`balance before: ${before}`);
  if (before < FLOOR_CREDITS) throw new Error(`Balance ${before} is below floor ${FLOOR_CREDITS}, refusing to start`);

  const entries = [];
  let spent = 0;
  for (const asset of todo) {
    if (spent >= BUDGET_CREDITS) {
      console.warn(`budget ${BUDGET_CREDITS} reached (spent ${spent}); stopping before ${asset.id}`);
      break;
    }
    if (before - spent < FLOOR_CREDITS) {
      console.warn(`projected balance ${before - spent} below floor ${FLOOR_CREDITS}; stopping before ${asset.id}`);
      break;
    }
    console.log(`[${asset.id}] generating ${args.candidates} candidate(s)...`);
    try {
      const body = buildBody(asset, args.candidates);
      const { generationId, cost: reported } = await leo.create(body);
      console.log(`    id=${generationId} reported cost=${reported}`);
      const g = await leo.waitFor(generationId);
      // The create response often reports apiCreditCost=0, so measure the real spend from the balance.
      const bal = await leo.balance();
      const cost = before - bal - spent;
      spent = before - bal;
      console.log(`    actual cost=${cost} (run total ${spent}, balance ${bal})`);
      const urls = (g.generated_images ?? []).map((im) => im.url);
      if (!urls.length) throw new Error("no images returned");
      const rawPaths = [];
      for (let i = 0; i < urls.length; i++) {
        const dest = path.join(RAW_DIR, `${asset.id}-${i + 1}.png`);
        const buf = await download(urls[i], dest);
        // Normalise raw to PNG regardless of remote format.
        await sharp(buf).png().toFile(dest);
        rawPaths.push(dest);
      }
      const pick = Math.min(args.pick[asset.id] ?? 1, rawPaths.length);
      const { thumbFile } = await finish(asset, rawPaths[pick - 1]);
      entries.push(
        manifestEntry(asset, {
          candidate: pick,
          candidates: rawPaths.length,
          generationId,
          ...(thumbFile ? { thumb: thumbFile } : {}),
        }),
      );
      console.log(`    saved ${rawPaths.length} raw -> work/leonardo/, finished -> public/assets/${asset.file}`);
    } catch (e) {
      console.error(`[${asset.id}] FAILED: ${e.message}`);
    }
  }

  const mp = await writeManifest(entries);
  const after = await leo.balance();
  console.log(`manifest -> ${path.relative(ROOT, mp)}`);
  console.log(`credits: reported spend ${spent}, balance ${before} -> ${after} (delta ${before - after})`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
