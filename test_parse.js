const msg = '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 503,\\n    \\"message\\": \\"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.\\",\\n    \\"status\\": \\"UNAVAILABLE\\"\\n  }\\n}\\n","code":503,"status":"Service Unavailable"}}';
function extractReadableGeminiMessage(err) {
    let currentMessage = err.message;
    let parsedCount = 0;
    while (parsedCount < 3) {
        try {
            const parsed = JSON.parse(currentMessage);
            const nested = parsed?.error?.message || parsed?.message;
            if (typeof nested === 'string' && nested.length > 0) {
                currentMessage = nested;
                parsedCount++;
            } else {
                break;
            }
        } catch {
            break;
        }
    }
    return currentMessage;
}
console.log(extractReadableGeminiMessage({ message: msg }));
