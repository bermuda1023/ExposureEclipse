declare const __BUILD_SHA__: string;

export const BUILD_SHA: string = __BUILD_SHA__;

const ENTRY_SCRIPT = /\/assets\/index-[\w-]+\.js/;

/** Path of the hashed entry bundle referenced by an index.html document. */
export function entryScriptFrom(html: string): string | null {
  return html.match(ENTRY_SCRIPT)?.[0] ?? null;
}

/** Path of the entry bundle this tab is running, or null in the dev server. */
export function runningEntryScript(doc: Document = document): string | null {
  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>("script[src]"))) {
    const path = new URL(script.src, doc.baseURI).pathname;
    if (ENTRY_SCRIPT.test(path)) return path;
  }
  return null;
}

/** True when the served index.html points at a different entry bundle than this tab runs. */
export function isNewerBuildServed(running: string | null, servedHtml: string): boolean {
  const served = entryScriptFrom(servedHtml);
  return running !== null && served !== null && served !== running;
}
