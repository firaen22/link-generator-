// Vercel Serverless Function — PDF Proxy
// Handles Firebase Storage (f_), Vercel Blob (vblob_), and Cloudflare R2 (r2_) file IDs.
// Uses Node.js runtime to support the AWS SDK for R2 signed URLs.

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { VercelRequest, VercelResponse } from '@vercel/node';

// No edge runtime — Node.js needed for AWS SDK
export const config = {
  api: {
    responseLimit: false, // allow large PDF streaming
  },
};

const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { file_id } = req.query as { file_id?: string };
  const fileId = Array.isArray(file_id) ? file_id.join('/') : (file_id || '');

  // Also handle path-style: /api/pdf/<file_id>
  const pathFileId = (req.url || '').split('/api/pdf/')[1]?.split('?')[0] || '';
  const resolvedFileId = fileId || pathFileId;

  if (!resolvedFileId) {
    return res.status(400).send('Missing file_id');
  }

  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  let blobUrl = '';

  try {
    if (resolvedFileId.startsWith('r2_')) {
      // Cloudflare R2 Path: r2_<base64url(key)>
      const rawBase64 = resolvedFileId.slice(3);
      let base64 = rawBase64.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) base64 += '=';
      const r2Key = Buffer.from(base64, 'base64').toString('utf8');

      const bucket = process.env.R2_BUCKET_NAME || "reports";
      console.log(`[PDF_PROXY] R2 key: ${r2Key} | Bucket: ${bucket}`);

      const command = new GetObjectCommand({ Bucket: bucket, Key: r2Key });
      blobUrl = await getSignedUrl(s3Client, command, { expiresIn: 60 });

    } else if (resolvedFileId.startsWith('f_')) {
      // Firebase Storage path
      let base64 = resolvedFileId.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) base64 += '=';
      const filePath = Buffer.from(base64, 'base64').toString('utf8');
      const encodedPath = encodeURIComponent(filePath).replace(/\//g, '%2F');
      const bucket = process.env.VITE_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || 'market-update-56e1c.firebasestorage.app';
      blobUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedPath}?alt=media`;

    } else if (resolvedFileId.startsWith('vblob_')) {
      // Direct encoded URL (Vercel Blob or tokenized Firebase URL)
      let base64 = resolvedFileId.slice(6).replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) base64 += '=';
      blobUrl = Buffer.from(base64, 'base64').toString('utf8');

    } else {
      return res.status(400).send('Invalid file ID format. Expected r2_, f_, or vblob_ prefix.');
    }

    const upstream = await fetch(blobUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream fetch failed: ${upstream.status} ${upstream.statusText}`);
    }

    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="report_secure.pdf"',
      'Cache-Control': 'private, max-age=3600',
    });

    // Stream to client
    if (upstream.body) {
      // @ts-ignore
      for await (const chunk of upstream.body) {
        res.write(chunk);
      }
      res.end();
    } else {
      const buffer = await upstream.arrayBuffer();
      res.end(Buffer.from(buffer));
    }

  } catch (err: any) {
    console.error('[PDF_PROXY] Error:', err?.message);
    res.status(500).send('Internal error retrieving document.');
  }
}
