export const STATES: readonly string[];
export const MAX_ELEMENTS: number;
export const SETTLE_MS: number;
export interface CaptureArgs { scenario: string; viewport: string; state: string; width: number; height: number }
export interface CapturePage {
  setViewportSize(size: { width: number; height: number }): Promise<unknown>;
  waitForTimeout?(ms: number): Promise<unknown>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  evaluate(fn: () => unknown): Promise<unknown>;
}
export function checkArgs(args: Partial<CaptureArgs> | undefined): string | null;
export function STYLE_PROBE(): unknown[];
export function capture(page: CapturePage, args: CaptureArgs, options: { dir: string }): Promise<{ elements: number }>;
