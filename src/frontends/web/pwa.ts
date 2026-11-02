// The console's install offer (ADR-0022, spec AC17) — pure, so it is unit-tested; app.ts wires it to
// the DOM. Chromium browsers fire `beforeinstallprompt`; iOS Safari has no such event, so there the
// chip shows the "Share → Add to Home Screen" hint instead.

/** localStorage key: the operator dismissed the install hint on this device. */
export const INSTALL_DISMISSED_KEY = "neo.install.dismissed";

export type InstallMode = "none" | "prompt" | "ios-hint";

export function installMode(s: { standalone: boolean; prompt: boolean; ios: boolean; dismissed: boolean }): InstallMode {
  if (s.standalone || s.dismissed) return "none";
  if (s.prompt) return "prompt";
  return s.ios ? "ios-hint" : "none";
}

/** iPhone, iPad, iPod — and iPadOS 13+, whose Safari reports a desktop Mac UA but has a touch screen. */
export function isIos(ua: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}
