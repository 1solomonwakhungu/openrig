#!/usr/bin/env node
// Cut a fork release of @openrig/cli and point the Homebrew formula at it.
//
//   node scripts/release-homebrew.mjs            # dry run: build, pack, and print the plan
//   node scripts/release-homebrew.mjs --publish  # also create the GitHub release and open the tap PR
//
// Steps: require a clean main that matches origin/main, build the assembled package
// (scripts/build-package.sh) and `npm pack` it, name the tarball
// openrig-<version>-fork.<n>.tgz, publish it as release v<version>-fork.<n> on this
// repository, then open a pull request on the tap that updates Formula/openrig.rb
// (url, version, sha256). Merge that pull request once the tap's Tests pass.
//
// Even a dry run changes the working copy's build outputs: it reinstalls node_modules
// with `npm ci` and rewrites the staged package under packages/cli (daemon/, ui/, tui/).
//
// Environment overrides:
//   OPENRIG_RELEASE_REPO  owner/name of the repository that hosts the release (default: the
//                         GitHub repository of the origin remote; never gh's default repository,
//                         which in a fork checkout can be the upstream)
//   OPENRIG_TAP_REPO      owner/name of the Homebrew tap (default: <owner>/homebrew-tap)
//   OPENRIG_TAP_FORMULA   formula path inside the tap (default: Formula/openrig.rb)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The next fork tag for `version`, given the repository's existing tags. */
export function nextForkTag(version, existingTags) {
  const prefix = `v${version}-fork.`;
  let highest = 0;
  for (const tag of existingTags) {
    if (!tag.startsWith(prefix)) continue;
    const n = Number(tag.slice(prefix.length));
    if (Number.isInteger(n) && n > highest) highest = n;
  }
  return `${prefix}${highest + 1}`;
}

/** owner/name from a GitHub remote URL (https or ssh), or null if it is not a GitHub URL. */
export function githubRepoFromRemoteUrl(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Rewrite the url, version, and sha256 lines of a Homebrew formula. */
export function rewriteFormula(text, { url, version, sha256 }) {
  const fields = { url, version, sha256 };
  let out = text;
  for (const [key, value] of Object.entries(fields)) {
    const line = new RegExp(`^(\\s*)${key} "[^"]*"$`, "m");
    if (!line.test(out)) throw new Error(`formula has no ${key} line`);
    out = out.replace(line, (_match, indent) => `${indent}${key} "${value}"`);
  }
  return out;
}

function run(cmd, args, opts = {}) {
  const out = execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });
  return (out ?? "").trim();
}

function step(message) {
  console.log(`\n==> ${message}`);
}

function main() {
  const publish = process.argv.includes("--publish");

  step("Checking the working tree");
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") throw new Error(`release from main, not ${branch}`);
  // Any tracked change anywhere, or an untracked file among the inputs the package ships
  // or builds from, would publish bytes that "Built from <head>" does not describe.
  if (run("git", ["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("the working tree has uncommitted changes");
  }
  const shippedInputs = ["packages", "scripts", "docs/reference", "LICENSE", "package.json", "package-lock.json"];
  if (run("git", ["status", "--porcelain", "--untracked-files=all", "--", ...shippedInputs])) {
    throw new Error("untracked files exist among the package inputs");
  }
  run("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
  const head = run("git", ["rev-parse", "HEAD"]);
  if (head !== run("git", ["rev-parse", "origin/main"])) throw new Error("HEAD does not match origin/main");

  const originUrl = run("git", ["remote", "get-url", "origin"]);
  const releaseRepo = process.env.OPENRIG_RELEASE_REPO || githubRepoFromRemoteUrl(originUrl);
  if (!releaseRepo) throw new Error(`origin is not a GitHub repository (${originUrl}); set OPENRIG_RELEASE_REPO`);
  const tapRepo = process.env.OPENRIG_TAP_REPO || `${releaseRepo.split("/")[0]}/homebrew-tap`;
  const formulaPath = process.env.OPENRIG_TAP_FORMULA || "Formula/openrig.rb";

  const version = JSON.parse(readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8")).version;
  // Read tags from the repository that hosts the release, which may differ from origin.
  const remoteTags = new Map();
  for (const line of run("git", ["ls-remote", "--tags", `https://github.com/${releaseRepo}.git`, `v${version}-fork.*`]).split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!ref) continue;
    const name = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
    if (ref.endsWith("^{}") || !remoteTags.has(name)) remoteTags.set(name, sha);
  }
  const tags = [...remoteTags.keys()];
  const released = tags.find((tag) => remoteTags.get(tag) === head);
  if (released && publish) throw new Error(`${head.slice(0, 8)} is already released as ${released}`);
  const tag = nextForkTag(version, tags);
  const formulaVersion = tag.slice(1);
  console.log(`release ${tag} of ${head.slice(0, 8)} on ${releaseRepo}; formula ${tapRepo}:${formulaPath}`);

  step("Building the package");
  run("npm", ["ci"], { stdio: "inherit" });
  run("npm", ["run", "build:package"], { stdio: "inherit" });

  step("Packing");
  const outDir = mkdtempSync(path.join(tmpdir(), "openrig-release-"));
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", outDir], { cwd: path.join(REPO_ROOT, "packages/cli") }));
  const tarball = path.join(outDir, `openrig-${formulaVersion}.tgz`);
  renameSync(path.join(outDir, packed[0].filename), tarball);
  const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const url = `https://github.com/${releaseRepo}/releases/download/${tag}/${path.basename(tarball)}`;
  console.log(`${tarball}\nsha256 ${sha256}\nurl ${url}`);

  if (!publish) {
    step("Dry run complete; rerun with --publish to create the release and the tap pull request");
    return;
  }

  step(`Creating release ${tag}`);
  const notes = [
    `OpenRig ${version} with this fork's changes, packaged for Homebrew.`,
    "",
    `Built from ${head} with \`npm run build:package\` and \`npm pack\`.`,
    "",
    "```bash",
    `brew install ${tapRepo.replace("/homebrew-", "/")}/openrig`,
    "```",
  ].join("\n");
  run("gh", ["release", "create", tag, tarball, "--repo", releaseRepo, "--target", head,
    "--title", `OpenRig ${formulaVersion}`, "--notes", notes], { stdio: "inherit" });

  step(`Opening the formula pull request on ${tapRepo}`);
  const tapDir = mkdtempSync(path.join(tmpdir(), "openrig-tap-"));
  run("gh", ["repo", "clone", tapRepo, tapDir, "--", "--quiet"], { stdio: "inherit" });
  const tapBranch = `release/openrig-${formulaVersion}`;
  run("git", ["checkout", "-q", "-b", tapBranch], { cwd: tapDir });
  const formulaFile = path.join(tapDir, formulaPath);
  writeFileSync(formulaFile, rewriteFormula(readFileSync(formulaFile, "utf8"), { url, version: formulaVersion, sha256 }));
  run("git", ["commit", "-q", "-am", `feat: update OpenRig to ${formulaVersion}`], { cwd: tapDir });
  run("git", ["push", "-q", "-u", "origin", tapBranch], { cwd: tapDir, stdio: "inherit" });
  const prUrl = run("gh", ["pr", "create", "--repo", tapRepo, "--head", tapBranch,
    "--title", `feat: update OpenRig to ${formulaVersion}`,
    "--body", `Points the formula at release ${tag} (${head}).\n\nsha256 \`${sha256}\``], { cwd: tapDir });
  step(`Done. Merge ${prUrl} once the tap's Tests pass.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`release-homebrew: ${err.message}`);
    process.exitCode = 1;
  }
}
