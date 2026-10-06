import { cp, mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const src = join(root, "src");
const GECKO_ID = "alias-maker@rounakkumarsingh.com";

const entries = [
  { in: "background.js", out: "background.js" },
  { in: "popup/popup.js", out: "popup/popup.js" },
  { in: "options/options.js", out: "options/options.js" },
];

const base = await Bun.file(join(src, "manifest.base.json")).json();

function manifestFor(browser: "chrome" | "firefox") {
  if (browser === "chrome") {
    return { ...base, background: { service_worker: "background.js" } };
  }
  return {
    ...base,
    background: { scripts: ["background.js"] },
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: "140.0",
        data_collection_permissions: { required: ["none"] },
      },
      gecko_android: { strict_min_version: "142.0" },
    },
  };
}

for (const browser of ["chrome", "firefox"] as const) {
  const out = join(root, "dist", browser);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  for (const e of entries) {
    const result = await Bun.build({
      entrypoints: [join(src, e.in)],
      target: "browser",
      format: "iife",
      minify: false,
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      process.exit(1);
    }
    const dest = join(out, e.out);
    await mkdir(join(dest, ".."), { recursive: true });
    await Bun.write(dest, await result.outputs[0].text());
  }

  for (const dir of ["popup", "options"]) {
    for (const f of await readdir(join(src, dir))) {
      if (f.endsWith(".html")) await cp(join(src, dir, f), join(out, dir, f));
    }
  }
  await cp(join(src, "ui.css"), join(out, "ui.css"));
  await cp(join(src, "icons"), join(out, "icons"), { recursive: true });
  await Bun.write(join(out, "manifest.json"), JSON.stringify(manifestFor(browser), null, 2) + "\n");
  console.log(`built dist/${browser}`);
}
