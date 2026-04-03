// Vercel Edge Function — PDF Proxy
// Bypasses the 4.5MB serverless payload limit by streaming directly from Firebase Storage.
// Must NOT import from server.ts (Node.js/Express) — Edge runtime is Web API only.

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Extract file_id from path: /api/pdf/<file_id>
  const segments = url.pathname.split('/');
  const file_id = segments[segments.length - 1];

  if (!file_id) {
    return new Response('Missing file_id', { status: 400 });
  }

  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let blobUrl = '';

  try {
    if (file_id.startsWith('f_')) {
      // f_<base64(firebase-storage-path)>
      let base64 = file_id.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) base64 += '=';

      // atob is available in Edge runtime
      const filePath = atob(base64);
      const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, '%2F');

      const bucket =
        (process.env.VITE_FIREBASE_STORAGE_BUCKET ||
          process.env.FIREBASE_STORAGE_BUCKET ||
          'market-update-56e1c.firebasestorage.app');

      blobUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedPath}?alt=media`;

    } else if (file_id.startsWith('vblob_')) {
      // vblob_<base64(direct-url)>
      let base64 = file_id.slice(6).replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) base64 += '=';
      blobUrl = atob(base64);

    } else {
      return new Response('Invalid file ID format. Expected f_ or vblob_ prefix.', {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    const upstream = await fetch(blobUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    if (!upstream.ok) {
      return new Response(`Upstream fetch failed: ${upstream.status} ${upstream.statusText}`, {
        status: upstream.status,
        headers: CORS_HEADERS,
      });
    }

    // Pipe the ReadableStream directly — no buffering, no memory ceiling
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="report_secure.pdf"',
        'Cache-Control': 'private, max-age=3600',
        'X-Served-By': 'edge',
      },
    });

  } catch (err: any) {
    console.error('[PDF_EDGE] Error:', err?.message);
    return new Response('Internal error retrieving document.', {
      status: 500,
      headers: CORS_HEADERS,
    });
  }
}
