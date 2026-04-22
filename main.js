import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mountAllHalftones } from "./halftone.js";

const AMBER = new THREE.Color("#f5a623");
const AMBER_BRIGHT = new THREE.Color("#ffb83d");
const AMBER_DIM = new THREE.Color("#6b4510");

const LAN_CITIES = [
  { name: "CHIHUAHUA",       country: "MEXICO",       lat:  28.6320, lon: -106.0691 },
  { name: "CIUDAD GUATEMALA", country: "GUATEMALA",   lat:  14.6349, lon:  -90.5069 },
  { name: "SAN SALVADOR",    country: "EL SALVADOR",  lat:  13.6929, lon:  -89.2182 },
  { name: "LIMA",            country: "PERU",         lat: -12.0464, lon:  -77.0428 },
  { name: "SANTIAGO",        country: "CHILE",        lat: -33.4489, lon:  -70.6693 },
];

// Community cities outside the LAN-party set. They get markers and focus/zoom
// behavior, but do not create interconnecting arc lines.
const COMMUNITY_ONLY_CITIES = [
  { name: "BOGOTA", country: "COLOMBIA", lat: 4.7110, lon: -74.0721 },
  { name: "LA PAZ", country: "BOLIVIA", lat: -16.5000, lon: -68.1500 },
  { name: "BUENOS AIRES", country: "ARGENTINA", lat: -34.6037, lon: -58.3816 },
  { name: "SAN FRANCISCO", country: "USA", lat: 37.7749, lon: -122.4194 },
];

const ALL_MARKER_CITIES = [...LAN_CITIES, ...COMMUNITY_ONLY_CITIES];

const GLOBE_RADIUS = 1.0;

const canvas = document.getElementById("globe");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
// Start looking at Latin America (~lat -15°, lon -70°, between Chihuahua and
// Santiago). Matches the latLonToVec3 convention defined below; inlined here
// because latLonToVec3 is defined later in the file.
{
  const la = THREE.MathUtils.degToRad(-5);
  const lo = THREE.MathUtils.degToRad(-72);
  const r  = 3.1;
  camera.position.set(
    r * Math.cos(la) * Math.sin(lo),
    r * Math.sin(la),
    r * Math.cos(la) * Math.cos(lo),
  );
}

const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.enableZoom = false;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.45;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.08; // much slower drift

// Latitude/longitude grid — faint amber lines on the sphere (graticule)
function makeGraticule() {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: AMBER_DIM, transparent: true, opacity: 0.28 });
  const r = GLOBE_RADIUS * 1.001;
  for (let lat = -75; lat <= 75; lat += 15) {
    const phi = THREE.MathUtils.degToRad(90 - lat);
    const ringRadius = Math.sin(phi) * r;
    const y = Math.cos(phi) * r;
    const pts = [];
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(t) * ringRadius, y, Math.sin(t) * ringRadius));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    group.add(new THREE.Line(geom, mat));
  }
  for (let lon = 0; lon < 360; lon += 15) {
    const theta = THREE.MathUtils.degToRad(lon);
    const pts = [];
    for (let i = 0; i <= 96; i++) {
      const phi = (i / 96) * Math.PI;
      pts.push(new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * r,
        Math.cos(phi) * r,
        Math.sin(phi) * Math.sin(theta) * r,
      ));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    group.add(new THREE.Line(geom, mat));
  }
  return group;
}
scene.add(makeGraticule());

// Place Greenwich at +Z so that, with camera at (0, 0, +Z), screen-right
// (which is +X in Three.js' right-handed coord system) corresponds to
// increasing longitude — i.e. EAST is to the RIGHT of the viewer, matching
// every real-world map. The old mapping had east on the left (mirrored).
//
//   (lat, lon)  ->  ( cos(lat)*sin(lon),  sin(lat),  cos(lat)*cos(lon) )
//
// Must match the Fibonacci forward mapping in buildDottedGlobe below:
//   (x, y, z) on unit sphere  ->  lat = asin(y), lon = atan2(x, z)
function latLonToVec3(lat, lon, radius = GLOBE_RADIUS) {
  const latRad = THREE.MathUtils.degToRad(lat);
  const lonRad = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    radius * Math.cos(latRad) * Math.sin(lonRad),
    radius * Math.sin(latRad),
    radius * Math.cos(latRad) * Math.cos(lonRad),
  );
}

