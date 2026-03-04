const { handleUpload } = require('@vercel/blob/client');

async function test() {
  try {
    const res = await handleUpload({
      body: { type: 'blob.generate-client-token', payload: { pathname: 'test.pdf', clientPayload: null, multipart: true } },
      request: { headers: { host: 'localhost:3000' }, url: '/api/upload' },
      onBeforeGenerateToken: async (pathname) => {
        return {
          allowedContentTypes: ['application/pdf'],
          maximumSizeInBytes: 50 * 1024 * 1024,
          tokenPayload: JSON.stringify({}),
        };
      },
      token: process.env.BLOB_READ_WRITE_TOKEN
    });
    console.log(res);
  } catch (e) {
    console.error("ERROR:", e);
  }
}
test();
