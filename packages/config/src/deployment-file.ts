/**
 * Reads contracts/deployments/<chainId>.json (written by contracts/script/Deploy.s.sol and committed after a
 * deployment, so every release carries it). Node only: import it as '@velum/config/src/deployment-file'.
 *
 * The on-chain workers run only when this file exists for the configured chain (and ONCHAIN_WORKERS=true);
 * the API's Phase 3 routes answer 404 without it.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseDeployment, type Deployment } from './onchain';

/** Larger files are refused (a deployment file is well under 2 KB). */
export const MAX_DEPLOYMENT_FILE_BYTES = 64 * 1024;

/**
 * Default directory of the deployment files: contracts/deployments of the tree the app runs from. api and
 * workers run with cwd apps/<name> (deploy/ecosystem.config.cjs, `pnpm dev`), so it is ../../contracts/deployments.
 */
export const defaultDeploymentsDir = (cwd: string = process.cwd()): string => path.resolve(cwd, '../../contracts/deployments');

export type DeploymentRead =
  | { status: 'ok'; deployment: Deployment; path: string; mtimeMs: number }
  | { status: 'missing'; path: string }
  | { status: 'invalid'; path: string; error: string };

/** The deployment file for `chainId` in `dir`, validated (parseDeployment). Never throws. */
export function readDeploymentFile(dir: string, chainId: number): DeploymentRead {
  const file = path.join(dir, `${chainId}.json`);
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return { status: 'invalid', path: file, error: 'not a regular file' };
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return { status: 'missing', path: file };
  }
  if (size > MAX_DEPLOYMENT_FILE_BYTES) return { status: 'invalid', path: file, error: 'file too large' };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { status: 'invalid', path: file, error: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const parsed = parseDeployment(json, chainId);
  return parsed.ok ? { status: 'ok', deployment: parsed.deployment, path: file, mtimeMs } : { status: 'invalid', path: file, error: parsed.error };
}
