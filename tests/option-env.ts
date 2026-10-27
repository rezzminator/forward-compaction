import { OPTION_ENV, type OptionName } from '../plugins/forward-compaction/src/options.ts';

/**
 * The environment that sets each given option: the variable the plugin reads for it, in the grammar of that
 * variable (a flag as 1 or 0, anything else as written). The plugin reads options from the environment alone,
 * so a test names an option here and the harness serves the variable.
 */
export function optionVars(options: Record<string, unknown>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(options)) {
    const variable = OPTION_ENV[name as OptionName];
    if (variable === undefined) throw new Error(`optionVars: ${name} is not an option`);
    vars[variable] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  }
  return vars;
}
