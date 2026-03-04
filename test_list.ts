import { list } from '@vercel/blob';
import 'dotenv/config';

async function check() {
    const { blobs } = await list();
    console.log(blobs.map(b => ({ pathname: b.pathname, url: b.url })));
}
check().catch(console.error);
