import { mkdtemp, rm, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const FIXTURES_VAULT = join(__dirname, "fixtures", "vault");

export async function createTempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-test-"));
  await cp(FIXTURES_VAULT, dir, { recursive: true });
  return dir;
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
