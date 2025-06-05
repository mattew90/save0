// --- Sinc/Lanczos Upscaling Extension with robust Nearest Neighbor Integer Fallback ---
// Integrates the old extension's fallback and logic.

const propertyName  = 'image-rendering';
const styleAttrName = 'style';
const autoValue     = 'auto';
const propertyValue = 'pixelated';

// Save/restore original image-rendering
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

// Integer check
function isInteger(number) {
  return Math.floor(number) === number;
}

// Fallback: Old extension's logic for integer upscales
function oldNearestNeighborFallback(img) {
  // SVG is vector, don't touch
  if (img.src.endsWith('.svg')) return false;

  saveRendering(img);

  // If using srcset and browser picked a different src, don't force NN
  if (img.srcset && img.srcset.trim().length && img.src !== img.currentSrc) {
    restoreRendering(img);
    console.log('[SincUpscale] Fallback skipped: srcset mismatch', img.src);
    return false;
  }

  // Get computed sizes
  const style = getComputedStyle(img, null);
  if (style.getPropertyValue('display') === 'none') return false;
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

  // Calculate zoom (scaling factor)
  const x = width / img.naturalWidth;
  const y = height / img.naturalHeight;

  // Only apply if both axes are the same and are integer upscale > 1
  const zoom = x === y ? x * (window.devicePixelRatio || 1) : 0;
  if (zoom > 1 && isInteger(zoom)) {
    img.style.imageRendering = propertyValue;
    img.style.msInterpolationMode = 'nearest-neighbor';
    img.style.webkitTransform = 'translateZ(0)';
    console.log('[SincUpscale] Old fallback applied: nearest neighbor integer upscale', img.src);
    return true;
  } else {
    restoreRendering(img);
    console.log('[SincUpscale] Fallback skipped: not integer upscale', img.src);
    return false;
  }
}

// --- Sinc/Lanczos upscaling with WebGL (unchanged) ---
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

function needsUpscaling(img) {
  const style = window.getComputedStyle(img);
  const width = parseFloat(style.width) || img.width;
  const height = parseFloat(style.height) || img.height;
  return width > img.naturalWidth || height > img.naturalHeight;
}

async function replaceWithSincCanvas(img, radius = 3) {
  if (!img.complete || !img.naturalWidth) {
    img.addEventListener('load', () => replaceWithSincCanvas(img, radius), { once: true });
    return;
  }

  // Fallback: If not CORS safe, try the old extension's fallback
  if (!isCORSsafe(img)) {
    console.log('[SincUpscale] Resorting to old fallback due to CORS:', img.src);
    if (!oldNearestNeighborFallback(img)) {
      console.log('[SincUpscale] Fallback failed or not applicable for image:', img.src);
    }
    return;
  }

  const style = window.getComputedStyle(img);
  const width = parseFloat(style.width) || img.width;
  const height = parseFloat(style.height) || img.height;

  // Create and size the canvas
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.display = style.display;
  canvas.style.width = style.width;
  canvas.style.height = style.height;
  canvas.style.objectFit = style.objectFit;

  img.style.display = "none";
  img.parentNode.insertBefore(canvas, img);

  // Set up WebGL
  const gl = canvas.getContext('webgl');
  if (!gl) {
    console.warn("WebGL not supported");
    canvas.remove();
    img.style.display = "";
    // try fallback if canvas failed
    if (!oldNearestNeighborFallback(img)) {
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
    console.warn("[SincUpscale] Shader compile/link failed:", e);
    canvas.remove();
    img.style.display = "";
    if (!oldNearestNeighborFallback(img)) {
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
    console.warn("[SincUpscale] WebGL texture upload failed, skipping image:", img.src, e);
    canvas.remove();
    img.style.display = "";
    if (!oldNearestNeighborFallback(img)) {
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

  // Log on success
  console.log("[SincUpscale] Successfully replaced image with sinc canvas:", img.src);
}

// Helper to process all current and future images
function processImages() {
  for (const img of document.querySelectorAll('img')) {
    if (!img.dataset.sincUpscaled && needsUpscaling(img)) {
      img.dataset.sincUpscaled = "true";
      replaceWithSincCanvas(img, 3);
    }
  }
}

const mo = new MutationObserver(processImages);
mo.observe(document.body, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', processImages);
window.addEventListener('load', processImages);
processImages();