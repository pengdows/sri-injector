import type { Plugin } from 'vite' with { 'resolution-mode': 'import' };
import type { SriOptions } from '../types';

/** Vite plugin: the Rollup plugin plus Vite's `base`/`publicDir` and the preview-server header. */
declare function sriVitePlugin(options?: SriOptions): Plugin;

export = sriVitePlugin;
