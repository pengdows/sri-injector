import type {
  AssetResolver, CheckPageResult,
  Diagnostic, DiagnosticCode, InjectOptions, InjectResult, Page, PipelineResult, PipelineRuntime,
  ResolvedOptions, SriOptions, HashAlgorithm, CrossOrigin, IntegrityPolicyHeader, IntegrityPolicyOption
} from './types';

export * from './types';

export function injectSri(html: string, resolveAsset: AssetResolver, options?: InjectOptions): Promise<InjectResult>;
export function processPages(pages: Page[], config: ResolvedOptions, runtime?: PipelineRuntime): Promise<PipelineResult>;
/** Validates the integrity metadata already in one page, without changing it (what --check runs per page). */
export function checkPage(html: string, resolveAsset: AssetResolver, options?: { base?: string; resolveExternal?: AssetResolver; policy?: ResolvedOptions['policy'] }): Promise<CheckPageResult>;
export function resolveOptions(options?: SriOptions): ResolvedOptions;

export const CODES: { readonly [K in DiagnosticCode]: K };
export function error(code: DiagnosticCode, message: string, extra?: Partial<Diagnostic>): Diagnostic;
export function warning(code: DiagnosticCode, message: string, extra?: Partial<Diagnostic>): Diagnostic;
export function noHtmlDiagnostic(where: string): Diagnostic;
export function classify(diagnostics: Diagnostic[], options?: { strict?: boolean }): { fatal: Diagnostic[]; warnings: Diagnostic[] };
export function formatDiagnostic(diagnostic: Pick<Diagnostic, 'message' | 'file'>): string;
export function formatFatal(fatal: Diagnostic[]): string;
export function integrityReplacedMessage(url: string, existing: string, options?: { preview?: boolean }): string;

export class SkipResource extends Error {
  constructor(reason: string);
}

export function validateAlgorithm(name: string): HashAlgorithm;
export function validateCrossorigin(value?: string): CrossOrigin;
export function calculateBase64Hash(content: string | Uint8Array, algorithm: HashAlgorithm): string;
export function parseIntegrity(value: string | undefined): { algorithm: HashAlgorithm; digest: string }[] | null;
export function verifyIntegrity(value: string | undefined, content: string | Uint8Array): boolean;

export function isExternal(url: string): boolean;
export function isLocalUrl(url: string, base?: string): boolean;
export function toFilePath(url: string): string;
export function normalizeBase(base?: string): string;
export function relativeToBase(url: string, base?: string): string | null;
export function isInsideDir(root: string, target: string): boolean;
export function outputPathFor(url: string, prefix: string, htmlDir: string): string | null;

export function buildIntegrityPolicyHeader(options?: { reportOnly?: boolean; endpoints?: string[] }): IntegrityPolicyHeader;
export function normalizeIntegrityPolicy(option: IntegrityPolicyOption | undefined): ResolvedOptions['policy'];
export function mergeHeadersFile(existing: string | null | undefined, header: IntegrityPolicyHeader): string;
