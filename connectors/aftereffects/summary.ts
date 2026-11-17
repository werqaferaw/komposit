// After Effects' selection in plain words. Ported from 1.0's summarizeSelection.

export function summarizeSelection(d: any): string {
  if (!d || d.noDocument) return "No project open in After Effects.";
  if (d.kind === "project") {
    const items = d.items.length ? d.items.map((i: any) => `${i.type} "${i.name}"`).join(", ") : "nothing";
    return `Project "${d.project}". No comp is active (the timeline isn't focused). Selected in the Project panel: ${items}.`;
  }
  const c = d.comp;
  const head = `Comp "${c.name}" ${c.w}×${c.h}, ${c.duration}s at ${c.fps}fps; playhead at ${c.time}s; work area ${c.workArea[0]}–${c.workArea[1]}s.`;
  const layers = d.layers.length
    ? `${d.layers.length} layer${d.layers.length === 1 ? "" : "s"} selected:\n` +
      d.layers
        .map((l: any) => {
          const bits = [`${l.type} layer "${l.name}" (#${l.index})`, `${l.inPoint}–${l.outPoint}s`];
          if (l.text) bits.push(`text "${l.text.replace(/\s+/g, " ").slice(0, 60)}"`);
          if (l.source) bits.push(`precomp of "${l.source}"`);
          if (l.parent) bits.push(`parented to "${l.parent}"`);
          if (l.threeD) bits.push("3D");
          if (l.locked) bits.push("locked");
          if (l.hidden) bits.push("hidden");
          return `- ${bits.join(", ")}. ref: ${l.ref}`;
        })
        .join("\n")
    : "No layers selected.";
  const props = d.props.length
    ? "\nSelected properties:\n" +
      d.props
        .map((p: any) => {
          const bits = [`"${p.layer}" > ${p.path}`];
          if (p.keys) bits.push(`${p.keys} keyframe${p.keys === 1 ? "" : "s"}${p.selectedKeys ? `, ${p.selectedKeys} selected at ${p.selectedKeyTimes.join("s, ")}s` : ""}`);
          else if (p.value != null) bits.push(`value ${p.value}`);
          if (p.expression) bits.push(`expression: ${p.expression}`);
          return `- ${bits.join(", ")}. ref: ${p.ref}`;
        })
        .join("\n")
    : "";
  return `${head} ${layers}${props}`;
}
