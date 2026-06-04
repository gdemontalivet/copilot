const pkg = require('./package.json');
console.log(pkg.contributes.configuration.find(c => c.properties && c.properties['github.copilot.chat.workspace.codeSearchExternalIngest.enabled'])?.properties['github.copilot.chat.workspace.codeSearchExternalIngest.enabled']);
