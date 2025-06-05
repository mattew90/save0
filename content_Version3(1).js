// --- Sinc/Lanczos Resampling Extension with robust Nearest Neighbor Integer Fallback ---
// Optimized: Unrolled kernel, throttled DOM observer, all shader code inlined, processes all <img> elements.
// Now with WebGL2/high quality, sRGB/float16 output, and linear vs sigmoidal workflow for down/upsampling.

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
    console.log('[SincUpscale] Fallback skipped: SVG image', img.src);
    return false;
  }
  saveRendering(img);
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

function copyShapeStyles(from, to, style) {
  to.style.borderRadius = style.borderRadius;
  to.style.objectFit = style.objectFit;
  to.style.objectPosition = style.objectPosition;
  to.style.background = style.background;
  to.style.boxShadow = style.boxShadow;
  to.style.border = style.border;
  to.className = from.className || "";
}

// --- Optimized Sinc/Lanczos resampling using unrolled 7x7 kernel ---
// Now with WebGL2/sRGB/float16 + linear/sigmoidal workflow
async function replaceWithSincCanvas(img, scaleX, scaleY, width, height, style = null) {
  const radius = 3.0;
  if (isSVG(img)) {
    console.log('[SincUpscale] Skipping SVG image:', img.src);
    return;
  }
  if (!img.complete || !img.naturalWidth) {
    img.addEventListener('load', () => replaceWithSincCanvas(img, scaleX, scaleY, width, height, style), { once: true });
    console.log('[SincUpscale] Waiting for image to load:', img.src);
    return;
  }
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
  copyShapeStyles(img, canvas, style);
  img.style.display = "none";
  img.parentNode.insertBefore(canvas, img);

  // --- WebGL2 context and fallback ---
  let gl = canvas.getContext('webgl2');
  const isWebGL2 = !!gl;
  if (!gl) {
    gl = canvas.getContext('webgl');
    if (!gl) {
      console.warn("[SincUpscale] WebGL not supported. Resorting to fallback.", img.src);
      canvas.remove();
      img.style.display = "";
      if (!oldNearestNeighborFallback(img, scaleX, scaleY)) {
        console.log('[SincUpscale] Fallback failed or not applicable for image:', img.src);
      }
      return;
    }
  }

  // --- Precision check (for debugging) ---
  const highp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  if (highp.precision === 0) {
    console.warn("[SincUpscale] highp precision not supported in fragment shader. Quality may be reduced.");
  }

  // --- Create source texture from image (always RGBA/UNSIGNED_BYTE for HTMLImageElement) ---
  const srcTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  if (isWebGL2) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8 || gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  // --- For WebGL2: render to RGBA16F float framebuffer for max quality ---
  let fbo = null, renderTex = null;
  if (isWebGL2) {
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

    // Check framebuffer completeness
    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn("[SincUpscale] WebGL2 framebuffer incomplete, falling back to canvas.", fbStatus);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      fbo = null;
      renderTex = null;
    }
  }

  // --- Which workflow: linear (for downsampling), sigmoidal (for upsampling) ---
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

  // Fragment shader: Sinc/Lanczos, linear/sigmoidal workflow, WebGL2 vs WebGL1
  const fragSource = isWebGL2 ? `#version 300 es
    precision highp float;
    in vec2 vTex;
    uniform sampler2D uTex;
    uniform vec2 uSrcSize, uDstSize;
    uniform bool uDown;
    out vec4 fragColor;
    vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
    vec3 toSRGB(vec3 c) { return pow(c, vec3(1.0/2.2)); }
    vec3 toSigmoid(vec3 c) { return 1.0 / (1.0 + exp(-6.0 * (c - 0.5))); }
    vec3 fromSigmoid(vec3 c) { return -log((1.0/c)-1.0)/6.0 + 0.5; }
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
          vec4 sample = texture(uTex, sampleCoord);
          // Linear/sigmoidal workflow
          if (uDown) {
            sample.rgb = toLinear(sample.rgb);
          } else {
            sample.rgb = toSigmoid(sample.rgb);
          }
          float weight = lanczos(float(dx), r) * lanczos(float(dy), r);
          color += sample * weight;
          total += weight;
        }
      }
      color /= total;
      if (uDown) {
        color.rgb = toSRGB(color.rgb);
      } else {
        color.rgb = fromSigmoid(color.rgb);
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
    vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
    vec3 toSRGB(vec3 c) { return pow(c, vec3(1.0/2.2)); }
    vec3 toSigmoid(vec3 c) { return 1.0 / (1.0 + exp(-6.0 * (c - 0.5))); }
    vec3 fromSigmoid(vec3 c) { return -log((1.0/c)-1.0)/6.0 + 0.5; }
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
          vec4 sample = texture2D(uTex, sampleCoord);
          if (uDown) {
            sample.rgb = toLinear(sample.rgb);
          } else {
            sample.rgb = toSigmoid(sample.rgb);
          }
          float weight = lanczos(float(dx), r) * lanczos(float(dy), r);
          color += sample * weight;
          total += weight;
        }
      }
      color /= total;
      if (uDown) {
        color.rgb = toSRGB(color.rgb);
      } else {
        color.rgb = fromSigmoid(color.rgb);
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
      console.log('[SincUpscale] Fallback failed or not applicable for image:', img.src);
    }
    return;
  }

  // --- Set up quad ---
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

  // --- Draw quad ---
  gl.viewport(0, 0, width, height);
  if (isWebGL2 && fbo) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Blit result to canvas for display
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blitFramebuffer(
      0, 0, width, height,
      0, 0, width, height,
      gl.COLOR_BUFFER_BIT, gl.NEAREST
    );
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  } else {
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Log on success
  const scaleType = (scaleX > 1 && scaleY > 1) ? 'upscaling' :
                    (scaleX < 1 && scaleY < 1) ? 'downscaling' : 'non-uniform scaling';
  const backend = isWebGL2 ? "WebGL2" : "WebGL1";
  console.log(`[SincUpscale] Successfully resampled (${scaleType}) image with sinc: ${img.src} [${backend}]`, {scaleX, scaleY, width, height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight});
}

// --- Process all <img> elements, throttle observer for performance ---
let processTimeout = null;
function scheduleProcessImages() {
  if (!processTimeout) {
    processTimeout = setTimeout(() => {
      processTimeout = null;
      processImages();
    }, 100); // Run at most every 100ms
  }
}

function processImages() {
  for (const img of document.querySelectorAll('img')) {
    if (img.dataset.sincUpscaled === "true") continue;
    if (isSVG(img)) {
      img.dataset.sincUpscaled = "svg";
      continue;
    }
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener('load', scheduleProcessImages, {once: true});
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

const mo = new MutationObserver(scheduleProcessImages);
mo.observe(document.body, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', scheduleProcessImages);
window.addEventListener('load', scheduleProcessImages);
scheduleProcessImages();