/// <reference types="vite/client" />

// TS 6 raised side-effect imports of asset modules from a warning to an
// error. Vite handles CSS at bundle time; declare the module so tsc
// doesn't complain about `import './styles.css'`.
declare module '*.css';
