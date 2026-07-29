import {
  rmSync,
  existsSync,
  renameSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const outdir = "dist/client";

rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/client/index.html"],
  outdir,
  target: "browser",
  minify: true,
  sourcemap: "linked",
  plugins: [tailwind],
  publicPath: "/",
  naming: {
    entry: "[name]-[hash].[ext]",
    asset: "[name]-[hash].[ext]",
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  console.error("[build] failed");
  process.exit(1);
}

// Bun emits index-<hash>.html — rename to index.html for the server fallback.
for (const f of readdirSync(outdir)) {
  if (/^index-[a-z0-9]+\.html$/i.test(f)) {
    renameSync(join(outdir, f), join(outdir, "index.html"));
    break;
  }
}

// Bun's HTML bundler emits relative asset URLs (./chunk-xxx.js) regardless
// of publicPath. When the user lands on a nested SPA route like
// /hf/day/2026-07-29, the browser resolves "./chunk-xxx.js" to
// "/hf/day/chunk-xxx.js" — which 404s and produces a blank page. Rewrite
// ./ → / so the asset URLs are absolute from the document root.
{
  const indexPath = join(outdir, "index.html");
  if (existsSync(indexPath)) {
    let html = readFileSync(indexPath, "utf8");
    html = html
      .replace(/(href|src)="\.\/(?!\/)/g, '$1="/')
      .replace(/(href|src)='\.\/(?!\/)/g, "$1='/");
    writeFileSync(indexPath, html);
  }
}

console.log(`[build] artifacts in ${outdir}`);
for (const f of readdirSync(outdir)) console.log("  -", f);
