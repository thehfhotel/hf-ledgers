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
  // Split dynamic imports into their own lazy chunks: jspdf + html2canvas are
  // export-time-only and together dwarf the app itself. Without this they get
  // INLINED and the kiosk parses ~1.6MB of JS per load for buttons it may
  // never press; with it the main chunk halves and the export libs load on
  // first use of PDF/JPEG/print.
  splitting: true,
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

// Precompress every text asset (gzip -9 equivalent) so the server can serve
// content-encoding: gzip without compressing per-request. ~1.6MB JS -> ~400KB
// on the wire; the .gz sits beside the original and the server picks it when
// the client accepts it.
{
  const zlib = await import("node:zlib");
  for (const f of readdirSync(outdir)) {
    if (/\.(js|css|html|map)$/.test(f)) {
      const raw = readFileSync(join(outdir, f));
      writeFileSync(join(outdir, f + ".gz"), zlib.gzipSync(raw, { level: 9 }));
    }
  }
}

console.log(`[build] artifacts in ${outdir}`);
for (const f of readdirSync(outdir)) console.log("  -", f);
