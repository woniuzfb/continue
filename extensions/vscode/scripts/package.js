const { spawnSync } = require("child_process");
const fs = require("fs");

const version = JSON.parse(
  fs.readFileSync("./package.json", { encoding: "utf-8" }),
).version;

const args = process.argv.slice(2);
let target;

if (args[0] === "--target") {
  target = args[1];
}

if (!fs.existsSync("build")) {
  fs.mkdirSync("build");
}

const isPreRelease = args.includes("--pre-release");

const command = isPreRelease
  ? "npx @vscode/vsce package --out ./build --pre-release --no-dependencies" // --yarn"
  : "npx @vscode/vsce package --out ./build --no-dependencies"; // --yarn";

if (target) {
  command += ` --target ${target}`;
}

// Use spawnSync with inherited stdio so that vsce's output — including the
// `vscode:prepublish` hook (which runs `esbuild-base -- --minify`) — streams
// to the parent terminal in real time. Previously `exec` buffered stdout and
// the callback never printed it, hiding the esbuild build log.
const result = spawnSync(command, {
  stdio: "inherit",
  shell: true,
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status);
}

console.log(
  `vsce package completed - extension created at extensions/vscode/build/continue-${version}.vsix`,
);
