// Paste-to-attach for the console composer: the image items on a paste's clipboard become files named
// pasted-<ms>[-n].<ext>, sent through the same /upload as the 📎 picker. Pure, so it is unit-tested.

/** The slice of a DataTransferItem this reads (a real clipboard item satisfies it). */
export interface ClipItem {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

/** The image files in a paste, in clipboard order; text and non-image files are skipped. */
export function pastedImages(items: ArrayLike<ClipItem> | null | undefined, now: number): File[] {
  const out: File[] = [];
  for (let i = 0; i < (items?.length ?? 0); i++) {
    const it = items![i]!;
    if (it.kind !== "file" || !(it.type || "").startsWith("image/")) continue;
    const f = it.getAsFile();
    if (!f) continue;
    const ext = it.type.slice(6).replace(/[^a-z0-9]/gi, "") || "png";
    out.push(new File([f], `pasted-${now}${out.length ? `-${out.length + 1}` : ""}.${ext}`, { type: it.type }));
  }
  return out;
}
