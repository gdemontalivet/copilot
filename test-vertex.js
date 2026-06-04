const fs = require('fs');
const path = require('path');
const os = require('os');
const { GoogleAuth } = require('google-auth-library');

async function test() {
	const adcPath = path.join(os.homedir(), '.config/gcloud/application_default_credentials.json');
	if (!fs.existsSync(adcPath)) {
		console.error('ADC file not found at:', adcPath);
		return;
	}

	const credentials = JSON.parse(fs.readFileSync(adcPath, 'utf8'));
	console.log('Loading credentials. Client ID:', credentials.client_id ? 'present' : 'missing');

	const projectId = 'bright-drake-274721';
	const locationId = 'us-central1';
	const modelId = 'gemini-2.5-flash';

	try {
		console.log('Authenticating...');
		const auth = new GoogleAuth({
			credentials,
			scopes: 'https://www.googleapis.com/auth/cloud-platform',
			projectId: projectId,
		});
		const client = await auth.getClient();
		const tokenResponse = await client.getAccessToken();
		const token = tokenResponse.token;

		if (!token) {
			throw new Error('Failed to retrieve access token');
		}
		console.log('Token successfully retrieved!');

		// Call Vertex Gemini API directly via HTTP fetch to avoid needing complex SDK imports in the script
		const endpoint = `${locationId}-aiplatform.googleapis.com`;
		const url = `https://${endpoint}/v1/projects/${projectId}/locations/${locationId}/publishers/google/models/${modelId}:streamGenerateContent`;

		console.log('Sending test prompt to Vertex Gemini...');
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
				'x-goog-user-project': projectId,
			},
			body: JSON.stringify({
				contents: [
					{
						role: 'user',
						parts: [
							{ text: 'Say "Vertex Gemini is connected!"' }
						]
					}
				],
				generationConfig: {
					maxOutputTokens: 100
				}
			})
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`HTTP Error ${response.status}: ${errorText}`);
		}

		// Read stream
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let resultText = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			resultText += decoder.decode(value);
		}

		console.log('\nResponse raw segment:\n', resultText.substring(0, 500));
		console.log('\nVertex AI Connection Test Succeeded!');
	} catch (e) {
		console.error('\nTest failed:', e.message || e);
	}
}

test();
