/** One prompt a party received, as the plugin keeps it for a session: the person's message, the brief or a coordinator's message. */
export type ForwardCompactionPrompt = { kind: 'person' | 'received' | 'brief'; at: number; text: string; command?: string; origin?: string; description?: string; subagentType?: string; spawnedBy?: string };

declare module 'claude-code' {
  interface PluginState {
    /** Each party's newest prompts, by `{session id}/{party}`, so a plugin reload does not lose them. */
    'forward-compaction': { prompts: StateFamily<ForwardCompactionPrompt[]> };
  }
}
