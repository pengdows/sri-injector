import type { Plugin } from 'rollup';
import type { SriOptions } from '../types';

/** Rollup plugin: adds integrity to the HTML assets in the output bundle. List it last. */
declare function sriPlugin(options?: SriOptions): Plugin;

export = sriPlugin;
