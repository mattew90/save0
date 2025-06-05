// --- Minimal Sinc/Lanczos Upscaling Extension ---
// For every <img> on the page, checks if it is upscaled, then replaces it with a canvas using WebGL sinc filter.

function needsUpscaling(img) {
  const style = window.getComputedStyle(img);
  const width = parseInt(style.width, 10) || img.width;
  const height = parseInt(style.height, 10) || img.height;
  return width > img.naturalWidth || height > img.naturalHeight;
}

// Check if an image is safe for WebGL/canvas upscaling
function isCORSsafe(img) {
  // Data URIs, blob URIs, and same-origin images are always safe
  if (
    img.src.startsWith("data:") ||
    img.src.startsWith("blob:") ||
    img.src.startsWith(window.location.origin)
  ) {
    return true;
  }
  // CORS-enabled remote images
  return img.crossOrigin === "anonymous";
}

// A simple utility to load an image as a texture and run a shader for scaling.
async function replaceWithSincCanvas(img, radius = 3) {
  if (!img.complete || !img.naturalWidth) {
    // Wait for the image to load if it's not ready yet
    img.addEventListener('load', () => replaceWithSincCanvas(img, radius), { once: true });
    return;
  }

  // Only process CORS-safe images!
  if (!isCORSsafe(img)) {
    console.warn("[SincUpscale] Skipping image due to CORS:", img.src);
    return;
  }

  const style = window.getComputedStyle(img);
  const width = parseInt(style.width, 10) || img.width;
  const height = parseInt(style.height, 10) || img.height;

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

  // Fragment shader (Lanczos-3 filter, simplified)
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
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); // Required for NPOT textures
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    if (gl.getError() !== gl.NO_ERROR) throw "WebGL error after texImage2D";
  } catch (e) {
    console.warn("[SincUpscale] WebGL texture upload failed, skipping image:", img.src, e);
    canvas.remove();
    img.style.display = "";
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
      // Only log successful replacement inside replaceWithSincCanvas now
      replaceWithSincCanvas(img, 3);
    }
  }
}

// Observe DOM for dynamically added images
const mo = new MutationObserver(processImages);
mo.observe(document.body, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', processImages);
window.addEventListener('load', processImages);
processImages();