import type { DirectoryOptions, SriOptions, HashAlgorithm, InjectorResult, DirectoryResult, CheckDirectoryResult } from './types';
import { injectSri, processPages, resolveOptions } from './core';

declare class SubresourceIntegrityInjector {
  /**
   * Scans outputDir (recursively) and injects SRI attributes into every HTML file. Resolves with the
   * problems found; the caller decides what is fatal. With `strict` it rejects on errors or when no
   * HTML files exist. With `dryRun` nothing is written and `changes` lists what a real run would do.
   */
  insertSRIInHTML(outputDir: string, algorithm?: HashAlgorithm, options?: DirectoryOptions): Promise<InjectorResult>;
}

declare function processDirectory(outputDir: string, options?: DirectoryOptions): Promise<DirectoryResult>;
/** Validates the integrity already in the output (--check). Never writes. */
declare function checkDirectory(outputDir: string, options?: SriOptions): Promise<CheckDirectoryResult>;

declare namespace SubresourceIntegrityInjector {
  export { SubresourceIntegrityInjector, injectSri, processPages, resolveOptions, processDirectory, checkDirectory };
}

export = SubresourceIntegrityInjector;
