import * as fs from 'fs';
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const config = packageJson.contributes.configuration;
const propertyGroups = config.map((c: any) => c.properties);
const configProps = Object.assign({}, ...propertyGroups);
console.log(typeof configProps['github.copilot.chat.workspace.codeSearchExternalIngest.enabled'].default);
