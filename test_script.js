const https = require('https');
https.get('https://api.github.com/search/issues?q="The+reasoning_content+in+the+thinking+mode+must+be+passed+back+to+the+API"', { headers: { 'User-Agent': 'Node.js' } }, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(data));
});
