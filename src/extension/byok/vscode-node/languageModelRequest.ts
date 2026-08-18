/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, LanguageModelChat, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelChatRequestOptions, LanguageModelChatResponse } from 'vscode';

/**
 * Send either generation of VS Code language-model messages through a selected model.
 * The proposed provider API accepts both message shapes, while the selected-model API's
 * stable declaration still exposes only the original shape.
 */
export function sendLanguageModelRequest(
	model: LanguageModelChat,
	messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
	options: LanguageModelChatRequestOptions,
	token: CancellationToken,
): Thenable<LanguageModelChatResponse> {
	return model.sendRequest(messages as LanguageModelChatMessage[], options, token);
}
