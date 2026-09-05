/** Shells out to the `wrangler` CLI. Used by `db/d1-wrangler.ts` and `images/r2-wrangler.ts`. */

import { execFile } from "node:child_process";

export interface WranglerResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Runs one wrangler invocation. Swappable in tests for a fake that returns canned output. */
export type WranglerRun = (args: readonly string[]) => Promise<WranglerResult>;

export const runWrangler: WranglerRun = (args) =>
  new Promise((resolve) => {
    execFile("npx", ["wrangler", ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ stdout, stderr, code });
    });
  });