// Uses an equirectangular Earth image; a pixel is classified as WATER when
// it is strongly blue-dominant (b notably greater than r and g). Everything
// else — forest, desert, tundra, pampas, snow, ice — reads as LAND. This is
// far more robust than an elevation threshold (the old approach lost most
// low-lying continental interior like the Argentine pampas).
async function loadLandMask() {
  const urls = [
    "https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img/earth-blue-marble.jpg",
    "https://unpkg.com/three-globe@2.31.1/example/img/earth-blue-marble.jpg",
    // Fallback — less accurate, but better than nothing.
    "https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img/earth-dark.jpg",
  ];
  for (const url of urls) {
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = "anonymous";
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      return {
        width: c.width,
        height: c.height,
        sample(lat, lon) {
          const u = (lon + 180) / 360;
          const v = (90 - lat) / 180;
          const x = Math.max(0, Math.min(c.width - 1, Math.floor(u * c.width)));
          const y = Math.max(0, Math.min(c.height - 1, Math.floor(v * c.height)));
          const idx = (y * c.width + x) * 4;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2];
          // return 1 for land, 0 for water
          const isWater = b > r + 14 && b > g + 14;
          return isWater ? 0 : 1;
        },
      };
    } catch (e) {
      // try next URL
    }
  }
  return null;
}

async function buildDottedGlobe() {
  const mask = await loadLandMask();
  const positions = [];
  const colors = [];
  const N = 22000;                // denser sampling → continents read cleanly
  const R = GLOBE_RADIUS * 1.004;
  const phi = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const rr = Math.sqrt(1 - y * y);
    const t = phi * i;
    const x = Math.cos(t) * rr;
    const z = Math.sin(t) * rr;

    const lat = THREE.MathUtils.radToDeg(Math.asin(y));
    // atan2(x, z) (not atan2(z, x)) — matches latLonToVec3 so east=+X, east on right
    const lon = THREE.MathUtils.radToDeg(Math.atan2(x, z));

    if (mask) {
      const s = mask.sample(lat, lon);
      if (s === 0) continue; // water — skip
    }

    positions.push(x * R, y * R, z * R);
    // Slight per-point intensity jitter for a film-grain / halftone feel
    const intensity = 0.75 + Math.random() * 0.25;
    const c = AMBER.clone().multiplyScalar(intensity);
    colors.push(c.r, c.g, c.b);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.013,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  scene.add(new THREE.Points(geom, mat));
}

function makeArc(a, b, lift = 0.35, segments = 64) {
  const va = latLonToVec3(a.lat, a.lon);
  const vb = latLonToVec3(b.lat, b.lon);
  const mid = va.clone().add(vb).multiplyScalar(0.5);
  const d = va.distanceTo(vb);
  mid.normalize().multiplyScalar(GLOBE_RADIUS + lift * (d / 2 + 0.25));
  const curve = new THREE.QuadraticBezierCurve3(va, mid, vb);
  const pts = curve.getPoints(segments);
  const geom = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.Line(
    geom,
    new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.55 }),
  );
}

