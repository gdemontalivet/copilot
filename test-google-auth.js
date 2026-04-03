const { GoogleAuth } = require('google-auth-library');
async function test() {
  try {
    const auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    console.log("Token starts with:", token.token.substring(0, 10));
  } catch (e) {
    console.error(e);
  }
}
test();
