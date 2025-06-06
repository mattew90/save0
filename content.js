// --- Sinc/Lanczos Resampling Extension with robust Nearest Neighbor Integer Fallback ---
// WebGL2 when available, sRGB-safe, no double-flip, and no unneeded gamma correction.
// Images are not upside down, and colors match original unless doing linear math for downsampling!

const propertyName  = 'image-rendering';
const autoValue     = 'auto';
const propertyValue = 'pixelated';

const renderingMap = new WeakMap();
function saveRendering(image) {
  if (!renderingMap.has(image)) {
    renderingMap.set(image, image.style.imageRendering || autoValue);
  }
}
function restoreRendering(image) {
  if (renderingMap.has(image)) {
    image.style.imageRendering = renderingMap.get(image);
    renderingMap.delete(image);
  }
}

function isSVG(img) {
  try {
    const src = img.currentSrc || img.src || '';
    return /\.svg(\?|#|$)/i.test(src);
  } catch { return false; }
}

function isInteger(number) {
  return Math.abs(Math.round(number) - number) < 1e-5;
}

function getScaleInfo(img) {
  const style = getComputedStyle(img, null);
  let width = parseFloat(style.width) || img.width;
  let height = parseFloat(style.height) || img.height;
  if (style.getPropertyValue('box-sizing') === 'border-box') {
    const borderW = parseFloat(style.getPropertyValue('border-left-width')) + parseFloat(style.getPropertyValue('border-right-width'));
    const borderH = parseFloat(style.getPropertyValue('border-top-width')) + parseFloat(style.getPropertyValue('border-bottom-width'));
    const padW = parseFloat(style.getPropertyValue('padding-left')) + parseFloat(style.getPropertyValue('padding-right'));
    const padH = parseFloat(style.getPropertyValue('padding-top')) + parseFloat(style.getPropertyValue('padding-bottom'));
    width -= (borderW + padW);
    height -= (borderH + padH);
  }
  const scaleX = width / img.naturalWidth;
  const scaleY = height / img.naturalHeight;
  const needs = (Math.abs(scaleX - 1) > 1e-3) || (Math.abs(scaleY - 1) > 1e-3);
  return { scaleX, scaleY, needs, width, height, style };
}

function oldNearestNeighborFallback(img, scaleX, scaleY) {
  if (isSVG(img)) {
    return false;
  }
  saveRendering(img);
  if (img.srcset && img.srcset.trim().length && img.src !== img.currentSrc) {
    restoreRendering(img);
    return false;
  }
  if (!isInteger(scaleX) || !isInteger(scaleY) || scaleX !== scaleY || scaleX <= 1) {
    restoreRendering(img);
    return false;
  }
  img.style.imageRendering = propertyValue;
  img.style.msInterpolationMode = 'nearest-neighbor';
  img.style.webkitTransform = 'translateZ(0)';
  console.log('[SincUpscale] Fallback success: applied nearest neighbor integer upscale', img.src, {scaleX, scaleY});
  return true;
}

function isCORSsafe(img) {
  if (
    img.src.startsWith("data:") ||
    img.src.startsWith("blob:") ||
    img.src.startsWith(window.location.origin)
  ) {
    return true;
  }
  return img.crossOrigin === "anonymous";
}

// --- Copy all computed styles except width/height (set separately) ---
function copyAllComputedStyles(from, to) {
  const computed = window.getComputedStyle(from);
  for (let prop of computed) {
    if (prop === "width" || prop === "height") continue;
    try {
      to.style[prop] = computed.getPropertyValue(prop);
    } catch (e) {}
  }
  to.className = from.className || "";
  to.id = from.id || "";
  // Copy data attributes
  for (const attr of from.attributes) {
    if (attr.name.startsWith('data-')) {
      to.setAttribute(attr.name, attr.value);
    }
  }
}

// --- Memory cache for downloaded images ---
const storedImages = {};

async function fetchAndCacheImage(img) {
  const url = img.src;
  // Skip if already data/blob or same-origin, or already cached
  if (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith(window.location.origin) ||
    storedImages[url]
  ) {
    return;
  }
  try {
    const resp = await fetch(url, {mode: "cors"});
    if (!resp.ok) throw new Error("Image fetch failed " + resp.status);
    const blob = await resp.blob();
    const reader = new FileReader();
    reader.onloadend = () => {
      storedImages[url] = reader.result;
      // Set the image src to the new data URL and retry processing
      img.src = reader.result;
      // Mark so we don't try this again for this image
      img.dataset.sincUpscaled_fetched = "true";
      // Wait for image to reload, then retry
      img.addEventListener('load', processImages, {once: true});
    };
    reader.readAsDataURL(blob);
  } catch (e) {
    console.warn('Failed to cache image:', url, e);
    img.dataset.sincUpscaled = "failed";
  }
}

function getPassthroughShaders(isWebGL2) {
  return {
    vert: isWebGL2 ? `#version 300 es
      in vec2 aPos;
      in vec2 aTex;
      out vec2 vTex;
      void main() {
        vTex = aTex;
        gl_Position = vec4(aPos, 0, 1);
      }
    ` : `
      attribute vec2 aPos;
      attribute vec2 aTex;
      varying vec2 vTex;
      void main() {
        vTex = aTex;
        gl_Position = vec4(aPos, 0, 1);
      }
    `,
    frag: isWebGL2 ? `#version 300 es
      precision highp float;
      in vec2 vTex;
      uniform sampler2D uTex;
      out vec4 fragColor;
      void main() {
        fragColor = texture(uTex, vTex);
      }
    ` : `
      precision highp float;
      varying vec2 vTex;
      uniform sampler2D uTex;
      void main() {
        gl_FragColor = texture2D(uTex, vTex);
      }
    `
  };
}

// --- Optimized Sinc/Lanczos resampling using unrolled 7x7 kernel ---
async function replaceWithSincCanvas(img, scaleX, scaleY, width, height, style = null) {
  if (isSVG(img)) {
    return;
  }
  if (!img.complete || !img.naturalWidth) {
    img.addEventListener('load', () => replaceWithSincCanvas(img, scaleX, scaleY, width, height, style), { once: true });
    return;
  }
  if (!isCORSsafe(img)) {
    // If not already tried to fetch, do so
    if (!img.dataset.sincUpscaled_fetched) {
      fetchAndCacheImage(img);
    }
    // Do not proceed until image is replaced with data URL version
    return;
  }

  // Create and size the canvas
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  style = style || window.getComputedStyle(img);

  // Copy all computed styles except width/height, then set those explicitly
  copyAllComputedStyles(img, canvas);
  canvas.style.width = style.width;
  canvas.style.height = style.height;

  img.style.display = "none";
  img.parentNode.insertBefore(canvas, img);

  // --- WebGL2 context and fallback ---
  let gl = canvas.getContext('webgl2');
  const isWebGL2 = !!gl;
  let hasRenderableRGBA16F = false;
  let useFloatFbo = false;
  if (isWebGL2 && gl.getExtension('EXT_color_buffer_float')) {
    hasRenderableRGBA16F = true;
  }
  if (!gl) {
    gl = canvas.getContext('webgl');
    if (!gl) {
      console.warn("[SincUpscale] WebGL not supported. Resorting to fallback.", img.src);
      canvas.remove();
      img.style.display = "";
      if (!oldNearestNeighborFallback(img, scaleX, scaleY)) {
      }
      return;
    }
  }

  // --- Create source texture from image (always RGBA/UNSIGNED_BYTE for HTMLImageElement) ---
  const srcTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // --- For WebGL2: render to RGBA16F float framebuffer for max quality, only if supported ---
  let fbo = null, renderTex = null;
  if (isWebGL2 && hasRenderableRGBA16F) {
    renderTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, renderTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, renderTex, 0);

    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn("[SincUpscale] WebGL2 framebuffer incomplete, falling back to canvas.", fbStatus);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      fbo = null;
      renderTex = null;
    } else {
      useFloatFbo = true;
    }
  }

  // --- Which workflow: linear (for downsampling only) ---
  const isDownsample = (scaleX < 1 && scaleY < 1);

  // Vertex shader (WebGL2 version if possible)
  const vertSource = isWebGL2 ? `#version 300 es
    in vec2 aPos;
    in vec2 aTex;
    out vec2 vTex;
    void main() {
      vTex = aTex;
      gl_Position = vec4(aPos, 0, 1);
    }
  ` : `
    attribute vec2 aPos;
    attribute vec2 aTex;
    varying vec2 vTex;
    void main() {
      vTex = aTex;
      gl_Position = vec4(aPos, 0, 1);
    }
  `;

  // Only do linear light for downsampling, not upsampling.
  const fragSource = isWebGL2 ? `#version 300 es
    precision highp float;
    in vec2 vTex;
    uniform sampler2D uTex;
    uniform vec2 uSrcSize, uDstSize;
    uniform bool uDown;
    out vec4 fragColor;
    float sinc(float x) { if (x == 0.0) return 1.0; float pix = 3.14159265359 * x; return sin(pix) / pix; }
    float lanczos(float x, float a) { x = abs(x); if (x >= a) return 0.0; return sinc(x) * sinc(x / a); }
    void main() {
      vec2 scale = uSrcSize / uDstSize;
      vec2 srcCoord = vTex * uDstSize * scale;
      vec2 center = srcCoord - 0.5;
      vec4 color = vec4(0.0);
      float total = 0.0;
      float r = 3.0;
      for (int dy = -3; dy <= 3; ++dy) {
        for (int dx = -3; dx <= 3; ++dx) {
          vec2 offset = vec2(float(dx), float(dy));
          vec2 sampleCoord = (center + offset + 0.5) / uSrcSize;
          vec4 texel = texture(uTex, sampleCoord);
          if (uDown) {
            texel.rgb = pow(texel.rgb, vec3(2.2));
          }
          float weight = lanczos(float(dx), r) * lanczos(float(dy), r);
          color += texel * weight;
          total += weight;
        }
      }
      color /= total;
      if (uDown) {
        color.rgb = pow(color.rgb, vec3(1.0/2.2));
      }
      fragColor = color;
    }
  ` : `
    precision highp float;
    varying vec2 vTex;
    uniform sampler2D uTex;
    uniform vec2 uSrcSize;
    uniform vec2 uDstSize;
    uniform bool uDown;
    float sinc(float x) { if (x == 0.0) return 1.0; float pix = 3.14159265359 * x; return sin(pix) / pix; }
    float lanczos(float x, float a) { x = abs(x); if (x >= a) return 0.0; return sinc(x) * sinc(x / a); }
    void main() {
      vec2 scale = uSrcSize / uDstSize;
      vec2 srcCoord = vTex * uDstSize * scale;
      vec2 center = srcCoord - 0.5;
      vec4 color = vec4(0.0);
      float total = 0.0;
      float r = 3.0;
      for (int dy = -3; dy <= 3; ++dy) {
        for (int dx = -3; dx <= 3; ++dx) {
          vec2 offset = vec2(float(dx), float(dy));
          vec2 sampleCoord = (center + offset + 0.5) / uSrcSize;
          vec4 texel = texture2D(uTex, sampleCoord);
          if (uDown) {
            texel.rgb = pow(texel.rgb, vec3(2.2));
          }
          float weight = lanczos(float(dx), r) * lanczos(float(dy), r);
          color += texel * weight;
          total += weight;
        }
      }
      color /= total;
      if (uDown) {
        color.rgb = pow(color.rgb, vec3(1.0/2.2));
      }
      gl_FragColor = color;
    }
  `;

  // --- Compile shaders and create program ---
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw gl.getShaderInfoLog(s);
    }
    return s;
  }
  let vs, fs, prog;
  try {
    vs = compile(gl, gl.VERTEX_SHADER, vertSource);
    fs = compile(gl, gl.FRAGMENT_SHADER, fragSource);
    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);
  } catch (e) {
    console.warn("[SincUpscale] Shader compile/link failed. Resorting to fallback.", img.src, e);
    canvas.remove();
    img.style.display = "";
    if (!oldNearestNeighborFallback(img, scaleX, scaleY)) {
    }
    return;
  }

  // --- Set up quad: top-left is (0,0), bottom-left is (0,1), with UNPACK_FLIP_Y_WEBGL this will display upright ---
  const posLoc = gl.getAttribLocation(prog, isWebGL2 ? 'aPos' : 'aPos');
  const texLoc = gl.getAttribLocation(prog, isWebGL2 ? 'aTex' : 'aTex');
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const quad = new Float32Array([
    -1, -1, 0, 0,
     1, -1, 1, 0,
    -1,  1, 0, 1,
     1,  1, 1, 1,
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(texLoc);
  gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 16, 8);

  // --- Bind src texture to unit 0 ---
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);

  // --- Set uniforms ---
  gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
  gl.uniform2f(gl.getUniformLocation(prog, "uSrcSize"), img.naturalWidth, img.naturalHeight);
  gl.uniform2f(gl.getUniformLocation(prog, "uDstSize"), width, height);
  if (gl.getUniformLocation(prog, "uDown")) {
    gl.uniform1i(gl.getUniformLocation(prog, "uDown"), isDownsample ? 1 : 0);
  }

  // --- Draw pass 1: Sinc/Lanczos to FBO or canvas ---
  if (isWebGL2 && useFloatFbo) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  gl.viewport(0, 0, width, height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // --- If using FBO, draw a fullscreen quad to canvas using passthrough shader ---
  if (isWebGL2 && useFloatFbo) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const { vert, frag } = getPassthroughShaders(isWebGL2);
    let vs2, fs2, prog2;
    try {
      vs2 = compile(gl, gl.VERTEX_SHADER, vert);
      fs2 = compile(gl, gl.FRAGMENT_SHADER, frag);
      prog2 = gl.createProgram();
      gl.attachShader(prog2, vs2);
      gl.attachShader(prog2, fs2);
      gl.linkProgram(prog2);
      gl.useProgram(prog2);
    } catch (e) {
      console.warn("[SincUpscale] Passthrough shader compile/link failed, fallback to direct rendering. Error:", e);
      return;
    }
    const posLoc2 = gl.getAttribLocation(prog2, isWebGL2 ? 'aPos' : 'aPos');
    const texLoc2 = gl.getAttribLocation(prog2, isWebGL2 ? 'aTex' : 'aTex');
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(posLoc2);
    gl.vertexAttribPointer(posLoc2, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(texLoc2);
    gl.vertexAttribPointer(texLoc2, 2, gl.FLOAT, false, 16, 8);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, renderTex);
    gl.uniform1i(gl.getUniformLocation(prog2, "uTex"), 0);
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Log on success
  const scaleType = (scaleX > 1 && scaleY > 1) ? 'upscaling' :
                    (scaleX < 1 && scaleY < 1) ? 'downscaling' : 'non-uniform scaling';
  const backend = isWebGL2 ? (useFloatFbo ? "WebGL2+floatFBO" : "WebGL2") : "WebGL1";
  console.log(`[SincUpscale] Successfully resampled (${scaleType}) image with sinc: ${img.src} [${backend}]`, {scaleX, scaleY, width, height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight});
}

// --- Process all <img> elements, process immediately, not throttled ---
function processImages() {
  for (const img of document.querySelectorAll('img')) {
    if (img.dataset.sincUpscaled === "true" || img.dataset.sincUpscaled === "failed") continue;
    if (isSVG(img)) {
      img.dataset.sincUpscaled = "svg";
      continue;
    }
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener('load', processImages, {once: true});
      continue;
    }
    const { scaleX, scaleY, needs, width, height, style } = getScaleInfo(img);
    if (!needs) {
      img.dataset.sincUpscaled = "no";
      continue;
    }
    img.dataset.sincUpscaled = "true";
    replaceWithSincCanvas(img, scaleX, scaleY, width, height, style);
  }
}

const mo = new MutationObserver(processImages);
mo.observe(document.body, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', processImages);
window.addEventListener('load', processImages);
processImages();