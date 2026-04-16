#!/bin/bash
set -e

# Patch 1: Fake token to bypass subscription
node -e '
const fs = require("fs");
const f = "src/platform/authentication/vscode-node/copilotTokenManager.ts";
let code = fs.readFileSync(f, "utf8");

code = code.replace(
  "import { CopilotToken, ExtendedTokenInfo,",
  "import { CopilotToken, createTestExtendedTokenInfo, ExtendedTokenInfo,"
);

const original = /async getCopilotToken\(force\?: boolean\): Promise<CopilotToken> \{[\s\S]*?return new CopilotToken\(this\.copilotToken\);\s*\}/;
const replacement = `async getCopilotToken(force?: boolean): Promise<CopilotToken> {
\t\tconst fakeTokenInfo = createTestExtendedTokenInfo({
\t\t\ttoken: "fake-token",
\t\t\texpires_at: 9999999999,
\t\t\trefresh_in: 9999999999,
\t\t\tsku: "individual",
\t\t\tindividual: true,
\t\t\tusername: "offline-user",
\t\t\tcopilot_plan: "individual",
\t\t});
\t\tif (!this.copilotToken) {
\t\t\tthis.copilotToken = fakeTokenInfo;
\t\t}
\t\treturn new CopilotToken(fakeTokenInfo);
\t}`;
code = code.replace(original, replacement);
fs.writeFileSync(f, code);
console.log("Patched: fake token");
'

# Patch 2: getPrimaryType for Gemini union types
node -e '
const fs = require("fs");
const f = "src/extension/byok/common/geminiFunctionDeclarationConverter.ts";
let code = fs.readFileSync(f, "utf8");

if (!code.includes("getPrimaryType")) {
  code = code.replace("type?: string;", "type?: string | string[];");

  const helper = `function getPrimaryType(type?: string | string[]): string | undefined {
\tif (Array.isArray(type)) {
\t\treturn type.find((t) => t !== "null");
\t}
\tif (typeof type === "string" && type.includes(",")) {
\t\treturn type.split(",").find((t) => t.trim() !== "null")?.trim();
\t}
\treturn type;
}

// Map JSON schema types to Gemini Type enum`;
  code = code.replace("// Map JSON schema types to Gemini Type enum", helper);

  code = code.replace(
    "const target = schema.type === '\"'array'\"' && schema.items ? schema.items : schema;",
    "const typeStr = getPrimaryType(schema.type);\n\tconst target = typeStr === '\"'array'\"' && schema.items ? schema.items : schema;"
  );

  fs.writeFileSync(f, code);
  console.log("Patched: getPrimaryType");
} else {
  console.log("getPrimaryType already present, skipping");
}
'

# Patch 3: Bump version
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const parts = pkg.version.split(".").map(Number);
pkg.version = parts[0] + "." + parts[1] + "." + (parts[2] + 1);
fs.writeFileSync("package.json", JSON.stringify(pkg, null, "\t") + "\n");
console.log("Version bumped to: " + pkg.version);
'
