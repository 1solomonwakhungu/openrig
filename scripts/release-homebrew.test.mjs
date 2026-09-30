import { test } from "node:test";
import assert from "node:assert/strict";
import { githubRepoFromRemoteUrl, nextForkTag, rewriteFormula } from "./release-homebrew.mjs";

test("nextForkTag starts at fork.1 and continues past the highest existing tag", () => {
  assert.equal(nextForkTag("0.6.1", []), "v0.6.1-fork.1");
  assert.equal(nextForkTag("0.6.1", ["v0.6.1-fork.1", "v0.6.1-fork.3", "v0.6.1-fork.2"]), "v0.6.1-fork.4");
});

test("nextForkTag ignores other versions and malformed suffixes", () => {
  assert.equal(nextForkTag("0.6.2", ["v0.6.1-fork.5", "v0.6.2", "v0.6.2-fork.x"]), "v0.6.2-fork.1");
  assert.equal(nextForkTag("0.6.1", ["v0.6.1-fork.10", "v0.6.1-fork.9"]), "v0.6.1-fork.11");
});

const FORMULA = `class Openrig < Formula
  desc "Local control plane for multi-agent coding topologies"
  homepage "https://github.com/owner/openrig"
  url "https://github.com/owner/openrig/releases/download/v0.6.1-fork.1/openrig-0.6.1-fork.1.tgz"
  version "0.6.1-fork.1"
  sha256 "${"a".repeat(64)}"
  license "Apache-2.0"

  depends_on "node@22"
end
`;

test("rewriteFormula replaces url, version, and sha256 and leaves the rest untouched", () => {
  const out = rewriteFormula(FORMULA, {
    url: "https://github.com/owner/openrig/releases/download/v0.6.1-fork.2/openrig-0.6.1-fork.2.tgz",
    version: "0.6.1-fork.2",
    sha256: "b".repeat(64),
  });
  assert.match(out, /^  url "https:\/\/github\.com\/owner\/openrig\/releases\/download\/v0\.6\.1-fork\.2\/openrig-0\.6\.1-fork\.2\.tgz"$/m);
  assert.match(out, /^  version "0\.6\.1-fork\.2"$/m);
  assert.match(out, new RegExp(`^  sha256 "${"b".repeat(64)}"$`, "m"));
  assert.equal(out.replace(/^  (url|version|sha256) .*$/gm, ""), FORMULA.replace(/^  (url|version|sha256) .*$/gm, ""));
});

test("rewriteFormula refuses a formula missing one of the fields", () => {
  assert.throws(
    () => rewriteFormula(FORMULA.replace(/^  version .*\n/m, ""), { url: "u", version: "v", sha256: "s" }),
    /no version line/,
  );
});

test("rewriteFormula inserts values literally, even when they contain $ patterns", () => {
  const out = rewriteFormula(FORMULA, { url: "https://x/$1$&.tgz", version: "0.6.1-fork.2", sha256: "c".repeat(64) });
  assert.match(out, /^  url "https:\/\/x\/\$1\$&\.tgz"$/m);
});

test("githubRepoFromRemoteUrl reads owner/name from https and ssh remotes", () => {
  assert.equal(githubRepoFromRemoteUrl("https://github.com/owner/openrig.git"), "owner/openrig");
  assert.equal(githubRepoFromRemoteUrl("https://github.com/owner/openrig"), "owner/openrig");
  assert.equal(githubRepoFromRemoteUrl("git@github.com:owner/openrig.git"), "owner/openrig");
  assert.equal(githubRepoFromRemoteUrl("ssh://git@github.com/owner/openrig.git\n"), "owner/openrig");
  assert.equal(githubRepoFromRemoteUrl("https://gitlab.com/owner/openrig.git"), null);
  assert.equal(githubRepoFromRemoteUrl("/local/path/openrig"), null);
});
