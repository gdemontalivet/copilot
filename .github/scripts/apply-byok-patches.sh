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
node << 'PATCH2_EOF'
const fs = require("fs");
const f = "src/extension/byok/common/geminiFunctionDeclarationConverter.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("getPrimaryType")) {
  console.log("getPrimaryType already present, skipping");
  process.exit(0);
}

// 1. Widen type field to accept string arrays
code = code.replace("type?: string;", "type?: string | string[];");

// 2. Add getPrimaryType helper before mapType
code = code.replace(
  "// Map JSON schema types to Gemini Type enum",
  `function getPrimaryType(type?: string | string[]): string | undefined {
\tif (Array.isArray(type)) {
\t\treturn type.find((t) => t !== 'null');
\t}
\tif (typeof type === 'string' && type.includes(',')) {
\t\treturn type.split(',').find((t) => t.trim() !== 'null')?.trim();
\t}
\treturn type;
}

// Map JSON schema types to Gemini Type enum`
);

// 3. Use getPrimaryType in toGeminiFunction
code = code.replace(
  "const target = schema.type === 'array' && schema.items ? schema.items : schema;",
  "const typeStr = getPrimaryType(schema.type);\n\tconst target = typeStr === 'array' && schema.items ? schema.items : schema;"
);

// 4. Use getPrimaryType in transformProperties type resolution block
code = code.replace(
  "const transformed: any = {\n\t\t\t// If type is undefined, throw an error to avoid incorrect assumptions\n\t\t\ttype: effectiveValue.type\n\t\t\t\t? mapType(effectiveValue.type)\n\t\t\t\t: Type.OBJECT\n\t\t};",
  "const typeStr = getPrimaryType(effectiveValue.type);\n\n\t\tconst transformed: any = {\n\t\t\ttype: typeStr\n\t\t\t\t? mapType(typeStr)\n\t\t\t\t: Type.OBJECT\n\t\t};"
);

// 5. Replace direct type comparisons with typeStr
code = code.replace(
  "if (effectiveValue.type === 'object' && effectiveValue.properties)",
  "if (typeStr === 'object' && effectiveValue.properties)"
);
code = code.replace(
  "} else if (effectiveValue.type === 'array' && effectiveValue.items)",
  "} else if (typeStr === 'array' && effectiveValue.items)"
);

// 6. Replace items type resolution with getPrimaryType
code = code.replace(
  "const itemType = effectiveValue.items.type === 'object' ? Type.OBJECT : mapType(effectiveValue.items.type ?? 'object');",
  "const itemTypeStr = getPrimaryType(effectiveValue.items.type) ?? 'object';\n\t\t\tconst itemType = itemTypeStr === 'object' ? Type.OBJECT : mapType(itemTypeStr);"
);

fs.writeFileSync(f, code);
console.log("Patched: getPrimaryType");
PATCH2_EOF

# Patch 3: Rename extension and bump version
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.displayName = "Copilot Full BYOK";
pkg.description = "AI chat features powered by Copilot — Full Bring Your Own Key edition";
const parts = pkg.version.split(".").map(Number);
pkg.version = parts[0] + "." + parts[1] + "." + (parts[2] + 1);
fs.writeFileSync("package.json", JSON.stringify(pkg, null, "\t") + "\n");
console.log("Renamed to: " + pkg.displayName + ", version: " + pkg.version);
'
