import { z } from 'zod';

/**
 * Tell Zod not to compile its schemas with `new Function` (ADR-0040).
 *
 * Zod can speed up parsing by generating code, and probes whether it may with a
 * `new Function('')` it catches if refused. Under the Content Security Policy this app
 * sends, which forbids eval, the probe is refused every time, and a browser reports each
 * refusal as a policy violation even though the code carries on. That noise would hide
 * a real violation, so the probe is skipped: `jitless` is Zod's documented switch for
 * exactly this. Parsing is a few percent slower on a form; nothing else changes.
 *
 * Imported for its effect, before any schema is parsed.
 */
z.config({ jitless: true });
