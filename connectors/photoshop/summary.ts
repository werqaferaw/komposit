// Photoshop's selection in plain words. Ported from 1.0's summarizeSelection.

export function summarizeSelection(d: any): string {
  if (!d || d.noDocument) return "No document open in Photoshop.";
  const head = `Document "${d.doc}" (${Math.round(d.width)}×${Math.round(d.height)}px).`;
  const lines = (d.layers || []).map((l: any) => {
    const kind =
      ({ TEXT: "text layer", SMARTOBJECT: "smart object", NORMAL: "pixel layer", SOLIDFILL: "fill layer" } as Record<string, string>)[l.kind] ||
      (l.type === "group" ? "group" : (l.kind || "layer").toLowerCase().replace(/_/g, " ") + " layer");
    const bits = [`${kind} "${l.name}"`];
    if (l.text) bits.push(`text "${l.text.replace(/\s+/g, " ").slice(0, 60)}" ${l.font || ""} ${l.size || ""}px`.trim());
    if (l.children != null) bits.push(`${l.children} layers inside`);
    if (l.background) bits.push("the locked Background layer");
    else if (l.locked) bits.push("locked");
    if (!l.visible) bits.push("hidden");
    if (l.inGroup) bits.push(`in group "${l.inGroup}"`);
    if (l.clipped) bits.push("clipped to the layer below");
    if (l.mask) bits.push("has a layer mask");
    if (l.opacity != null && l.opacity !== 100) bits.push(`${l.opacity}% opacity`);
    if (l.bounds && l.bounds.every((v: number) => v === 0) && l.type !== "group") bits.push("empty (no pixels yet)");
    else if (l.bounds) bits.push(`bounds [${l.bounds.join(", ")}]px`);
    return `- ${bits.join(", ")}. ref: ${l.ref}`;
  });
  const sel = d.count ? `${d.count} layer${d.count === 1 ? "" : "s"} selected:\n${lines.join("\n")}` : "No layer selected.";
  const marquee = d.marquee
    ? `\nAn active marquee selection covers [${d.marquee.join(", ")}]px: pixel edits and fills should stay inside it unless asked otherwise.`
    : "";
  const qm = d.quickMask ? "\nQuick Mask mode is on." : "";
  return `${head} ${sel}${marquee}${qm}`;
}
