/**
 * Writes ai/spec/spec.v1.json from spec.ts (the file Python reads).
 *
 *   npx tsx ai/spec/gen-spec.ts          # (re)generate
 *   npx tsx ai/spec/gen-spec.ts --check  # fail if the committed file is stale
 */
import fs from "fs";
import path from "path";
import * as prettier from "prettier";
import { fileURLToPath } from "url";
import { specHash, specJson } from "./spec";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SPEC_JSON_PATH = path.join(here, "spec.v1.json");

export async function renderSpecJson(): Promise<string> {
  const body = { ...specJson(), spec_hash: specHash() };
  return prettier.format(JSON.stringify(body), { parser: "json" });
}

async function main() {
  const text = await renderSpecJson();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(SPEC_JSON_PATH)
      ? fs.readFileSync(SPEC_JSON_PATH, "utf8")
      : "";
    if (current !== text) {
      console.error(
        `${SPEC_JSON_PATH} is stale; run: npx tsx ai/spec/gen-spec.ts`,
      );
      process.exit(1);
    }
    console.log(`spec.v1.json up to date (specHash ${specHash()})`);
    return;
  }
  fs.writeFileSync(SPEC_JSON_PATH, text);
  console.log(`wrote ${SPEC_JSON_PATH} (specHash ${specHash()})`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
