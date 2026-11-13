// Compiled by __tests__/types.test.js under `strict`. Lines marked @ts-expect-error must NOT compile:
// if the types become too loose, the directive itself becomes an error and the build fails.
import SubresourceIntegrityInjector, { injectSri, processPages, resolveOptions, processDirectory, checkDirectory } from '@pengdows/sri-injector';
import sriRollup from '@pengdows/sri-injector/rollup';
import sriVite from '@pengdows/sri-injector/vite';
import SriWebpackPlugin from '@pengdows/sri-injector/webpack';
import { classify, formatFatal, CODES, checkPage } from '@pengdows/sri-injector/core';
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
// @ts-expect-error dryRun belongs to the directory host, not the plugins
sriVite({ dryRun: true });

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

  const dry = await injector.insertSRIInHTML('./dist', 'sha384', { dryRun: true, manifestFile: 'sri-manifest.json' });
  const pending: number = dry.changes.length;
  const kind: 'add-integrity' | 'replace-integrity' | 'add-crossorigin' | 'update-import-map' | 'update-headers-file' | 'update-manifest-file' | undefined = dry.changes[0]?.kind;
  const pageChanges: number = r.changes.length;
  void [pending, kind, pageChanges];

  const dir = await processDirectory('./dist', { external: false, dryRun: true });
  const wasDry: boolean = dir.dryRun;
  void [dir.diagnostics, dir.changes, wasDry];
  // @ts-expect-error dryRun is a boolean
  await processDirectory('./dist', { dryRun: 'yes' });

  const checked = await checkDirectory('./dist', { base: '/', external: true, strict: true });
  const passed: boolean = checked.passed;
  const found: boolean = checked.integrityFound;
  const missingCount: number = checked.counts.missing + checked.counts['not-found'];
  const result = checked.results[0];
  const status: 'ok' | 'missing' | 'wrong' | 'not-found' | 'skipped' | 'unchecked' | 'blocked' | undefined = result?.status;
  const target: 'tag' | 'import-map' | undefined = result?.target;
  const file: string | undefined = result?.file;
  void [passed, found, missingCount, status, target, file, checked.diagnostics];
  const page = await checkPage('<script src="/a.js"></script>', () => 'x', { base: '/' });
  void [page.results, page.problems];
  // @ts-expect-error checkDirectory never writes, so it takes no dryRun option
  await checkDirectory('./dist', { dryRun: true });

  // @ts-expect-error resolveAsset must return bytes, null or a promise of them
  await injectSri('', () => 42);
}
void api;
