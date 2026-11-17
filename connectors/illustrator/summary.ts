// Illustrator's selection in plain words, the compact block the model reads at the top
// of each message. Ported from 1.0's summarizeSelection.

function clip(s: unknown, n: number): string {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function summarizeSelection(d: any): string {
  if (!d || d.noDocument) return "No document open in Illustrator.";
  const head = `Document "${d.doc}", active artboard "${d.activeArtboard}".`;
  if (d.kind === "nothing") return `${head} Nothing is selected.`;
  if (d.kind === "text") {
    const part = d.frameText && d.frameText !== d.text ? ` inside the text frame "${clip(d.frameText, 80)}"` : "";
    return `${head} Editing text: "${clip(d.text, 120)}" is selected (${d.length} characters)${part}, ${d.font || "?"} ${d.size || "?"}pt. Change only this range unless asked otherwise. Frame ref: ${d.frameRef}.`;
  }
  const lines = (d.items || []).map((it: any) => {
    const bits = [it.type + (it.name ? ` "${it.name}"` : "")];
    if (it.text) bits.push(`text "${clip(it.text, 60)}" ${it.font || ""} ${it.size || ""}pt`.trim());
    if (it.children != null) bits.push(`${it.clippingGroup ? "clipping group" : "group"} of ${it.children}`);
    if (it.inGroup) bits.push(`inside group "${it.inGroup}"${it.insideClippingMask ? " (a clipping mask)" : ""}`);
    if (it.isClippingPath) bits.push("this is the clipping path");
    if (it.selectedPoints) bits.push(`only ${it.selectedPoints} points selected (Direct Selection)`);
    if (it.file) bits.push(`image ${it.file}`);
    if (it.symbol) bits.push(`symbol "${it.symbol}"`);
    if (it.fill) bits.push(`fill ${it.fill}`);
    if (it.stroke) bits.push(`stroke ${it.stroke}`);
    bits.push(`${it.w}×${it.h}pt at [${it.bounds.join(", ")}]`);
    bits.push(it.artboard ? `on "${it.artboard}"` : "off the artboards");
    bits.push(`layer "${it.layer}"`);
    return `- ${bits.join(", ")}. ref: ${it.ref}`;
  });
  const more = d.count > lines.length ? `\n- …and ${d.count - lines.length} more.` : "";
  const span = d.artboards && d.artboards.length > 1 ? ` across artboards ${d.artboards.map((a: string) => `"${a}"`).join(", ")}` : "";
  return `${head} ${d.count} item${d.count === 1 ? "" : "s"} selected${span}:\n${lines.join("\n")}${more}`;
}

/** Preflight findings as text the AI and the person can read. */
export function preflightText(d: any): string {
  const w: string[] = Array.isArray(d?.warnings) ? d.warnings : [];
  const i = d?.info || {};
  const boards = (i.artboards || []).map((a: any) => `"${a.name}" ${a.widthMm}×${a.heightMm} mm`).join(", ");
  const facts = [
    i.colorMode ? `colour mode ${i.colorMode}` : "",
    boards ? `artboards ${boards}` : "",
    i.fonts?.length ? `fonts ${i.fonts.join(", ")}` : "",
    i.linkedImages != null ? `${i.linkedImages} linked and ${i.embeddedImages} embedded images` : "",
    i.spotColors?.length ? `spot colours ${i.spotColors.join(", ")}` : "",
  ].filter(Boolean);
  return [
    `Preflight of "${d?.document}":`,
    w.length ? w.map((x) => `- ${x}`).join("\n") : "- Nothing to fix found.",
    facts.length ? `Facts: ${facts.join("; ")}.` : "",
    i.note || "",
  ]
    .filter(Boolean)
    .join("\n");
}
