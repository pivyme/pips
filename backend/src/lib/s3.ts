// Thin S3 wrapper over Bun's native S3Client (Bun 1.3.5, no extra deps). Talks to a shared
// DigitalOcean Spaces bucket; every object lives under S3_FOLDER_PREFIX. Powers the custom avatar
// uploads. Callers gate on AVATAR_UPLOADS_ENABLED, so this module assumes creds are present.

import { S3Client } from 'bun';

import {
  S3_ACCESS_KEY,
  S3_SECRET_KEY,
  S3_BUCKET,
  S3_BUCKET_URL,
  S3_ENDPOINT,
  S3_REGION,
} from '../config/main-config.ts';

// One client for the process. Path-style against the regional endpoint (the Bun default for a custom
// endpoint): the object lands in the bucket and is served publicly at the virtual-hosted public URL
// (`${S3_BUCKET_URL}/<key>`). Do NOT set virtualHostedStyle:true here, DO Spaces rejects Bun's
// vhost URL composition with "The specified bucket does not exist" (verified against the live bucket).
const client = new S3Client({
  accessKeyId: S3_ACCESS_KEY,
  secretAccessKey: S3_SECRET_KEY,
  bucket: S3_BUCKET,
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
});

// Write bytes as a public-read object; returns the stable public URL derived from the key we wrote
// (always server-derived, never client input). Throws on a real S3 failure so the route can 503.
export async function putObject(
  key: string,
  data: string | Uint8Array,
  contentType: string,
): Promise<string> {
  await client.write(key, data, { type: contentType, acl: 'public-read' });
  return `${S3_BUCKET_URL}/${key}`;
}

// Best-effort delete of one of our own objects by its public URL. Swallows errors and ignores any URL
// that isn't ours: a failed cleanup (replace/remove) must never fail the request.
export async function deleteByUrl(url: string | null | undefined): Promise<void> {
  const base = `${S3_BUCKET_URL}/`;
  if (!url || !url.startsWith(base)) return;
  try {
    await client.delete(url.slice(base.length));
  } catch {
    // orphaned object, harmless; leave it
  }
}
