import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
/** Stable Cordis plugin name. */
declare const name = "session-export";
/** Core services required before the exporter can run. */
declare const inject: string[];
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
declare const Config: z<Schemastery.ObjectS<{
    /** Master switch; false disables auto export entirely. */
    enabled: z<boolean, boolean>;
    /** Export directory; defaults to $DSH_HOME/exports. */
    outDir: z<string, string>;
    /** Quiet time after turn/end before the session is written. */
    debounceMs: z<number, number>;
    /** Truncation bound for tool arguments and results in the transcript. */
    maxResultChars: z<number, number>;
    /** Include synthetic injection messages (context snapshots, skill catalogs). */
    includeInjected: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    /** Master switch; false disables auto export entirely. */
    enabled: z<boolean, boolean>;
    /** Export directory; defaults to $DSH_HOME/exports. */
    outDir: z<string, string>;
    /** Quiet time after turn/end before the session is written. */
    debounceMs: z<number, number>;
    /** Truncation bound for tool arguments and results in the transcript. */
    maxResultChars: z<number, number>;
    /** Include synthetic injection messages (context snapshots, skill catalogs). */
    includeInjected: z<boolean, boolean>;
}>>;
/**
 * Export one session to a Markdown file. Returns the written file path, or
 * undefined when the session has no message content worth exporting.
 */
export declare function exportSession(session: Session, config: SessionExportConfig): string | undefined;
/**
 * Mount the exporter: subscribe to the event firehose and flush pending
 * exports on dispose.
 */
declare function apply(ctx: Context, config: SessionExportConfig): void;
export { Config, apply, inject, name };
