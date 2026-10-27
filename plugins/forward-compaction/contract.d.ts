/** One prompt a party received, as the plugin keeps it for a session: the person's message, the brief or a coordinator's message. */
export type ForwardCompactionPrompt = { kind: 'person' | 'received' | 'brief'; at: number; text: string; command?: string; origin?: string; description?: string; subagentType?: string; spawnedBy?: string };

/** One skill a party loaded, as the plugin keeps it for a session: its latest text. */
export type ForwardCompactionSkill = { at: number; skill: string; text: string; how: 'skill-tool' | 'typed-command' | 'preload' | 'ambiguous'; source?: string; path?: string };

declare module 'claude-code' {
  interface PluginState {
    /** Each party's newest prompts, by `{session id}/{party}`, so a plugin reload does not lose them. */
    /** Each party's loaded skills, latest text per skill, by the same id. */
    'forward-compaction': { prompts: StateFamily<ForwardCompactionPrompt[]>; skills: StateFamily<ForwardCompactionSkill[]> };
  }
}
