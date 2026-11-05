import type { Compiler, WebpackPluginInstance } from 'webpack';
import type { SriOptions } from '../types';

/** `publicDir` and `importMap` do not apply to webpack. */
type SriWebpackOptions = Omit<SriOptions, 'publicDir' | 'importMap'>;

/** webpack plugin: adds integrity to the HTML assets in the compilation (e.g. from html-webpack-plugin). */
declare class SriWebpackPlugin implements WebpackPluginInstance {
  constructor(options?: SriWebpackOptions);
  apply(compiler: Compiler): void;
}

export = SriWebpackPlugin;
