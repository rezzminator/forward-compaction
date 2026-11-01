/** One prompt a party received, as the plugin keeps it for a session: the person's message, the brief or a coordinator's message. */
export type ForwardCompactionPrompt = { kind: 'person' | 'received' | 'brief'; at: number; text: string; command?: string; origin?: string; description?: string; subagentType?: string; spawnedBy?: string };

/** One skill a party loaded, as the plugin keeps it for a session: its latest text. */
export type ForwardCompactionSkill = { at: number; skill: string; text: string; how: 'skill-tool' | 'typed-command' | 'preload' | 'ambiguous'; source?: string; path?: string };

/** One standing order a party's last stored frontier carried: the person's words verbatim (an entry an older version kept with an `at` is read for its order alone). */
export type ForwardCompactionOrder = { order: string };

/** A party's last ignore judgement and the model it was made on, so a plugin reload writes no `ignore` row for a judgement that holds. */
export type ForwardCompactionJudged = { judged: 'managed' | 'ignored' | 'unknown'; model: string | null };

declare module 'claude-code' {
  interface PluginState {
    /** Each party's newest prompts, by `{session id}/{party}`, so a plugin reload does not lose them. */
    /** Each party's loaded skills, latest text per skill, by the same id. */
    /** The standing orders of each party's last stored frontier, by the same id, so the next frontier is still held to them. */
    /** Each party's last ignore judgement, by the same id. */
    'forward-compaction': { prompts: StateFamily<ForwardCompactionPrompt[]>; skills: StateFamily<ForwardCompactionSkill[]>; orders: StateFamily<ForwardCompactionOrder[]>; judged: StateFamily<ForwardCompactionJudged> };
  }
}
