import { bounded, type After } from './bounded';

// A model's context window as the Models API states it: `GET {MODELS_API}{id}` answers `max_input_tokens`. Claude Code's
// plugin API reports a window for the session's model alone, so a sub-agent on another model is looked up here, once
// per model id. Pure: the adapter hands in the two calls that reach the session's credential and the network.

/** The Models API's model endpoint; the model id follows it. */
export const MODELS_API = 'https://api.anthropic.com/v1/models/';
/** The API version the request names. */
export const MODELS_API_VERSION = '2023-06-01';
/** How long one lookup may run before it counts as failed: it starts beside the step that names the model, and a step outlasts it. */
export const MODEL_WINDOW_TIMEOUT_MS = 5_000;
/** The most steps a failed lookup waits before the next: the wait doubles from one step, so an API that stays down costs one short request per this many steps. */
export const MODEL_WINDOW_RETRY_MAX_STEPS = 64;

/** What one lookup found: the model's window, or why it is not known. `final`: the API answered about the model itself, so asking again gives the same. */
export type ModelWindowAnswer = { window: number } | { unknown: string; final: boolean };
/** What is known of a model's window now: its figure, or why it is not known. */
export type ModelWindowKnown = { window: number } | { unknown: string };
/** The two calls a lookup makes, handed in by the adapter: the session's credential handle (null with none), and the request that spends it. */
export type ModelWindowIo = {
  authorize: () => Promise<{ handle: string } | null>;
  fetch: (url: string, init: { headers: Record<string, string>; auth: string }) => Promise<{ status: number; text: string }>;
};

/** A lookup that got no answer about the model: worth another try later. */
const lookupFailed = (why: string): ModelWindowAnswer => ({ unknown: `the Models API lookup failed: ${why}`, final: false });

/** The request that asks the Models API for one model; the id is escaped, so it stays one path segment. */
export function modelWindowRequest(model: string): { url: string; headers: Record<string, string> } {
  return { url: `${MODELS_API}${encodeURIComponent(model)}`, headers: { 'anthropic-version': MODELS_API_VERSION } };
}

/** The Models API's answer read: `max_input_tokens` of a listed model is its context window; a 404 says the API does not list it; any other answer is a failure worth another try. */
export function parseModelWindow(status: number, text: string): ModelWindowAnswer {
  let body: { max_input_tokens?: unknown; error?: { type?: unknown } } | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') body = parsed;
  } catch {
    // not JSON: `body` stays undefined, and the answer below says so by its status
  }
  if (status === 200) {
    if (body === undefined) return { unknown: 'the Models API answered 200 with a body that is not JSON', final: false };
    const window = body.max_input_tokens;
    return typeof window === 'number' && Number.isInteger(window) && window > 0 ? { window } : { unknown: 'the Models API lists this model with no max_input_tokens', final: true };
  }
  const type = typeof body?.error?.type === 'string' ? ` ${body.error.type}` : '';
  return status === 404 ? { unknown: `the Models API does not list this model (404${type})`, final: true } : { unknown: `the Models API answered ${status}${type}`, final: false };
}

/** One lookup: the model's window as the Models API answers it, or why it is not known; never rejects. */
export async function askModelWindow(model: string, io: ModelWindowIo): Promise<ModelWindowAnswer> {
  try {
    const auth = await io.authorize();
    if (auth === null) return { unknown: 'the session holds no Anthropic credential the Models API takes', final: false };
    const { url, headers } = modelWindowRequest(model);
    const { status, text } = await io.fetch(url, { headers, auth: auth.handle });
    return parseModelWindow(status, text);
  } catch (error) {
    return lookupFailed(error instanceof Error ? error.message : String(error));
  }
}

type Lookup = { window?: number; unknown?: string; final?: boolean; failures: number; wait: number; running?: Promise<ModelWindowAnswer> };

/** Each model's window as looked up this session: one lookup per model id, a failed one tried again after a wait counted in steps. */
export class ModelWindows {
  private readonly models = new Map<string, Lookup>();

  /** What is known of the model's window; undefined while it was never asked (and for no model). */
  get(model: string | undefined): ModelWindowKnown | undefined {
    const found = model === undefined ? undefined : this.models.get(model);
    return found?.window !== undefined ? { window: found.window } : found?.unknown !== undefined ? { unknown: found.unknown } : undefined;
  }

  /** The model's lookup while one runs: resolved once its answer is in. Nothing to wait for otherwise. */
  settled(model: string | undefined): Promise<ModelWindowAnswer> | undefined {
    return model === undefined ? undefined : this.models.get(model)?.running;
  }

  /**
   * Called at each step of a sub-agent whose model's window is not known: starts a lookup when one is due, and
   * returns it. None starts while one runs, once the window is known, after a final answer, or during a failed
   * lookup's wait: 1 step after the first failure, then 2, 4 … up to MODEL_WINDOW_RETRY_MAX_STEPS. The lookup ends
   * within MODEL_WINDOW_TIMEOUT_MS, as failed when no answer came.
   */
  look(model: string, io: ModelWindowIo, after: After): Promise<ModelWindowAnswer> | undefined {
    const found = this.models.get(model) ?? { failures: 0, wait: 0 };
    this.models.set(model, found);
    if (found.running !== undefined || found.window !== undefined || found.final === true) return undefined;
    if (found.wait > 0) return void found.wait--;
    found.running = bounded(askModelWindow(model, io), MODEL_WINDOW_TIMEOUT_MS, after).then((r) => {
      const answer = r.timedOut ? lookupFailed(`no answer within ${MODEL_WINDOW_TIMEOUT_MS} ms`) : r.value;
      found.running = undefined;
      if ('window' in answer) Object.assign(found, { window: answer.window, unknown: undefined });
      else Object.assign(found, { unknown: answer.unknown, final: answer.final, failures: found.failures + 1, wait: Math.min(2 ** found.failures, MODEL_WINDOW_RETRY_MAX_STEPS) });
      return answer;
    });
    return found.running;
  }
}
