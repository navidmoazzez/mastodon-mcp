/**
 * Uploading media.
 *
 * Two things make this less trivial than it looks.
 *
 * **`/api/v2/media` answers 202, not 200.** For anything larger than a small
 * image the instance accepts the file and processes it asynchronously, and the
 * attachment has no `url` until it finishes. Posting a status that references an
 * unprocessed id fails with a 422 that does not say why. So: poll
 * `/api/v1/media/:id` until the url appears. Without the poll, a video
 * attachment fails intermittently depending on how fast the instance happens to
 * be that day.
 *
 * **Size limits are per instance**, like everything else. They come from
 * `/api/v2/instance`, so a file is refused locally with the real number rather
 * than by the server with a bare 422.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { MastodonClient } from "../api/client.js";
import type { Account } from "../config.js";
import { MastodonError, ValidationError } from "../api/errors.js";
import { instanceLimits } from "../api/instance.js";

export type Fetched = { bytes: Uint8Array; contentType: string; filename: string; source: string };

/**
 * Read media from a public URL or a data: URI.
 *
 * A `data:` URI is accepted because a model that just generated an image has
 * bytes, not a URL, and making it find somewhere to host them first is a
 * pointless detour. A local filesystem path would not work at all for a
 * remotely-hosted MCP server.
 */
export async function fetchMedia(source: string, timeoutMs = 60_000): Promise<Fetched> {
  const trimmed = source.trim();

  if (trimmed.startsWith("data:")) {
    // [\s\S] rather than the `s` flag, so this compiles at an ES2017 target too.
    const match = trimmed.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
    if (!match) throw new ValidationError("Malformed data: URI.", 422, "(local)", "");
    const contentType = match[1] || "application/octet-stream";
    const bytes = match[2]
      ? new Uint8Array(Buffer.from(match[3] ?? "", "base64"))
      : new TextEncoder().encode(decodeURIComponent(match[3] ?? ""));
    return { bytes, contentType, filename: `upload.${extensionFor(contentType)}`, source: "data: URI" };
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ValidationError(
      `Media must be a public http(s) URL or a data: URI. Got "${source.slice(0, 80)}".`,
      422,
      "(local)",
      "",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(trimmed, { signal: controller.signal });
    if (!response.ok) {
      throw new MastodonError(
        `Could not fetch media at ${trimmed} (HTTP ${response.status}). It must be reachable without authentication.`,
        response.status,
        "(fetch)",
        "",
      );
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    const nameFromUrl = new URL(trimmed).pathname.split("/").pop() || "";
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType,
      filename: nameFromUrl.includes(".") ? nameFromUrl : `upload.${extensionFor(contentType)}`,
      source: trimmed,
    };
  } finally {
    clearTimeout(timer);
  }
}

function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
  };
  return map[contentType] ?? "bin";
}

export type Attachment = { url: string; description?: string; focus?: string };

/**
 * Upload one attachment and wait for the instance to finish processing it.
 *
 * `focus` is a `x,y` pair between -1 and 1 marking the visual centre, which is
 * what Mastodon crops thumbnails around. Without it, a portrait photo of a
 * person is routinely cropped to their chest in the timeline.
 */
export async function uploadMedia(
  client: MastodonClient,
  account: Account,
  attachment: Attachment,
  timeoutMs: number,
): Promise<string> {
  const limits = await instanceLimits(client, account);
  const media = await fetchMedia(attachment.url, timeoutMs);

  const isVideo = media.contentType.startsWith("video/") || media.contentType.startsWith("audio/");
  const ceiling = isVideo ? limits.videoSizeLimit : limits.imageSizeLimit;
  if (media.bytes.byteLength > ceiling) {
    throw new ValidationError(
      `${media.source} is ${(media.bytes.byteLength / 1e6).toFixed(1)}MB; ${limits.instance} allows ${(ceiling / 1e6).toFixed(0)}MB for this type.`,
      422,
      "/api/v2/media",
      account.instance,
    );
  }

  const form = new FormData();
  form.append("file", new Blob([Buffer.from(media.bytes)], { type: media.contentType }), media.filename);
  if (attachment.description) form.append("description", attachment.description);
  if (attachment.focus) form.append("focus", attachment.focus);

  const created = await client.call<{ id: string; url?: string }>(account, "/api/v2/media", {
    method: "POST",
    formData: form,
  });
  if (!created.id) {
    throw new MastodonError("The instance accepted the upload but returned no id.", 500, "/api/v2/media", account.instance);
  }
  // 200 means it is already done. 202 means it is still transcoding.
  if (created.url) return created.id;

  // Poll rather than assume. Attaching an unprocessed id makes the status POST
  // fail with a 422 that does not explain itself.
  const deadline = Date.now() + Math.max(timeoutMs, 120_000);
  while (Date.now() < deadline) {
    await delay(1_500);
    const check = await client.call<{ url?: string }>(account, `/api/v1/media/${created.id}`);
    if (check.url) return created.id;
  }

  throw new MastodonError(
    `Attachment ${created.id} was still processing after ${Math.round((Date.now() - (deadline - Math.max(timeoutMs, 120_000))) / 1000)}s. Large videos can take longer; the id stays valid, so retry the post with media_ids once it finishes.`,
    408,
    `/api/v1/media/${created.id}`,
    account.instance,
  );
}
