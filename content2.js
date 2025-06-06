// --- Sinc/Lanczos Resampling Extension with robust Nearest Neighbor Integer Fallback ---
// WebGL2 when available, sRGB-safe, no double-flip, and no unneeded gamma correction.

const propertyName  = 'image-rendering';
const autoValue     = 'auto';
const propertyValue = 'pixelated';
const cachedDataURLs = {};

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

function isYouTubeThumbnail(img) {
  const src = img.currentSrc || img.src || '';
  return (
    /\/\/i\.ytimg\.com\/vi\//.test(src) ||
    /\/\/yt3\.ggpht\.com\//.test(src)
  );
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
  for (const attr of from.attributes) {
    if (attr.name.startsWith('data-')) {
      to.setAttribute(attr.name, attr.value);
    }
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
// --- YouTube-optimized image readiness check ---
function isImageReady(img) {
  if (!img.complete || !img.naturalWidth || !img.naturalHeight) return false;
  if (img.naturalWidth <= 8 || img.naturalHeight <= 8) return false;
  const style = window.getComputedStyle(img);
  const displayedW = parseFloat(style.width), displayedH = parseFloat(style.height);
  if (
    displayedW > img.naturalWidth * 1.5 ||
    displayedH > img.naturalHeight * 1.5
  ) return false;
  return true;
}

// --- Fetch as blob/dataURL fallback (for CORS) ---
async function fetchAndCacheToDataURL(img) {
  const url = img.src;
  if (cachedDataURLs[url]) {
    img.src = cachedDataURLs[url];
    return true;
  }
  try {
    const resp = await fetch(url, {mode: "cors"});
    if (!resp.ok) throw new Error("Image fetch failed " + resp.status);
    const blob = await resp.blob();
    const reader = new FileReader();
    reader.onloadend = () => {
      cachedDataURLs[url] = reader.result;
      img.src = reader.result;
    };
    reader.readAsDataURL(blob);
    return true;
  } catch (e) {
    console.warn('Failed to fetch/cors image', url, e);
    return false;
  }
}

// --- Sinc/Lanczos resampling and fallback logic ---
async function replaceWithSincCanvas(img, scaleX, scaleY, width, height, style = null) {
  if (isSVG(img)) return;
  if (!img.complete || !img.naturalWidth) {
    img.addEventListener('load', () => replaceWithSincCanvas(img, scaleX, scaleY, width, height, style), { once: true });
    return;
  }

  // If not CORS safe, do NOT hide the image until we know we can replace it!
  if (!isCORSsafe(img)) {
    // Try fetch/dataURL workaround before fallback
    const fetched = await fetchAndCacheToDataURL(img);
    if (fetched) {
      // After reload, we will retry upscaling (onload event).
      img.addEventListener('load', () => replaceWithSincCanvas(img, scaleX, scaleY, width, height, style), { once: true });
    } else {
      // CORS and fetch both failed: fallback to browser default (do nothing, just leave image as-is)
      img.style.display = ""; // make sure it's visible
      // Do not set sincUpscaled, so future loads may retry if the src changes
    }
    return;
  }

  // Create and size the canvas
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    style = style || window.getComputedStyle(img);

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
        throw "[SincUpscale] WebGL not supported.";
      }
    }

    const srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

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
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        fbo = null;
        renderTex = null;
      } else {
        useFloatFbo = true;
      }
    }

    const isDownsample = (scaleX < 1 && scaleY < 1);

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
      throw "[SincUpscale] Shader compile/link failed.";
    }

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

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);

    gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
    gl.uniform2f(gl.getUniformLocation(prog, "uSrcSize"), img.naturalWidth, img.naturalHeight);
    gl.uniform2f(gl.getUniformLocation(prog, "uDstSize"), width, height);
    if (gl.getUniformLocation(prog, "uDown")) {
      gl.uniform1i(gl.getUniformLocation(prog, "uDown"), isDownsample ? 1 : 0);
    }

    if (isWebGL2 && useFloatFbo) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

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
        throw "[SincUpscale] Passthrough shader compile/link failed.";
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

    // Only mark upscaled after success
    img.dataset.sincUpscaled = "true";
    const scaleType = (scaleX > 1 && scaleY > 1) ? 'upscaling' :
                      (scaleX < 1 && scaleY < 1) ? 'downscaling' : 'non-uniform scaling';
    const backend = isWebGL2 ? (useFloatFbo ? "WebGL2+floatFBO" : "WebGL2") : "WebGL1";
    console.log(`[SincUpscale] Successfully resampled (${scaleType}) image with sinc: ${img.src} [${backend}]`, {scaleX, scaleY, width, height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight});
  } catch (e) {
    // On any error, show original image
    img.style.display = "";
  }
}

// --- Process all <img> elements, process immediately, not throttled ---
async function processImages() {
  for (const img of document.querySelectorAll('img')) {
    if (
      img.dataset.sincUpscaled === "true" ||
      img.closest('zoomable-img') ||
      img.closest('.modal') ||
      img.closest('.overlay')
    ) continue;
    if (isSVG(img)) {
      img.dataset.sincUpscaled = "svg";
      continue;
    }
    // YouTube: Only process visible (non-placeholder) thumbnails
    if (isYouTubeThumbnail(img) && (img.width < 30 || img.height < 30)) {
      img.dataset.sincUpscaled = "skip";
      continue;
    }
    // Set crossOrigin to anonymous if needed
    if (
      !img.src.startsWith("data:") &&
      !img.src.startsWith("blob:") &&
      !img.src.startsWith(window.location.origin) &&
      img.crossOrigin !== "anonymous"
    ) {
      img.crossOrigin = "anonymous";
      if (img.complete && img.naturalWidth) {
        const src = img.src;
        img.src = "";
        img.src = src;
        continue;
      }
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
    // --- Fallback for CORS images ---
    if (!isCORSsafe(img)) {
      const fetched = await fetchAndCacheToDataURL(img);
      if (fetched) {
        img.addEventListener('load', processImages, {once: true});
        continue;
      }
      // If not fetched, just leave the browser to render as usual (no upscaling, no display hiding, no "true" flag)
      img.style.display = "";
      continue;
    }
    // If we reach here, CORS is OK, try upscaling
    await replaceWithSincCanvas(img, scaleX, scaleY, width, height, style);
  }
}

const mo = new MutationObserver(processImages);
mo.observe(document.body, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', processImages);
window.addEventListener('load', processImages);
processImages();