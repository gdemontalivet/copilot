/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('fs');
const upstream = JSON.parse(fs.readFileSync('package.nls.upstream.json', 'utf8'));
const custom = JSON.parse(fs.readFileSync('my-package.nls.json', 'utf8'));
const merged = { ...upstream, ...custom };
fs.writeFileSync('package.nls.json', JSON.stringify(merged, null, 2) + '\n');
console.log('Merged package.nls.json');
