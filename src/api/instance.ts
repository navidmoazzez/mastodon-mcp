/**
 * Per-instance limits, read once and cached.
 *
 * This is the thing every other Mastodon integration gets wrong. The character
 * limit is not 500. It is whatever the instance says it is:
 *
 *   mastodon.social    500 characters,  4 media,  4 poll options
 *   infosec.exchange   11,000 characters, 4 media, 10 poll options
 *
 * Hardcoding 500 refuses a legal 2,000-character post on half the fediverse,
 * and hardcoding 4 poll options refuses a legal 6-option poll. Both reference
 * servers hardcode both.
 *
 * `/api/v2/instance` is the modern endpoint. `/api/v1/instance` is the fallback
 * for servers that have not caught up, including most non-Mastodon software that
 * speaks the same API (Pleroma, Akkoma, GoToSocial).
 */

import type { MastodonClient } from "./client.js";
import type { Account } from "../config.js";

export type InstanceLimits = {
  instance: string;
  title: string;
  version: string;
  maxCharacters: number;
  maxMediaAttachments: number;
  maxPollOptions: number;
  maxPollCharacters: number;
  /** Image and video size ceilings, in bytes. */
  imageSizeLimit: number;
  videoSizeLimit: number;
  /** True when the software is Mastodon proper rather than a compatible server. */
  looksLikeMastodon: boolean;
};

/** Sane values for a server that answers neither instance endpoint. */
const FALLBACK = {
  maxCharacters: 500,
  maxMediaAttachments: 4,
  maxPollOptions: 4,
  maxPollCharacters: 50,
  imageSizeLimit: 10 * 1024 * 1024,
  videoSizeLimit: 40 * 1024 * 1024,
};

const cache = new Map<string, InstanceLimits>();

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function instanceLimits(
  client: MastodonClient,
  account: Account,
): Promise<InstanceLimits> {
  const cached = cache.get(account.instance);
  if (cached) return cached;

  let data: Record<string, any> | undefined;
  try {
    data = await client.call<Record<string, any>>(account, "/api/v2/instance", { anonymous: true });
  } catch {
    try {
      data = await client.call<Record<string, any>>(account, "/api/v1/instance", { anonymous: true });
    } catch {
      data = undefined;
    }
  }

  // v2 nests everything under `configuration`; v1 puts some of it at the top level.
  const conf = data?.configuration ?? {};
  const statuses = conf.statuses ?? {};
  const polls = conf.polls ?? {};
  const media = conf.media_attachments ?? {};

  const limits: InstanceLimits = {
    instance: account.instance,
    title: String(data?.title ?? account.instance.replace(/^https?:\/\//, "")),
    version: String(data?.version ?? "unknown"),
    maxCharacters: num(statuses.max_characters ?? data?.max_toot_chars, FALLBACK.maxCharacters),
    maxMediaAttachments: num(statuses.max_media_attachments, FALLBACK.maxMediaAttachments),
    maxPollOptions: num(polls.max_options, FALLBACK.maxPollOptions),
    maxPollCharacters: num(polls.max_characters_per_option, FALLBACK.maxPollCharacters),
    imageSizeLimit: num(media.image_size_limit, FALLBACK.imageSizeLimit),
    videoSizeLimit: num(media.video_size_limit, FALLBACK.videoSizeLimit),
    looksLikeMastodon: !/pleroma|akkoma|gotosocial|misskey|firefish/i.test(String(data?.version ?? "")),
  };

  cache.set(account.instance, limits);
  return limits;
}

/** Drop the cache, for `doctor` and for tests. */
export function forgetInstance(instance?: string): void {
  if (instance) cache.delete(instance);
  else cache.clear();
}
