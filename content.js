// ...inside replaceWithSincCanvas...

// Use WebGL2 if available, fallback to WebGL1
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
const isWebGL2 = !!canvas.getContext('webgl2');

// Check for highp support (optional, for debug)
const highp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
if (highp.precision === 0) {
  console.warn("[SincUpscale] highp precision not supported in fragment shader. Quality may be reduced.");
}

// Enable extensions if needed
const floatExt = gl.getExtension('OES_texture_float');
const halfFloatExt = gl.getExtension('OES_texture_half_float');
const sRGBExt = gl.getExtension('EXT_sRGB');

// ...your shader compile/link/setup code...

// Upload texture as before (HTMLImageElement has to use UNSIGNED_BYTE)
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

// If you detect sRGB framebuffer support, you could render to sRGB framebuffer for better color, e.g. in WebGL2:
if (isWebGL2) {
  // WebGL2: use gl.SRGB8_ALPHA8 as internal format (if you want to render to an sRGB framebuffer)
  // NOTE: For your code, this is only useful if your display and browser support sRGB output
  // gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
}

// ...rest of your code...