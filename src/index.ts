/**
 * dsh-session-export — auto-export DeepSeek Harness sessions to Markdown.
 *
 * Mounts over any base profile. Listens on the `session/event` firehose; when
 * a `turn/end` event lands it debounces `debounceMs` of quiet, then writes a
 * full transcript (turn/step structure, messages, tool calls, token usage,
 * task lists, errors) to `$DSH_HOME/exports/`. Pending exports flush
 * synchronously on dispose so one-shot (headless) runs never lose their
 * transcript.
 *
 * The rendering pipeline is exported as a pure module (`dsh-session-export`
 * re-exports `renderSessionMarkdown` / `summarizeStats` from `./markdown.js`),
 * so other plugins can reuse it for on-demand exports.
 *
 * @module dsh-session-export
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { renderSessionMarkdown } from './markdown.js';

/** Stable Cordis plugin name. */
const name = 'session-export';
/** Core services required before the exporter can run. */
const inject = ['sessions'];

/** Plugin configuration after schema validation. */
export interface SessionExportConfig {
	enabled: boolean;
	/** Export directory; defaults to $DSH_HOME/exports. */
	outDir?: string;
	/** Quiet time after turn/end before the session is written. */
	debounceMs: number;
	/** Truncation bound for tool arguments and results in the transcript. */
	maxResultChars: number;
	/** Include synthetic injection messages (context snapshots, skill catalogs). */
	includeInjected: boolean;
}

const Config = z.object({
	/** Master switch; false disables auto export entirely. */
	enabled: z.boolean().default(true),
	/** Export directory; defaults to $DSH_HOME/exports. */
	outDir: z.string(),
	/** Quiet time after turn/end before the session is written. */
	debounceMs: z.number().default(1000),
	/** Truncation bound for tool arguments and results in the transcript. */
	maxResultChars: z.number().default(2000),
	/** Include synthetic injection messages (context snapshots, skill catalogs). */
	includeInjected: z.boolean().default(false)
});

function dshHome(): string {
	return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

function sanitizeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function hasContent(events: readonly SessionEvent[]): boolean {
	return events.some((event) => event.type === 'user/message' || event.type === 'assistant/message');
}

function metaFromHeader(header: SessionHeader) {
	return {
		createdAt: header.createdAt,
		cwd: header.cwd,
		agentPreset: header.agentPreset
	};
}

/**
 * Export one session to a Markdown file. Returns the written file path, or
 * undefined when the session has no message content worth exporting.
 */
export function exportSession(session: Session, config: SessionExportConfig): string | undefined {
	const events = session.events;
	if (!hasContent(events)) return undefined;
	const markdown = renderSessionMarkdown(
		events,
		{ sessionId: session.id, ...metaFromHeader(session.header) },
		config.maxResultChars,
		config.includeInjected
	);
	const dir = config.outDir ?? join(dshHome(), 'exports');
	mkdirSync(dir, { recursive: true });
	const stem = sanitizeId(session.id).replace(/^session-/, '');
	const file = join(dir, `session-${stem}.md`);
	writeFileSync(file, markdown, 'utf8');
	return file;
}

/**
 * Mount the exporter: subscribe to the event firehose and flush pending
 * exports on dispose.
 */
function apply(ctx: Context, config: SessionExportConfig) {
	if (!config.enabled) return;

	const timers = new Map<string, NodeJS.Timeout>();
	const pending = new Map<string, Session>();

	ctx.on('session/event', (session: Session, event: SessionEvent) => {
		if (event.type !== 'turn/end') return;
		const id = session.id;
		pending.set(id, session);
		clearTimeout(timers.get(id));
		timers.set(
			id,
			setTimeout(() => {
				timers.delete(id);
				pending.delete(id);
				try {
					const file = exportSession(session, config);
					if (file !== undefined) ctx.logger.info(`session-export: wrote ${file}`);
				} catch (error) {
					ctx.logger.warn(`session-export: ${error instanceof Error ? error.message : String(error)}`);
				}
			}, config.debounceMs)
		);
	});

	ctx.effect(() => () => {
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		for (const session of pending.values()) {
			try {
				exportSession(session, config);
			} catch {
				// best effort on shutdown; a failed export must not block dispose
			}
		}
		pending.clear();
	});
}

export { Config, apply, inject, name };
