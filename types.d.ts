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
  integrityPolicy?: IntegrityPolicyOption;
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
  | 'NO_HTML'
  | 'UNSUPPORTED_ENCODING';

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: DiagnosticCode;
  message: string;
  /** The page it came from (relative to the output root). */
  file?: string;
  url?: string;
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
  pages: { name: string; html: string; modified: boolean }[];
  diagnostics: Diagnostic[];
}

export interface DirectoryResult {
  files: number;
  diagnostics: Diagnostic[];
  errors: string[];
  warnings: string[];
  integrityPolicy: IntegrityPolicyHeader | undefined;
}

export interface InjectorResult {
  files: number;
  errors: string[];
  warnings: string[];
  integrityPolicy: IntegrityPolicyHeader | undefined;
}