// Circular marker texture — opaque hot core + soft amber halo.
// Drawing once and re-used as a SpriteMaterial map.
function createMarkerTexture() {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const cx = size / 2, cy = size / 2;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  g.addColorStop(0.00, "rgba(255, 224, 150, 1)");
  g.addColorStop(0.18, "rgba(255, 184,  61, 1)");
  g.addColorStop(0.40, "rgba(245, 166,  35, 0.55)");
  g.addColorStop(0.70, "rgba(245, 120,  20, 0.15)");
  g.addColorStop(1.00, "rgba(245, 120,  20, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const MARKER_TEX = createMarkerTexture();

// Sprites auto-billboard toward the camera, so no manual quaternion copy is
// needed. depthTest:true + depthWrite:false => they're hidden by the opaque
// occluder on the back of the globe but don't fight each other.
function makeCityMarker(city) {
  const pos = latLonToVec3(city.lat, city.lon, GLOBE_RADIUS + 0.012);
  const mat = new THREE.SpriteMaterial({
    map: MARKER_TEX,
    color: 0xffffff,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(pos);
  sprite.scale.set(0.14, 0.14, 1);
  sprite.userData.city = city;
  sprite.userData.pulseSeed = Math.random() * Math.PI * 2;
  sprite.userData.baseScale = 0.14;
  sprite.renderOrder = 2;
  return sprite;
}

const markersGroup = new THREE.Group();
const arcsGroup = new THREE.Group();
scene.add(markersGroup);
scene.add(arcsGroup);

for (const city of ALL_MARKER_CITIES) markersGroup.add(makeCityMarker(city));

const hub = LAN_CITIES[0];
for (let i = 1; i < LAN_CITIES.length; i++) {
  arcsGroup.add(makeArc(hub, LAN_CITIES[i], 0.25 + Math.random() * 0.15));
}
arcsGroup.add(makeArc(LAN_CITIES[1], LAN_CITIES[3], 0.15));
arcsGroup.add(makeArc(LAN_CITIES[2], LAN_CITIES[4], 0.3));

// Opaque occluder — renders first and writes depth so markers on the back
// half of the sphere get hidden properly.
const occluder = new THREE.Mesh(
  new THREE.SphereGeometry(GLOBE_RADIUS * 0.995, 64, 64),
  new THREE.MeshBasicMaterial({ color: 0x000000, depthWrite: true }),
);
occluder.renderOrder = 0;
scene.add(occluder);

buildDottedGlobe();

function resize() {
  const parent = canvas.parentElement;
  const w = parent.clientWidth;
  const h = parent.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
const ro = new ResizeObserver(resize);
ro.observe(canvas.parentElement);
resize();

// ─── Camera focus — hovering a HUB card pans + zooms globe to a city ──────
const DEFAULT_DISTANCE = camera.position.length();
const FOCUS_DISTANCE = 1.85;
let focusTarget = null;
let focusedLat = null, focusedLon = null;
let returningDistance = false;
let userInteracting = false;

function focusGlobeOnCity(lat, lon) {
  if (userInteracting) return;
  const v = latLonToVec3(lat, lon, 1).normalize().multiplyScalar(FOCUS_DISTANCE);
  focusTarget = v;
  focusedLat = lat;
  focusedLon = lon;
  returningDistance = false;
  controls.autoRotate = false;
}
function unfocusGlobe() {
  if (focusTarget) returningDistance = true;
  focusTarget = null;
  focusedLat = null;
  focusedLon = null;
}

document.querySelectorAll("[data-focus-lat]").forEach((el) => {
  el.addEventListener("mouseenter", () => {
    focusGlobeOnCity(parseFloat(el.dataset.focusLat), parseFloat(el.dataset.focusLon));
  });
  el.addEventListener("mouseleave", unfocusGlobe);
  el.addEventListener("focusin", () => {
    focusGlobeOnCity(parseFloat(el.dataset.focusLat), parseFloat(el.dataset.focusLon));
  });
  el.addEventListener("focusout", unfocusGlobe);
});

// Any user drag cancels automatic camera motion entirely —
// prevents the lerp from fighting the user's rotation.
controls.addEventListener("start", () => {
  userInteracting = true;
  focusTarget = null;
  focusedLat = null;
  focusedLon = null;
  returningDistance = false;
  controls.autoRotate = false;
});
controls.addEventListener("end", () => {
  userInteracting = false;
  controls.autoRotate = true;
});

// Render loop
function animate(time) {
  if (focusTarget) {
    camera.position.lerp(focusTarget, 0.08);
    camera.lookAt(0, 0, 0);
  } else if (returningDistance) {
    const dir = camera.position.clone().normalize();
    const cur = camera.position.length();
    const next = THREE.MathUtils.lerp(cur, DEFAULT_DISTANCE, 0.08);
    camera.position.copy(dir.multiplyScalar(next));
    camera.lookAt(0, 0, 0);
    if (Math.abs(next - DEFAULT_DISTANCE) < 0.005) {
      returningDistance = false;
      if (!userInteracting) controls.autoRotate = true;
    }
  }

  controls.update();

  // Subtle pulse on the marker sprites — scale breathes ~±7%
  markersGroup.children.forEach((sprite) => {
    const seed = sprite.userData.pulseSeed ?? 0;
    const base = sprite.userData.baseScale ?? 0.14;
    const t = (time || 0) * 0.002 + seed;
    const s = base * (1 + Math.sin(t) * 0.07);
    sprite.scale.set(s, s, 1);
  });

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// ─── Labels (DOM overlay) — only show for the focused city ────────────────
const overlay = document.createElement("div");
overlay.className = "globe-labels";
canvas.parentElement.appendChild(overlay);

const style = document.createElement("style");
style.textContent = `
.globe-labels { position: absolute; inset: 0; pointer-events: none; font-family: var(--font-mono); }
.globe-label {
  position: absolute;
  transform: translate(8px, -50%);
  font-size: 11px;
  line-height: 1.4;
  color: #ffb83d;
  white-space: nowrap;
  text-shadow: 0 0 6px rgba(0,0,0,0.9);
  transition: opacity 0.15s linear;
}
.globe-label .coords { color: #c8891b; font-size: 10px; letter-spacing: 0.02em; }
.globe-label .name { font-weight: 500; letter-spacing: 0.05em; }
`;
document.head.appendChild(style);

const labelEls = ALL_MARKER_CITIES.map((city) => {
  const el = document.createElement("div");
  el.className = "globe-label";
  el.style.opacity = "0";  // start hidden so they don't flash on load
  const lat = `${Math.abs(city.lat).toFixed(4)}°${city.lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(city.lon).toFixed(4)}°${city.lon >= 0 ? "E" : "W"}`;
  el.innerHTML = `<div class="name">${city.name}</div><div class="coords">${lat},</div><div class="coords">${lon}</div>`;
  overlay.appendChild(el);
  return { el, city, v: latLonToVec3(city.lat, city.lon, GLOBE_RADIUS + 0.04) };
});

const v = new THREE.Vector3();
function updateLabels() {
  const rect = canvas.getBoundingClientRect();
  for (const { el, city, v: world } of labelEls) {
    v.copy(world);
    const toCam = new THREE.Vector3().subVectors(camera.position, v).normalize();
    const n = v.clone().normalize();
    const visible = n.dot(toCam) > 0.05;
    const isFocused =
      focusedLat !== null &&
      Math.abs(city.lat - focusedLat) < 0.01 &&
      Math.abs(city.lon - focusedLon) < 0.01;

    const p = v.clone().project(camera);
    const x = (p.x * 0.5 + 0.5) * rect.width;
    const y = (-p.y * 0.5 + 0.5) * rect.height;
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.opacity = isFocused && visible ? "1" : "0";
  }
  requestAnimationFrame(updateLabels);
}
requestAnimationFrame(updateLabels);

// ─── Countdown to when the hack ends ──────────────────────────────────────
const COUNTDOWN_TARGET = new Date("2026-04-22T22:15:20Z").getTime();
const cd = {
  d: document.getElementById("cd-d"),
  h: document.getElementById("cd-h"),
  m: document.getElementById("cd-m"),
  s: document.getElementById("cd-s"),
};
const pad = (n) => String(Math.max(0, n | 0)).padStart(2, "0");
function tickCountdown() {
  if (!cd.d) return;
  let ms = Math.max(0, COUNTDOWN_TARGET - Date.now());
  const days = Math.floor(ms / 86400000); ms -= days * 86400000;
  const hrs  = Math.floor(ms / 3600000);  ms -= hrs  * 3600000;
  const mins = Math.floor(ms / 60000);    ms -= mins * 60000;
  const secs = Math.floor(ms / 1000);
  cd.d.textContent = pad(days);
  cd.h.textContent = pad(hrs);
  cd.m.textContent = pad(mins);
  cd.s.textContent = pad(secs);
}
tickCountdown();
setInterval(tickCountdown, 1000);

// ─── Halftone 3D icons on the hero cards ──────────────────────────────────
// Looks for `.glb` / `.gltf` in assets/3d/<slot>.<ext> (see
// assets/3d/README.md). Falls back to a placeholder geometry per slot so the
// cards never appear empty before models are added.
mountAllHalftones();

// ─── Terminal shortcuts (bottom of the sticky panel) ──────────────────────
// Clicks on the shortcut buttons, single-letter keyboard shortcuts,
// and commands typed into the `hack@latam-sim$` prompt all resolve through
// the same table. Unknown typed commands do nothing.
const TERMINAL_TARGETS = {
  apply:      () => window.open("https://hack.indies.la/apply/", "_blank", "noopener"),
  tldr:       () => scrollToSection("tldr"),
  perks:      () => scrollToSection("perks"),
  tracks:     () => scrollToSection("tracks"),
  donde:      () => scrollToSection("donde"),
  where:      () => scrollToSection("donde"),
  map:        () => scrollToSection("donde"),      // [m] → where the cities live
  faq:        () => scrollToSection("faq"),
  help:       () => scrollToSection("faq"),        // [h] help → FAQ
  comunidades:() => scrollToSection("comunidades"),
  sponsors:   () => scrollToSection("sponsors"),
  eventos:    () => scrollToSection("eventos"),
  events:     () => scrollToSection("eventos"),
  top:        () => window.scrollTo({ top: 0, behavior: "smooth" }),
};

const KEY_TO_ACTION = {
  a: "apply",
  f: "faq",
  d: "donde",
  t: "tracks",
  p: "perks",
  c: "comunidades",
  s: "sponsors",
  e: "eventos",
};

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const chromeOffset = 54; // sticky chrome + breathing room
  const y = el.getBoundingClientRect().top + window.scrollY - chromeOffset;
  window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
}

function runAction(action) {
  const fn = TERMINAL_TARGETS[action];
  if (fn) fn();
}

// Clicks on the [X] shortcut buttons
document.querySelectorAll(".shortcut[data-action]").forEach((btn) => {
  btn.addEventListener("click", () => runAction(btn.dataset.action));
});

// Single-key shortcuts (only fire when the user is not typing into an input)
document.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = (e.key || "").toLowerCase();
  const action = KEY_TO_ACTION[key];
  if (!action) return;
  e.preventDefault();
  runAction(action);
});

// Typed commands in the prompt
const promptForm  = document.getElementById("prompt-form");
const promptInput = document.getElementById("prompt-input");
if (promptForm && promptInput) {
  promptForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const cmd = promptInput.value.trim().toLowerCase();
    promptInput.value = "";
    if (!cmd) return;
    if (TERMINAL_TARGETS[cmd]) runAction(cmd);
    else if (KEY_TO_ACTION[cmd]) runAction(KEY_TO_ACTION[cmd]);
  });
}
