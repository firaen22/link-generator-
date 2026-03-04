import { upload } from '@vercel/blob/client';
import fs from 'fs';

async function test() {
    const fileBuffer = fs.readFileSync('big_test.pdf');
    const file = new File([fileBuffer], 'big_test.pdf', { type: 'application/pdf' });

    try {
        const newBlob = await upload(file.name, file, {
            access: 'public',
            handleUploadUrl: 'http://localhost:3000/api/upload',
            multipart: true,
        });
        console.log("SUCCESS:", newBlob.url);
    } catch (err) {
        console.error("UPLOAD ERROR:", err);
    }
}
test();
