import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
const root = new URL("../", import.meta.url);
const harness = readFileSync(
  new URL("./test-reroll.mjs", import.meta.url),
  "utf8",
);
// Recorded from commit 26eb265 before adding information-access processing.
function run(source, explicitOff) {
  const file = new URL(`./.knowledge-off-fixture-${crypto.randomUUID()}.mjs`, import.meta.url);
  let script = harness.replace(
    "read('src/pages/ChatPage.tsx')",
    JSON.stringify(source),
  );
  if (explicitOff)
    script = script.replace(
      "const send = vm.runInNewContext",
      "session.knowledge_enabled=false;\n  const send = vm.runInNewContext",
    );
  script +=
    "\nprocess.stdout.write('KNOWLEDGE_BODIES='+JSON.stringify(bodies)+'\\n');\n";
  try {
    writeFileSync(file, script);
    const stdout = execFileSync(process.execPath, [file.pathname], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(stdout.split("KNOWLEDGE_BODIES=")[1].trim());
  } finally {
    try {
      unlinkSync(file);
    } catch {}
  }
}
const current = readFileSync(
  new URL("../src/pages/ChatPage.tsx", import.meta.url),
  "utf8",
);
const expected = JSON.parse(
  readFileSync(
    new URL("./fixtures/knowledge-off-bodies.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(
  JSON.stringify(run(current, false)),
  JSON.stringify(expected),
  "legacy sessions retain the exact recorded HTTP payloads across normal send, reroll, direction, peer context and failures",
);
assert.equal(
  JSON.stringify(run(current, true)),
  JSON.stringify(expected),
  "explicit OFF retains the same HTTP payloads and existing persistence mechanisms, with no knowledge calls",
);
console.log(
  `Knowledge OFF: ${expected.length} actual model requests match pre-feature payloads byte-for-byte (legacy and explicit OFF).`,
);
