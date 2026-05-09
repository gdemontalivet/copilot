const { GoogleGenAI, Type } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  const model = 'gemini-3.0-pro'; // or whatever the exact model name is

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro', // use an available model, wait thought signatures are in gemini-3.0?
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Please call both tool1 and tool2' }]
        },
        {
          role: 'model',
          parts: [
            {
              thoughtSignature: 'test-signature-123',
              functionCall: { name: 'tool1', args: {} }
            },
            {
              // missing thoughtSignature here
              functionCall: { name: 'tool2', args: {} }
            }
          ]
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'tool1', response: { ok: true } } },
            { functionResponse: { name: 'tool2', response: { ok: true } } }
          ]
        }
      ],
      config: {
        tools: [{
          functionDeclarations: [
            { name: 'tool1', description: 'Tool 1' },
            { name: 'tool2', description: 'Tool 2' }
          ]
        }]
      }
    });
    console.log("Success:", response.text);
  } catch (err) {
    console.error("Error:", err.message);
  }
}

test();
