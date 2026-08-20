// Thin ESM shim over the vendored d3 UMD bundle (./d3.js). The UMD wrapper
// detects the absence of CommonJS/AMD and falls back to assigning
// `globalThis.d3`, which works fine when loaded as a module too (it uses no
// import/export syntax itself). This lets app code do
// `import d3 from '/vendor/d3.mjs'` instead of relying on a global.
import './d3.js';

export default globalThis.d3;
