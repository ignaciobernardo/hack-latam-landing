// Halftone dot shader for GLTF / placeholder meshes.
// Exposes `mountHalftone(canvas, options)` and `mountAllHalftones()`.
//
// The shader follows the spec:
//   - vertex pass UVs + normal
//   - fragment builds a fract-grid from UVs, each cell's dot radius driven by
//     the lambert brightness of the surface (N · L)
//   - smoothstep instead of step to get a soft amber glow around every dot
//   - UVs rotated 45° and jittered over time for a subtle CRT/phosphor feel

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const DEFAULT_COLOR = new THREE.Color(1.0, 0.6, 0.1);       // amber
const DEFAULT_LIGHT_DIR = new THREE.Vector3(0.6, 0.75, 0.9).normalize();

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldNormal;

  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform float uScale;
  uniform vec3  uColor;
  uniform float uContrast;
  uniform float uTime;
  uniform vec3  uLightDir;

  varying vec2 vUv;
  varying vec3 vNormal;

  void main() {
    // Lambertian brightness
    float brightness = max(0.0, dot(normalize(vNormal), normalize(uLightDir)));
    // Small ambient so the shadowed side doesn't disappear entirely
    brightness = mix(0.15, 1.0, brightness);
    brightness = pow(brightness, uContrast);

    // Rotate UV by 45° + subtle breathing
    float angle = 0.785398163;           // π/4
    float c = cos(angle), s = sin(angle);
    vec2 uv = vUv - 0.5;
    uv = mat2(c, -s, s, c) * uv;
    uv += 0.5;
    uv += vec2(sin(uTime * 0.3) * 0.002, cos(uTime * 0.27) * 0.002);

    // Halftone dot grid
    vec2 grid = fract(uv * uScale);
    float d = length(grid - 0.5);
    float radius = mix(0.05, 0.5, brightness);

    // Soft glow — smoothstep gives anti-aliased dots with a subtle phosphor halo
    float mask = 1.0 - smoothstep(radius - 0.06, radius + 0.01, d);

    vec3 color = uColor * mask;
    // Premultiplied alpha-ish for nice blending on the dark terminal bg
    gl_FragColor = vec4(color, mask);
  }
