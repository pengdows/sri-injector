/** Shared types for every entry point. */

export type HashAlgorithm = 'sha256' | 'sha384' | 'sha512';
export type CrossOrigin = 'anonymous' | 'use-credentials';

/** `true` / `'enforce'` send Integrity-Policy; `'report-only'` sends Integrity-Policy-Report-Only. */
export type IntegrityPolicyOption =
  | boolean
  | 'enforce'
  | 'report-only'
  | {
      reportOnly?: boolean;
      /** Reporting API endpoint names (declared separately with Reporting-Endpoints). */
      endpoints?: string[];
      /** A Netlify / Cloudflare Pages `_headers` file, relative to the output directory. */
      headersFile?: string;
    };

export interface SriOptions {
  /** Set to false to turn the tool off. Default true. */
  enabled?: boolean;
  /** Also fail when no HTML was found. Unresolvable local resources always fail. */
  strict?: boolean;
  /** Default 'sha384'. */
  algorithm?: HashAlgorithm;
  /** Written to tags that have no crossorigin attribute. Default 'anonymous'. */
  crossorigin?: CrossOrigin;
  /** Public base path or URL the HTML was built for. A full URL marks assets under it as local. */
  base?: string;
  /** Extra directory checked for files that are not in the bundle. */
  publicDir?: string;
  /** Also fetch and pin third-party resources at build time. */
  external?: boolean;
  /** Per-request timeout in ms for `external`. Default 10000. */
  externalTimeout?: number;
  /** Add an import map `integrity` section for code-split chunks (Rollup/Vite). Default true. */
  importMap?: boolean;
  /** Add an `integrity` field to each entry of a Vite build manifest (Rollup/Vite). Default true. */
  manifest?: boolean;
  integrityPolicy?: IntegrityPolicyOption;
}

/** Options of processDirectory / insertSRIInHTML (the filesystem host). The plugins do not take `dryRun`. */
export interface DirectoryOptions extends SriOptions {
  /** Read, hash and report as usual, but write nothing; `changes` then lists what a real run would do. */
  dryRun?: boolean;
  /** Write a JSON file (path relative to outputDir) with the integrity of every file in the output except HTML and source maps. */
  manifestFile?: string;
}

export type ChangeKind =
  | 'add-integrity'
  | 'replace-integrity'
  | 'add-crossorigin'
  | 'update-import-map'
  | 'update-headers-file'
  | 'update-manifest-file';

/** One edit made to (or, in a dry run, that would be made to) a page or the headers file. */
export interface Change {
  kind: ChangeKind;
  /** The page (or headers file), relative to the output root. Absent in injectSri's own result. */
  file?: string;
  /** The resource URL, as resolved against the page's <base href>. Absent for whole-page edits. */
  url?: string;
}

export interface IntegrityPolicyHeader {
  name: 'Integrity-Policy' | 'Integrity-Policy-Report-Only';
  value: string;
}

export type DiagnosticCode =
  | 'RESOURCE_NOT_FOUND'
  | 'RESOURCE_FAILED'
  | 'RESOURCE_SKIPPED'
  | 'INTEGRITY_REPLACED'
  | 'IMPORT_MAP_INVALID'
  | 'UNPROTECTED_SCRIPT'
  | 'UNPROTECTED_CHUNK'
  | 'DYNAMIC_IMPORT'
  | 'LAZY_STYLESHEET'
  | 'NO_HTML'
  | 'UNSUPPORTED_ENCODING';

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: DiagnosticCode;
  message: string;
  /** The page it came from (relative to the output root). */
  file?: string;
  url?: string;
  /** INTEGRITY_REPLACED: the value that was (or, in a dry run, would be) replaced. */
  existing?: string;
}

/** What a resolver returns for a URL: the exact bytes served, or null if there is no such file. */
export type AssetBytes = string | Uint8Array;
export type AssetResolver = (url: string) => AssetBytes | null | undefined | Promise<AssetBytes | null | undefined>;

