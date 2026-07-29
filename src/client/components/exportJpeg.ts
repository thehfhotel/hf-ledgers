// Placeholder — WP-C implements the html2canvas-pro capture + delivery flow
// per the plan's "JPEG export" spec: lazy `import("html2canvas-pro")`,
// document.fonts.load all 4 Sarabun weights with a Thai sample string then
// fonts.ready, html2canvas(node, { scale: 2, backgroundColor: "#fff" }) ->
// toBlob("image/jpeg", 0.92). Filename `income-{property}-{date}.jpg`.
// navigator.canShare({ files }) -> share sheet (LINE), AbortError ignored,
// fallback <a download>.

export async function exportJpeg(): Promise<void> {
  throw new Error("not implemented");
}
