// Premiere Pro's selection in plain words. Ported from 1.0's summarizeSelection.

export function summarizeSelection(d: any): string {
  if (!d || d.noDocument) return "No project open in Premiere Pro.";
  const lines: string[] = [];
  if (d.sequence) {
    const s = d.sequence;
    lines.push(`Sequence "${s.name}" (${s.w}×${s.h}, ${s.fps} fps, ${s.duration} s), playhead at ${s.playhead} s${s.inOut ? `, in/out ${s.inOut[0]}-${s.inOut[1]} s` : ""}.`);
    if (d.clips?.length) {
      lines.push(`${d.clips.length} clip${d.clips.length === 1 ? "" : "s"} selected on the timeline:`);
      for (const c of d.clips) lines.push(`- ${c.kind} clip "${c.name}" ${c.start}-${c.end} s${c.effects ? `, effects: ${c.effects.join(", ")}` : ""}${c.disabled ? ", disabled" : ""}. ref: ${c.ref}`);
    } else lines.push("No clip selected on the timeline.");
  } else lines.push(`Project "${d.project}", no sequence open.`);
  if (d.projectItems?.length) lines.push(`Selected in the Project panel: ${d.projectItems.map((p: any) => `${p.type} "${p.name}"`).join(", ")}.`);
  return lines.join("\n");
}
