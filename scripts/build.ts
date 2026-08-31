import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const directory = path.resolve(process.argv[2] ?? ".");
const outdir = path.join(directory, "dist");
const entrypoints = [path.join(directory, "src/index.ts"), path.join(directory, "src/tui.tsx")];
const rpc = path.join(directory, "src/rpc.ts");
if (existsSync(rpc)) entrypoints.push(rpc);

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
