// Compiled by __tests__/types.test.js under `strict`. Lines marked @ts-expect-error must NOT compile:
// if the types become too loose, the directive itself becomes an error and the build fails.
import SubresourceIntegrityInjector, { injectSri, processPages, resolveOptions, processDirectory } from '@pengdows/sri-injector';
import sriRollup from '@pengdows/sri-injector/rollup';
import sriVite from '@pengdows/sri-injector/vite';
import SriWebpackPlugin from '@pengdows/sri-injector/webpack';
import { classify, formatFatal, CODES } from '@pengdows/sri-injector/core';
import type { RollupOptions } from 'rollup';
import type { UserConfig } from 'vite' with { 'resolution-mode': 'import' };
import type { Configuration } from 'webpack';

// ---- the plugins drop into each bundler's own config types
const rollupConfig: RollupOptions = { plugins: [sriRollup({ algorithm: 'sha512', strict: true, base: '/app/' })] };
const viteConfig: UserConfig = { plugins: [sriVite({ integrityPolicy: { reportOnly: true, endpoints: ['sri'], headersFile: '_headers' }, external: true, externalTimeout: 5000 })] };
const webpackConfig: Configuration = { plugins: [new SriWebpackPlugin({ crossorigin: 'use-credentials', enabled: false })] };
void [rollupConfig, viteConfig, webpackConfig];

// ---- options are checked
// @ts-expect-error unsupported algorithm
sriRollup({ algorithm: 'md5' });
// @ts-expect-error typo in an option name
sriVite({ strcit: true });
// @ts-expect-error crossorigin is 'anonymous' | 'use-credentials'
new SriWebpackPlugin({ crossorigin: 'yes' });
// @ts-expect-error timeout is a number
sriRollup({ externalTimeout: '10s' });

// ---- the core API
async function api() {
  const r = await injectSri('<script src="/a.js"></script>', (url) => (url === '/a.js' ? 'x' : null), { algorithm: 'sha256', crossorigin: 'anonymous' });
  const html: string = r.html;
  const modified: boolean = r.modified;
  const unprotected: string[] = r.unprotectedScripts;
  const first = r.diagnostics[0];
  const sev: 'error' | 'warning' | undefined = first?.severity;
  void [html, modified, unprotected, sev];

  const config = resolveOptions({ algorithm: 'sha384', integrityPolicy: 'report-only' });
  const header: string | undefined = config.policyHeader?.name;
  const pages = await processPages([{ name: 'index.html', html: '<p>x</p>', resolveAsset: () => null }], config);
  const { fatal, warnings } = classify(pages.diagnostics, { strict: true });
  const text: string = formatFatal(fatal);
  const code: string = CODES.NO_HTML;
  void [header, warnings, text, code];

  const injector = new SubresourceIntegrityInjector();
  const run = await injector.insertSRIInHTML('./dist', 'sha384', { strict: true, base: '/', crossorigin: 'anonymous' });
  const files: number = run.files;
  const errors: string[] = run.errors;
  void [files, errors];

  const dir = await processDirectory('./dist', { external: false });
  void dir.diagnostics;

  // @ts-expect-error resolveAsset must return bytes, null or a promise of them
  await injectSri('', () => 42);
}
void api;
