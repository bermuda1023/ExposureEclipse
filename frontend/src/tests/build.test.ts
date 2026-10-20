import { entryScriptFrom, isNewerBuildServed, runningEntryScript } from "../build";

const html = (bundle: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${bundle}"></script></head></html>`;

describe("stale build detection", () => {
  it("reads the hashed entry bundle from index.html", () => {
    expect(entryScriptFrom(html("/assets/index-Ab12_cD-.js"))).toBe("/assets/index-Ab12_cD-.js");
    expect(entryScriptFrom("<html></html>")).toBeNull();
  });

  it("flags a different served bundle and ignores the same one", () => {
    expect(isNewerBuildServed("/assets/index-old.js", html("/assets/index-new.js"))).toBe(true);
    expect(isNewerBuildServed("/assets/index-same.js", html("/assets/index-same.js"))).toBe(false);
  });

  it("never flags in the dev server or when the response has no bundle", () => {
    expect(isNewerBuildServed(null, html("/assets/index-new.js"))).toBe(false);
    expect(isNewerBuildServed("/assets/index-old.js", "<html>maintenance</html>")).toBe(false);
  });

  it("finds the entry bundle this document loaded", () => {
    const doc = new DOMParser().parseFromString(html("/assets/index-Run1.js"), "text/html");
    expect(runningEntryScript(doc)).toBe("/assets/index-Run1.js");
    expect(runningEntryScript(new DOMParser().parseFromString("<html></html>", "text/html"))).toBeNull();
  });
});
