// Pixel look for the 3D view: render the scene at low resolution, then quantise it with Bayer dithering.
//   "pixel": colours stay (few steps per channel), team colours and the sensor view stay readable
//   "spark": brightness mapped onto the brand's blue ramp, like the star
//   "klar":  no filter ("clear")
import * as THREE from "three";

export type PixelMode = "pixel" | "spark" | "klar";

const vertex = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const fragment = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform vec2 uRes;
uniform int uMode;
uniform float uLevels;
uniform vec3 uRamp[5];
varying vec2 vUv;

vec3 toSRGB(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = y * 4 + x;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}

void main() {
  vec2 px = floor(vUv * uRes);
  // the render target is linear without tone mapping: convert to sRGB first, then quantise in perceptual steps
  vec3 c = toSRGB(texture2D(tScene, (px + 0.5) / uRes).rgb);
  float b = bayer4(px) - 0.5;
  if (uMode == 1) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    l = pow(clamp(l, 0.0, 1.0), 0.8);
    float idx = clamp(floor(l * 4.0 + b + 0.5), 0.0, 4.0);
    vec3 o = uRamp[0];
    if (idx > 0.5) o = uRamp[1];
    if (idx > 1.5) o = uRamp[2];
    if (idx > 2.5) o = uRamp[3];
    if (idx > 3.5) o = uRamp[4];
    gl_FragColor = vec4(o, 1.0);
  } else {
    float n = uLevels - 1.0;
    vec3 q = floor(c * n + b + 0.5) / n;
    gl_FragColor = vec4(clamp(q, 0.0, 1.0), 1.0);
  }
}`;

export class PixelPass {
  mode: PixelMode = "pixel";
  private rt: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;

  constructor() {
    this.rt = new THREE.WebGLRenderTarget(4, 4, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType, // no banding in dark areas before dithering
    });
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.rt.texture },
        uRes: { value: new THREE.Vector2(4, 4) },
        uMode: { value: 0 },
        uLevels: { value: 6 },
        uRamp: { value: [0, 0, 0, 0, 0].map(() => new THREE.Vector3()) },
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.scene.add(this.quad);
  }

  /** Five sRGB colours from dark to bright (output unchanged) */
  setRamp(hex: string[]) {
    (this.mat.uniforms.uRamp.value as THREE.Vector3[]).forEach((v, i) => {
      const n = parseInt(hex[i].slice(1), 16);
      v.set(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    });
  }

  setLevels(levels: number) {
    this.mat.uniforms.uLevels.value = levels;
  }

  /** Canvas size in device pixels and pixel size in device pixels */
  setSize(w: number, h: number, pixel: number) {
    const rw = Math.max(1, Math.ceil(w / pixel));
    const rh = Math.max(1, Math.ceil(h / pixel));
    this.rt.setSize(rw, rh);
    (this.mat.uniforms.uRes.value as THREE.Vector2).set(rw, rh);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    if (this.mode === "klar") {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    this.mat.uniforms.uMode.value = this.mode === "spark" ? 1 : 0;
    renderer.setRenderTarget(this.rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.cam);
  }
}
