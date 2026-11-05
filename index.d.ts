import type { SriOptions, HashAlgorithm, InjectorResult, DirectoryResult } from './types';
import { injectSri, processPages, resolveOptions } from './core';

declare class SubresourceIntegrityInjector {
  /**
   * Scans outputDir (recursively) and injects SRI attributes into every HTML file. Resolves with the
   * problems found; the caller decides what is fatal. With `strict` it rejects on errors or when no
   * HTML files exist.
   */
  insertSRIInHTML(outputDir: string, algorithm?: HashAlgorithm, options?: SriOptions): Promise<InjectorResult>;
}

declare function processDirectory(outputDir: string, options?: SriOptions): Promise<DirectoryResult>;

declare namespace SubresourceIntegrityInjector {
  export { SubresourceIntegrityInjector, injectSri, processPages, resolveOptions, processDirectory };
}

export = SubresourceIntegrityInjector;
