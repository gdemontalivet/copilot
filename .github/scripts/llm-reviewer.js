const { execSync } = require('child_process');

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set. Skipping LLM review and failing safety check.");
    console.error("Please add GEMINI_API_KEY to your GitHub repository secrets.");
    process.exit(1);
  }

  // Get the git diff
  const diff = execSync('git diff --cached', { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  
  if (!diff.trim()) {
    console.log("No diff found.");
    process.exit(0);
  }

  // We truncate the diff if it is too large to avoid hitting payload limits,
  // but Gemini 1.5 Pro handles up to 2M tokens (~8MB text).
  const diffContent = diff.length > 5000000 ? diff.substring(0, 5000000) + "\n...[Diff Truncated]..." : diff;

  const prompt = `You are an automated reviewer for a GitHub repository.
This repository is a fork of Microsoft's VS Code Copilot Chat extension, with custom BYOK (Bring Your Own Key) patches applied.
An automated upstream sync has just occurred, pulling new code from Microsoft and re-applying our patches.

Your job is to review the git diff and DECIDE if it is safe to automatically push to the main branch, or if it requires manual human review.

Safety criteria:
1. Do not reject simply because there are many changes (upstream updates often have many changes).
2. Look for changes that might break the BYOK architecture:
   - Modifications to 'copilotTokenManager.ts' that override or conflict with the fake token patch.
   - Significant architectural changes in authentication, endpoint routing, or 'modelMetadataFetcher.ts'.
   - Changes in 'geminiFunctionDeclarationConverter.ts' that break the 'getPrimaryType' patch.
3. If the changes look like normal upstream updates (new features, bug fixes, prompt tweaks) and the BYOK patches applied cleanly, APPROVE.
4. If there is a high risk of BYOK functionality being broken, REJECT.

Review the following git diff:
\`\`\`diff
${diffContent}
\`\`\`

Respond ONLY with a JSON object in the following format:
{
  "decision": "APPROVE" | "REJECT",
  "reason": "Short explanation of your decision"
}
`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Error from Gemini API:", error);
      process.exit(1);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!text) {
      console.error("Failed to parse Gemini response:", JSON.stringify(data, null, 2));
      process.exit(1);
    }

    const result = JSON.parse(text);
    console.log(`LLM Decision: ${result.decision}`);
    console.log(`Reason: ${result.reason}`);

    if (result.decision === 'APPROVE') {
      console.log("Sync approved by LLM. Proceeding.");
      process.exit(0);
    } else {
      console.error("Sync rejected by LLM. Manual intervention required.");
      process.exit(1);
    }
  } catch (err) {
    console.error("Failed to call LLM or parse response:", err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
