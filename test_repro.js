const https = require('https');

const payload = JSON.stringify({
  model: 'deepseek-chat',
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi', reasoning_content: 'thinking...' },
    { role: 'user', content: 'test' }
  ]
});

console.log(payload);