`;

function makeMaterial({ scale, color, contrast }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uScale:    { value: scale },
      uColor:    { value: new THREE.Color(color.r, color.g, color.b) },
      uContrast: { value: contrast },
      uTime:     { value: 0 },
      uLightDir: { value: DEFAULT_LIGHT_DIR.clone() },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

// A tiny palette of placeholder geometries keyed by slot name so the page
// never looks empty before GLTFs land in "assets 3d/".
function makePlaceholderGeometry(slot) {
  switch (slot) {
    case "cash":         return new THREE.TorusGeometry(0.9, 0.28, 24, 64);
    case "credits":      return new THREE.BoxGeometry(1.4, 0.9, 0.16, 1, 1, 1);
    case "participants": return new THREE.IcosahedronGeometry(0.95, 2);
    default:             return new THREE.TorusKnotGeometry(0.75, 0.22, 120, 16);
  }
}

const gltfLoader = new GLTFLoader();

// Tries `./assets 3d/<model>.glb` first, then `.gltf`. Both path segments are
// URL-encoded (the folder name contains a space, and model names like
// "Coin Dollar Sign" contain spaces too). Resolves null on miss.
async function tryLoadModel(modelName) {
  if (!modelName) return null;
  const folder = encodeURIComponent("assets 3d");
  const file = encodeURIComponent(modelName);
  for (const ext of ["glb", "gltf"]) {
    const url = `./${folder}/${file}.${ext}`;
    try {
      const head = await fetch(url, { method: "HEAD" });
      if (!head.ok) continue;
      return await new Promise((resolve, reject) => {
        gltfLoader.load(url, (g) => resolve(g.scene), undefined, reject);
      });
    } catch {
      // try next
    }
  }
  return null;
}

export function mountHalftone(canvas, opts = {}) {
  const {
    model    = canvas.dataset.model || null,
    slot     = canvas.dataset.slot || null,
    scale    = Number(canvas.dataset.scale) || 80,
    contrast = Number(canvas.dataset.contrast) || 1.1,
    color    = DEFAULT_COLOR,
  } = opts;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    premultipliedAlpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0, 0, 4.1); // further back → extra margin so models
                                  //  never touch the canvas edges

  // Directional light — used both for the spec's dot(N, L) brightness AND for
  // a subtle real light in case the model has opaque fallbacks.
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.copy(DEFAULT_LIGHT_DIR).multiplyScalar(5);
  scene.add(dirLight);

  const material = makeMaterial({ scale, color, contrast });

  let group = new THREE.Group();
  scene.add(group);

  // Keep the canvas hidden until the real model has loaded (or we've given up
  // on it). Avoids the brief flash of a placeholder shape on hard reloads.
  canvas.style.opacity = "0";
  canvas.style.transition = "opacity 0.25s ease-out";

  // The placeholder is only shown if the GLB fails to load — otherwise the
  // user goes straight from invisible → real model.
  const placeholder = new THREE.Mesh(makePlaceholderGeometry(slot), material);
  placeholder.visible = false;
  group.add(placeholder);

  // If loading takes longer than a second, reveal the placeholder as a
  // fallback so the card isn't awkwardly empty.
  const placeholderTimer = setTimeout(() => {
    if (!placeholder.parent) return;
    placeholder.visible = true;
    canvas.style.opacity = "1";
  }, 1000);

  tryLoadModel(model).then((obj) => {
    clearTimeout(placeholderTimer);
    if (!obj) {
      placeholder.visible = true;
      canvas.style.opacity = "1";
      return;
    }
    group.remove(placeholder);
    obj.traverse((child) => {
      if (child.isMesh) child.material = material;
    });

    // Use a wrapper so we can fix the per-model base rotation (headphones
    // upside down, etc.) without losing the tumbling animation on `group`.
    const wrapper = new THREE.Group();

    // Bounding sphere based normalization: center the bbox at origin, then
    // scale the wrapper so the model's bounding sphere fits inside a target
    // radius. The bounding sphere is more robust than max-axis for models
    // with very asymmetric shape (headphones = wide + short, laptop = wide
    // + thin, etc.) and guarantees nothing clips the canvas edges.
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    obj.position.sub(center);                    // center model at origin

    const sphereRadius = size.length() * 0.5;    // diagonal / 2
    const targetRadius = 0.85;                   // leaves visual margin
    const s = sphereRadius > 0 ? targetRadius / sphereRadius : 1;
    wrapper.scale.setScalar(s);

    // Per-canvas base rotation (in degrees via data attributes).
    // Used e.g. to flip headphones right-side-up: data-rot-x="180".
    const rx = parseFloat(canvas.dataset.rotX) || 0;
    const ry = parseFloat(canvas.dataset.rotY) || 0;
    const rz = parseFloat(canvas.dataset.rotZ) || 0;
    const oy = parseFloat(canvas.dataset.offsetY) || 0;
    wrapper.rotation.set(
      THREE.MathUtils.degToRad(rx),
      THREE.MathUtils.degToRad(ry),
      THREE.MathUtils.degToRad(rz),
    );
    // Per-canvas vertical offset to fine-tune centering by asset.
    wrapper.position.y = oy;

    wrapper.add(obj);
    group.add(wrapper);
    // Reveal the canvas now that the real model is in place
    canvas.style.opacity = "1";
  });

  function resize() {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const clock = new THREE.Clock();
  function tick() {
    const dt = clock.getDelta();
    material.uniforms.uTime.value += dt;
    group.rotation.y += dt * 0.45;
    group.rotation.x = Math.sin(material.uniforms.uTime.value * 0.4) * 0.25;
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return {
    material,
    setScale(v)    { material.uniforms.uScale.value = v; },
    setContrast(v) { material.uniforms.uContrast.value = v; },
    setColor(c)    { material.uniforms.uColor.value.copy(c); },
    destroy() {
      ro.disconnect();
      renderer.dispose();
      material.dispose();
    },
  };
}

// Convenience: mount all canvases with [data-halftone] on the page.
export function mountAllHalftones() {
  return [...document.querySelectorAll("canvas[data-halftone]")].map((c) =>
    mountHalftone(c),
  );
}