export interface ResolvedOptions {
  readonly enabled: boolean;
  readonly strict: boolean;
  readonly algorithm: HashAlgorithm;
  readonly crossorigin: CrossOrigin;
  readonly base: string | undefined;
  readonly publicDir: string | undefined;
  readonly external: boolean;
  readonly externalTimeout: number;
  readonly importMap: boolean;
  readonly manifest: boolean;
  readonly policy: { reportOnly: boolean; endpoints: string[]; headersFile: string | undefined } | null;
  readonly policyHeader: IntegrityPolicyHeader | null;
}

export interface InjectOptions {
  algorithm?: HashAlgorithm;
  crossorigin?: CrossOrigin;
  base?: string;
  resolveExternal?: AssetResolver;
  /** Receives the page's local script/modulepreload URLs; returns `{ url: integrity }` for reachable chunks. */
  importMapIntegrity?: (scriptUrls: string[]) => Record<string, string> | null | undefined | Promise<Record<string, string> | null | undefined>;
}

export interface InjectResult {
  html: string;
  modified: boolean;
  /** The SRI edits made (what a dry run reports). Removing a data-skip-sri marker is not listed. */
  changes: Change[];
  diagnostics: Diagnostic[];
  errors: string[];
  warnings: string[];
  /** The src of every <script> that still has no integrity. */
  unprotectedScripts: string[];
}

export interface Page {
  name: string;
  html: string;
  resolveAsset: AssetResolver;
  importMapIntegrity?: InjectOptions['importMapIntegrity'];
}

export interface PipelineRuntime {
  base?: string;
  resolveExternal?: AssetResolver;
  headersFile?: {
    read: () => Promise<string | null | undefined>;
    write: (content: string) => Promise<void>;
  };
  /** Problems only the host can see; an error among them keeps the headers file from being written. */
  extraDiagnostics?: Diagnostic[];
}

export interface PipelineResult {
  pages: { name: string; html: string; modified: boolean; changes: Change[] }[];
  diagnostics: Diagnostic[];
}

export interface DirectoryResult {
  files: number;
  dryRun: boolean;
  /** What was written, or in a dry run what would be; empty when the output is already up to date. */
  changes: Change[];
  diagnostics: Diagnostic[];
  errors: string[];
  warnings: string[];
  integrityPolicy: IntegrityPolicyHeader | undefined;
}

/**
 * A --check result:
 * - `missing`: no integrity (or an empty one); `wrong`: malformed or does not match the bytes;
 * - `not-found`: the resource could not be obtained; `blocked`: with an Integrity-Policy, a script the
 *   header would block. These four fail the check.
 * - `ok`: every token matches; `skipped`: the tag has data-skip-sri; `unchecked`: third-party, not verified.
 */
export type CheckStatus = 'missing' | 'wrong' | 'not-found' | 'blocked' | 'ok' | 'skipped' | 'unchecked';

export interface CheckResult {
  /** A tag, or an entry of the page's import map `integrity` section. */
  target: 'tag' | 'import-map';
  /** As resolved against the page's <base href>. */
  url: string;
  status: CheckStatus;
  /** Whether a non-empty integrity value was there (the "was the tool run?" signal). */
  hasIntegrity: boolean;
  message?: string;
}

export interface CheckPageResult {
  results: CheckResult[];
  /** Page-level failures, e.g. an import map that is not valid JSON. */
  problems: string[];
}

export interface CheckDirectoryResult {
  files: number;
  passed: boolean;
  /** False when no examined tag or import map entry anywhere carries integrity. */
  integrityFound: boolean;
  results: (CheckResult & { file: string })[];
  counts: Record<CheckStatus, number>;
  /** Unreadable pages, invalid import maps, no HTML. */
  diagnostics: Diagnostic[];
}

export interface InjectorResult {
  files: number;
  changes: Change[];
  errors: string[];
  warnings: string[];
  integrityPolicy: IntegrityPolicyHeader | undefined;
}
