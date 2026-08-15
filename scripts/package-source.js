#!/usr/bin/env node
/**
 * Packages the Continue source code into a tarball.
 *
 * Uses `git ls-files` (tracked + untracked but not ignored) so the archive
 * respects .gitignore: node_modules, out/, dist/, build artifacts, etc. are
 * automatically excluded.
 *
 * Only text-based source/config files are included. Every candidate file is
 * checked with `file --mime-type`; anything that is not text (images, fonts,
 * models, videos, archives, source maps, IDE config) is excluded.
 *
 * Output goes to dist/continue-source.tar.gz
 */
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");

// Extensions that are not source, even if detected as text (e.g. SVG icons, docs)
const EXTRA_EXCLUDES = [
  ".map",
  ".backup",
  ".iml",
  ".md",
  ".mdx",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".icns",
  ".bmp",
  ".avif",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".onnx",
  ".wasm",
  ".zip",
  ".jar",
  ".vsix",
];

// Directories that are not source code
const DIR_EXCLUDES = [
  ".idea/",
  "docs/",
  "docs-site/",
  "packages/",
  "actions/",
  "binary/",
  "skills/",
  "sync/",
  "manual-testing-sandbox/",
  "eval/",
  "extensions/cli/",
  "extensions/intellij/",
  "scripts/",
  "LICENSE",
];

// Directories that must always be included, even if they match DIR_EXCLUDES
// (or EXTRA_EXCLUDES). Empty by default; add entries like "docs/" or
// "packages/" to force-include them.
const DIR_INCLUDES = [
  // "gui/node_modules/.package-lock.json",
  // "gui/node_modules/vite",
  // "gui/node_modules/@vitejs/plugin-react-swc",
  // "gui/node_modules/jsdom",
  // "gui/node_modules/tailwindcss",
  // "gui/node_modules/typescript",
  // "gui/node_modules/typescript-eslint",
  // "gui/node_modules/vitest",
  // "node_modules/.package-lock.json",
  // "node_modules/prettier",
  // "node_modules/prettier-plugin-tailwindcss",
];

// Any path segment starting with "." (hidden files/dirs: .github, .claude, .gitignore, ...)
const isHidden = (file) => file.split("/").some((seg) => seg.startsWith("."));

// Root-level config files (.json/.yml/.yaml) — not source code
const isRootConfig = (file) =>
  !file.includes("/") && /\.(json|ya?ml)$/.test(file);

function gitFiles(args) {
  return execSync(`git ls-files -z ${args}`, { cwd: root })
    .toString()
    .split("\0")
    .filter(Boolean);
}

// Tracked files + untracked files that are not ignored (respects .gitignore)
// DIR_INCLUDES entries live outside git's view (e.g. node_modules), so walk
// them directly from the filesystem.
function dirIncludeFiles() {
  const result = [];
  for (const entry of DIR_INCLUDES) {
    let abs = path.join(root, entry);
    if (!fs.existsSync(abs)) {
      console.warn(`⚠️ DIR_INCLUDES entry not found: ${entry}`);
      continue;
    }
    try {
      abs = fs.realpathSync(abs); // resolve symlinks (pnpm/yarn)
    } catch {
      // keep original path
    }
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      result.push(path.relative(root, abs));
      continue;
    }
    const { stdout, status } = spawnSync("find", [abs, "-type", "f"], {
      cwd: root,
      encoding: "utf8",
    });
    if (status !== 0) {
      throw new Error(`find failed for ${entry}`);
    }
    for (const f of stdout.split("\n")) {
      if (f) result.push(path.relative(root, f));
    }
  }
  return result;
}

const allFiles = [
  ...new Set([
    ...gitFiles(""),
    ...gitFiles("-o --exclude-standard"),
    ...dirIncludeFiles(),
  ]),
];

// Detect MIME type for every file, in parallel batches
function detectMimeTypes(files) {
  const result = new Map();
  const batchSize = 200;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const { stdout, status } = spawnSync(
      "file",
      ["--mime-type", "-b", "--", ...batch],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    if (status !== 0) {
      throw new Error(`file command failed with exit code ${status}`);
    }
    const lines = stdout.split("\n");
    batch.forEach((f, idx) => result.set(f, lines[idx]?.trim() ?? ""));
  }
  return result;
}

console.log(`🔍 Detecting file types for ${allFiles.length} files...`);
const mimeTypes = detectMimeTypes(allFiles);

const isText = (mime) =>
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime === "inode/x-empty";
const isIncluded = (file) => DIR_INCLUDES.some((dir) => file.startsWith(dir));

const isExcluded = (file) =>
  !isIncluded(file) &&
  (EXTRA_EXCLUDES.some((ext) => file.endsWith(ext)) ||
    DIR_EXCLUDES.some((dir) => file.startsWith(dir)));

const files = allFiles
  .filter((f) => !isExcluded(f))
  .filter((f) => !isHidden(f))
  .filter((f) => !isRootConfig(f))
  .filter((f) => isText(mimeTypes.get(f) ?? ""))
  .sort();

if (files.length === 0) {
  console.error("❌ No files to package");
  process.exit(1);
}

// let version = "dev";
// try {
//   version = execSync("git describe --tags --always", { cwd: root })
//     .toString()
//     .trim();
// } catch {
//   // no tags available, fall back to "dev"
// }

// const date = new Date().toISOString().slice(0, 10);
const outputName = `continue-source.tar.gz`;
const outputPath = path.join(distDir, outputName);

fs.mkdirSync(distDir, { recursive: true });

const listFile = path.join(os.tmpdir(), `continue-source-${process.pid}.list`);
fs.writeFileSync(listFile, files.join("\n") + "\n");

try {
  execSync(`tar -czf "${outputPath}" -T "${listFile}"`, {
    cwd: root,
    stdio: "inherit",
  });
} catch (err) {
  console.error("❌ Failed to create archive:", err.message);
  process.exit(1);
} finally {
  fs.unlinkSync(listFile);
}

const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
console.log(
  `✅ Packaged ${files.length} files -> dist/${outputName} (${sizeMB} MB)`,
);
