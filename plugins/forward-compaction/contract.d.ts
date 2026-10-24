/** One of the person's messages, as the plugin keeps it for a session. */
export type ForwardCompactionPerson = { at: number; text: string; command?: string };

declare module 'claude-code' {
  interface PluginState {
    /** The person's newest messages per session id, so a plugin reload does not lose them. */
    'forward-compaction': { person: StateFamily<ForwardCompactionPerson[]> };
  }
}
