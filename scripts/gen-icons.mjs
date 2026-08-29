import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgDir = join(root, "src/lib/icons/icons");
const outDir = join(root, "src/lib/icons");

function toPascal(file) {
  return file
    .replace(/\.svg$/, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function innerMarkup(svg) {
  const inner = svg
    .replace(/<\?xml[\s\S]*?\?>/, "")
    .replace(/<svg[^>]*>/i, "")
    .replace(/<\/svg>/i, "")
    .trim();
  const stripped = inner.replace(
    /\s+stroke="black"\s+stroke-width="2"\s+stroke-linecap="round"\s+stroke-linejoin="round"/g,
    "",
  );
  return stripped
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n  ");
}

const keep = new Set(["Icon.svelte", "index.js"]);
const names = [];

for (const file of (await readdir(svgDir)).filter((f) => f.endsWith(".svg")).sort()) {
  const pascal = toPascal(file);
  names.push(pascal);
  const svg = await readFile(join(svgDir, file), "utf8");
  const body = innerMarkup(svg);
  const svelte = `<script>
  import Icon from "./Icon.svelte";
  let props = $props();
</script>

<Icon {...props}>
  ${body}
</Icon>
`;
  await writeFile(join(outDir, `${pascal}.svelte`), svelte);
}

const aliases = [
  `export { default as Ban } from "./SlashCircle01.svelte";`,
  `export { default as Clap } from "./BookmarkAdd.svelte";`,
  `export { default as Clipboard } from "./ClipboardPlus.svelte";`,
  `export { default as Headphones } from "./Headphones02.svelte";`,
  `export { default as Lock } from "./Lock01.svelte";`,
  `export { default as Mic } from "./Microphone02.svelte";`,
  `export { default as Monitor } from "./Monitor02.svelte";`,
  `export { default as Moon } from "./Moon01.svelte";`,
  `export { default as Pause } from "./Stop.svelte";`,
  `export { default as User } from "./User01.svelte";`,
  `export { default as Volume2 } from "./VolumeMax.svelte";`,
  `export { default as X } from "./XClose.svelte";`,
];

const generatedExports = names.map(
  (n) => `export { default as ${n} } from "./${n}.svelte";`,
);

await writeFile(
  join(outDir, "index.js"),
  `// Short names used by the app → Untitled UI file.
${aliases.join("\n")}

// Every glyph in icons/icons, named from the filename.
${generatedExports.join("\n")}
`,
);

for (const file of await readdir(outDir)) {
  if (!file.endsWith(".svelte")) continue;
  if (keep.has(file)) continue;
  const pascal = file.replace(/\.svelte$/, "");
  if (names.includes(pascal)) continue;
  await unlink(join(outDir, file));
}

console.log(`wrote ${names.length} icons`);
