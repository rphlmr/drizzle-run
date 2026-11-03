import * as z from "zod/mini";

/**
 * Community topics, as the Worker stores them. Every share is a playground unless its owner marks it as a bug repro;
 * Community lists bug repros only under their own filter.
 */
export const COMMUNITY_TOPICS = ["playground", "bug-repros"] as const;

/** A topic a share is listed under. */
export type CommunityTopic = (typeof COMMUNITY_TOPICS)[number];

/** The topic a share gets, and Community shows, unless bug repros are asked for. */
export const DEFAULT_COMMUNITY_TOPIC: CommunityTopic = "playground";

/** One of the Community topics. */
export const CommunityTopicSchema = z.enum(COMMUNITY_TOPICS);

/** A share description longer than this is refused by the Worker. Community listings reuse it. */
export const MAX_SHARE_DESCRIPTION_LENGTH = 140;
