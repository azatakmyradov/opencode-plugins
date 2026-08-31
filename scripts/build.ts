import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Glob } from "bun";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const directory = path.resolve(process.argv[2] ?? ".");
const outdir = path.join(directory, "dist");
const entrypoints: string[] = [];
for (const entry of ["src/index.ts", "src/tui.tsx", "src/rpc.ts"]) {
  const candidate = path.join(directory, entry);
  if (existsSync(candidate)) entrypoints.push(candidate);
}

if (entrypoints.length === 0) {
  console.error(`No entrypoints found in ${directory}/src`);
  process.exit(1);
}

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints,
  outdir,
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [createSolidTransformPlugin()],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// CommonJS sidecars (sandbox children and friends) are never bundled: they are
// read or spawned at runtime, so copy them into dist keeping their src layout.
const src = path.join(directory, "src");
for await (const relative of new Glob("**/*.cjs").scan({ cwd: src })) {
  const destination = path.join(outdir, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(src, relative), destination);
}
