// --- Sinc/Lanczos Resampling Extension with robust Nearest Neighbor Integer Fallback ---
// Handles upscaling and downscaling, logs all events, skips SVG, robust fallback, and preserves border radius/circle crops.

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
    console.log('[SincUpscale] Restored original rendering for image:', image.src);
  }
}

// Utility: returns true if file extension is SVG
function isSVG(img) {
  try {
    const src = img.currentSrc || img.src || '';
    return /\.svg(\?|#|$)/i.test(src);
  } catch { return false; }
}

function isInteger(number) {
  return Math.abs(Math.round(number) - number) < 1e-5;
}

// Returns scaleX, scaleY and a boolean if resampling is needed (any scaling)
function getScaleInfo(img) {
  const style = getComputedStyle(img, null);
  let width = parseFloat(style.width) || img.width;
  let height = parseFloat(style.height) || img.height;

  // Account for box-sizing
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

// Fallback: Old extension's logic for integer upscales/descales
function oldNearestNeighborFallback(img, scaleX, scaleY) {
  if (isSVG(img)) {
    console.log('[SincUpscale] Fallback skipped: SVG image', img.src);
    return false;
  }

  saveRendering(img);

  // If using srcset and browser picked a different src, don't force NN
  if (img.srcset && img.srcset.trim().length && img.src !== img.currentSrc) {
    restoreRendering(img);
    console.log('[SincUpscale] Fallback skipped: srcset mismatch', img.src);
    return false;
  }

  if (!isInteger(scaleX) || !isInteger(scaleY) || scaleX !== scaleY || scaleX <= 1) {
    restoreRendering(img);
    console.log('[SincUpscale] Fallback skipped: not integer upscale', img.src, {scaleX, scaleY});
    return false;
  }
  img.style.imageRendering = propertyValue;
  img.style.msInterpolationMode = 'nearest-neighbor';
  img.style.webkitTransform = 'translateZ(0)';
  console.log('[SincUpscale] Old fallback applied: nearest neighbor integer upscale', img.src, {scaleX, scaleY});
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

// --- Style preservation for borderRadius/circle cropping ---
function copyShapeStyles(from, to, style) {
  // Copy border radius and basic object fit/position for cropping
  to.style.borderRadius = style.borderRadius;
  to.style.objectFit = style.objectFit;
  to.style.objectPosition = style.objectPosition;
  to.style.background = style.background;
  // Copy box-shadow and border if present
  to.style.boxShadow = style.boxShadow;
  to.style.border = style.border;
  // Copy class if present (may help with advanced CSS)
  to.className = from.className || "";
}

async function replaceWithSincCanvas(img, scaleX, scaleY, width, height, radius = 3, style = null) {
  if (isSVG(img)) {
    console.log('[SincUpscale] Skipping SVG image:', img.src);
    return;
  }
  if (!img.complete || !img.naturalWidth) {
    img.addEventListener('load', () => replaceWithSincCanvas(img, scaleX, scaleY, width, height, radius, style), { once: true });
    console.log('[SincUpscale] Waiting for image to load:', img.src);
    return;
  }

  // Fallback: If not CORS safe, try the old extension's fallback
  if (!isCORSsafe(img)) {
    console.log('[SincUpscale] Resorting to old fallback due to CORS:', img.src);
    if (!oldNearestNeighborFallback(img, scaleX, scaleY)) {
      console.log('[SincUpscale] Fallback failed or not applicable for image:', img.src);
    }
    return;
  }

  // Create and size the canvas
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  style = style || window.getComputedStyle(img);
  canvas.style.display = style.display;
  canvas.style.width = style.width;
  canvas.style.height = style.height;

  // --- Preserve circular cropping and key styles ---
  copyShapeStyles(img, canvas, style);

  img.style.display = "none";
  img.parentNode.insertBefore(canvas, img);

  // Set up WebGL
  const gl = canvas.getContext('webgl');
  if (!gl) {
    console.warn("[SincUpscale] WebGL not supported. Resorting to fallback.", img.src);
    canvas.remove();
    img.style.display = "";
    if (!oldNearestNeighborFallback(img, scaleX, scaleY)) {
      console.log('[SincUpscale] Fallback failed or not applicable for image:', img.src);
    }
    return;
  }

  // Vertex shader (simple passthrough)
  const vertSource = `
    attribute vec2 aPos;
    attribute vec2 aTex;
    varying vec2 vTex;
    void main() {
      vTex = aTex;
      gl_Position = vec4(aPos, 0, 1);
    }
  `;

  // Fragment shader (Lanczos-3: windowed sinc, correct implementation)
  const fragSource = `
    precision mediump float;
    varying vec2 vTex;
    uniform sampler2D uTex;
    uniform vec2 uSrcSize;
    uniform vec2 uDstSize;
    uniform float uRadius;

    float sinc(float x) {
      if (x == 0.0) return 1.0;
      float pix = 3.14159265359 * x;
      return sin(pix) / pix;
    }

    float lanczos(float x, float a) {
      x = abs(x);
      if (x >= a) return 0.0;
      return sinc(x) * sinc(x / a);
    }

    void main() {
      vec2 scale = uSrcSize / uDstSize;
      vec2 srcCoord = vTex * uDstSize * scale;
      vec2 center = srcCoord - 0.5;

      vec4 color = vec4(0.0);
      float total = 0.0;
      float radius = uRadius;

      for (float dy = -3.0; dy <= 3.0; dy += 1.0) {
        for (float dx = -3.0; dx <= 3.0; dx += 1.0) {
          vec2 offset = vec2(dx, dy);
          vec2 sampleCoord = (center + offset + 0.5) / uSrcSize;
          float weight = lanczos(dx, radius) * lanczos(dy, radius);
          color += texture2D(uTex, sampleCoord) * weight;
          total += weight;
        }
      }
      gl_FragColor = color / total;
    }
  `;

  // Compile shaders and create program
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
      console.log('[SincUpscale] Fallback failed or not applicable for image:', img.src);
    }
    return;
  }

  // Set up quad
  const posLoc = gl.getAttribLocation(prog, 'aPos');
  const texLoc = gl.getAttribLocation(prog, 'aTex');
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const quad = new Float32Array([
    -1, -1, 0, 0,
    1, -1, 1, 0,
    -1, 1, 0, 1,
    1, 1, 1, 1,
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(texLoc);
  gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 16, 8);

  // Create and upload texture
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    if (gl.getError() !== gl.NO_ERROR) throw "WebGL error after texImage2D";
  } catch (e) {
    console.warn("[SincUpscale] WebGL texture upload failed. Resorting to fallback.", img.src, e);
    canvas.remove();
    img.style.display = "";
    if (!oldNearestNeighborFallback(img, scaleX, scaleY)) {
      console.log('[SincUpscale] Fallback failed or not applicable for image:', img.src);
    }
    return;
  }

  // Set uniforms
  gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
  gl.uniform2f(gl.getUniformLocation(prog, "uSrcSize"), img.naturalWidth, img.naturalHeight);
  gl.uniform2f(gl.getUniformLocation(prog, "uDstSize"), width, height);
  gl.uniform1f(gl.getUniformLocation(prog, "uRadius"), radius);

  // Draw quad
  gl.viewport(0, 0, width, height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // Log on success with scale info
  const scaleType = (scaleX > 1 && scaleY > 1) ? 'upscaling' :
                    (scaleX < 1 && scaleY < 1) ? 'downscaling' : 'non-uniform scaling';
  console.log(`[SincUpscale] Successfully resampled (${scaleType}) image with sinc:`, img.src, {scaleX, scaleY, width, height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight});
}

function processImages() {
  for (const img of document.querySelectorAll('img')) {
    if (img.dataset.sincUpscaled === "true") {
      // Already processed
      continue;
    }
    if (isSVG(img)) {
      console.log('[SincUpscale] Skipping SVG image in processImages:', img.src);
      img.dataset.sincUpscaled = "svg";
      continue;
    }
    if (!img.complete || !img.naturalWidth) {
      // Not loaded yet
      img.addEventListener('load', () => processImages(), {once: true});
      console.log('[SincUpscale] Image not complete or has no naturalWidth:', img.src);
      continue;
    }
    const { scaleX, scaleY, needs, width, height, style } = getScaleInfo(img);
    if (!needs) {
      console.log('[SincUpscale] No resampling needed (1:1 scale):', img.src);
      img.dataset.sincUpscaled = "no";
      continue;
    }
    img.dataset.sincUpscaled = "true";
    const scaleType = (scaleX > 1 && scaleY > 1) ? 'upscaling' :
                      (scaleX < 1 && scaleY < 1) ? 'downscaling' : 'non-uniform scaling';
    console.log(`[SincUpscale] Will attempt sinc resampling for ${scaleType}:`, img.src, {scaleX, scaleY, width, height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight});
    replaceWithSincCanvas(img, scaleX, scaleY, width, height, 3, style);
  }
}

const mo = new MutationObserver(processImages);
mo.observe(document.body, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', processImages);
window.addEventListener('load', processImages);
processImages();