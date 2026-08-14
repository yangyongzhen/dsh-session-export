/**
 * Pure session-to-Markdown rendering. No dsh runtime dependency: feed any
 * `SessionEvent[]` (live store events or decoded storage records) and get a
 * review-ready transcript with turn/step structure, tool calls, and token
 * statistics.
 *
 * @module dsh-session-export/markdown
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** Creation metadata surfaced in the export header. */
export interface ExportMeta {
    sessionId: string;
    createdAt?: number;
    cwd?: string;
    agentPreset?: string;
}
/** Aggregated statistics for the export footer. */
export interface ExportStats {
    turns: number;
    steps: number;
    toolCalls: number;
    toolErrors: number;
    tokens: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
    };
    durationMs: number;
    startTime?: number;
    endTime?: number;
    model?: string;
    errors: string[];
}
/** Aggregate statistics from an event log. */
export declare function summarizeStats(events: readonly SessionEvent[], maxResultChars?: number): ExportStats;
/**
 * Render a full session transcript to Markdown.
 * @param events - the session event log, in seq order.
 * @param meta - creation metadata for the header.
 * @param maxResultChars - truncation bound for tool results and arguments.
 * @param includeInjected - when false, drops synthetic injection messages
 *   (runtime-context snapshots, skill catalogs, plugin notices) that would
 *   drown a human-facing transcript.
 */
export declare function renderSessionMarkdown(events: readonly SessionEvent[], meta: ExportMeta, maxResultChars?: number, includeInjected?: boolean): string;
