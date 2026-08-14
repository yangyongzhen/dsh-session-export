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

const REASON_LABEL: Record<string, string> = {
	completed: '完成',
	'max-tokens': '达到输出 token 上限',
	error: '出错',
	aborted: '被中断',
	blocked: '被阻塞',
	interrupted: '被中断（恢复）'
};

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n…（截断，共 ${text.length} 字符）`;
}

type TextBlockLike = { type: string; text?: string; content?: readonly TextBlockLike[] };

/** Join the text blocks of a message's content; reasoning is skipped. */
function textOf(content: readonly TextBlockLike[], withReasoning = false): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === 'text' && block.text !== undefined) {
			parts.push(block.text);
		} else if (block.type === 'tool-result' && block.content !== undefined) {
			parts.push(textOf(block.content, withReasoning));
		} else if (withReasoning && block.type === 'reasoning' && block.text !== undefined) {
			parts.push(`[思考] ${block.text}`);
		}
	}
	return parts.join('\n\n');
}

/** Pretty-print a tool arguments JSON string, falling back to the raw text. */
function formatArguments(raw: string): string {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}

/** Human label for a user-message source kind. */
function userLabel(kind: string | undefined): string {
	switch (kind) {
		case 'user': return '用户';
		case 'inject': return '注入上下文';
		case 'goal': return '目标';
		case 'plugin': return '插件';
		case 'model': return '模型';
		case 'tool': return '工具';
		default: return kind === undefined ? '用户' : kind;
	}
}

/** Aggregate statistics from an event log. */
export function summarizeStats(events: readonly SessionEvent[], maxResultChars = 2000): ExportStats {
	let turns = 0;
	let steps = 0;
	let toolCalls = 0;
	let toolErrors = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let model: string | undefined;
	const errors: string[] = [];
	let startTime: number | undefined;
	let endTime: number | undefined;
	for (const event of events) {
		if (startTime === undefined) startTime = event.time;
		endTime = event.time;
		switch (event.type) {
			case 'turn/start': turns += 1; break;
			case 'step/start': steps += 1; break;
			case 'tool/call': toolCalls += 1; break;
			case 'turn/end': {
				if (event.data.reason.kind === 'error') {
					toolErrors += 1;
					errors.push(`${event.data.reason.error.code}: ${event.data.reason.error.message}`);
				}
				break;
			}
			case 'tool/result': {
				if (event.data.error !== undefined) toolErrors += 1;
				break;
			}
			case 'assistant/message': {
				const usage = event.data.usage;
				if (usage !== undefined) {
					inputTokens += usage.inputTokens ?? 0;
					outputTokens += usage.outputTokens ?? 0;
					cacheReadTokens += usage.cacheReadTokens ?? 0;
					cacheWriteTokens += usage.cacheWriteTokens ?? 0;
				}
				break;
			}
			case 'request/header': {
				const config = event.data.header.config;
				if (config !== undefined && model === undefined) {
					model = `${config.provider}/${config.model}`;
				}
				break;
			}
			default: break;
		}
	}
	return {
		turns,
		steps,
		toolCalls,
		toolErrors,
		tokens: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
		durationMs: startTime !== undefined && endTime !== undefined ? Math.max(0, endTime - startTime) : 0,
		startTime,
		endTime,
		model,
		errors
	};
}

function fmtTime(ms: number | undefined): string {
	if (ms === undefined) return '-';
	return new Date(ms).toISOString();
}

function fmtDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const rest = s % 60;
	return h > 0 ? `${h}h ${m}m ${rest}s` : m > 0 ? `${m}m ${rest}s` : `${rest}s`;
}

/**
 * Render a full session transcript to Markdown.
 * @param events - the session event log, in seq order.
 * @param meta - creation metadata for the header.
 * @param maxResultChars - truncation bound for tool results and arguments.
 * @param includeInjected - when false, drops synthetic injection messages
 *   (runtime-context snapshots, skill catalogs, plugin notices) that would
 *   drown a human-facing transcript.
 */
export function renderSessionMarkdown(
	events: readonly SessionEvent[],
	meta: ExportMeta,
	maxResultChars = 2000,
	includeInjected = false
): string {
	const stats = summarizeStats(events);
	const out: string[] = [];
	out.push('# 会话导出', '');
	out.push(`- **会话 ID**：\`${meta.sessionId}\``);
	out.push(`- **创建时间**：${fmtTime(meta.createdAt)}`);
	if (meta.cwd !== undefined) out.push(`- **工作目录**：\`${meta.cwd}\``);
	if (meta.agentPreset !== undefined) out.push(`- **Agent 预设**：${meta.agentPreset}`);
	out.push(`- **导出时间**：${fmtTime(Date.now())}`);
	if (stats.model !== undefined) out.push(`- **模型**：\`${stats.model}\``);
	out.push(
		`- **统计**：${stats.turns} 个 turn · ${stats.steps} 个 step · ${stats.toolCalls} 次工具调用` +
		` · ${stats.tokens.inputTokens} in / ${stats.tokens.outputTokens} out tokens` +
		`（缓存读 ${stats.tokens.cacheReadTokens} / 写 ${stats.tokens.cacheWriteTokens}）` +
		` · 耗时 ${fmtDuration(stats.durationMs)}`
	);
	out.push('');

	let inTurn = false;
	for (const event of events) {
		switch (event.type) {
			case 'turn/start': {
				inTurn = true;
				out.push(`## Turn ${event.data.turn}`, '', `*${fmtTime(event.time)}*`, '');
				break;
			}
			case 'turn/end': {
				const reason = event.data.reason;
				const label = REASON_LABEL[reason.kind] ?? reason.kind;
				out.push(`> Turn ${event.data.turn} 结束：**${label}**`, '');
				inTurn = false;
				break;
			}
			case 'step/start': {
				out.push(`### Step ${event.data.turn}.${event.data.step}`, '');
				break;
			}
			case 'user/message': {
				// source kinds are merge-extensible across packages; only direct
				// user prompts and goal continuations belong in a human transcript
				const kind = event.data.source?.kind as string | undefined;
				if (!includeInjected && kind !== 'user' && kind !== 'goal') break;
				const text = textOf(event.data.content);
				if (text === '') break;
				out.push(`### ${userLabel(kind)}`, '', text, '');
				break;
			}
			case 'assistant/message': {
				const text = textOf(event.data.message.content);
				if (text === '') break;
				out.push(`### 助手`, '', text, '');
				const usage = event.data.usage;
				if (usage !== undefined) {
					const parts = [`in=${usage.inputTokens ?? 0}`, `out=${usage.outputTokens ?? 0}`];
					if (usage.cacheReadTokens !== undefined) parts.push(`cacheRead=${usage.cacheReadTokens}`);
					if (usage.cacheWriteTokens !== undefined) parts.push(`cacheWrite=${usage.cacheWriteTokens}`);
					out.push(`> tokens: ${parts.join(' · ')}`, '');
				}
				break;
			}
			case 'tool/call': {
				out.push(`#### 工具调用：${event.data.name}`, '');
				const args = clip(formatArguments(event.data.arguments), maxResultChars);
				if (args !== '') {
					out.push('```json', args, '```', '');
				}
				break;
			}
			case 'tool/result': {
				const text = textOf(event.data.message.content);
				if (text === '') break;
				const prefix = event.data.error !== undefined ? '**工具出错**' : '工具结果';
				out.push(`#### ${prefix}`, '');
				out.push('```', clip(text, maxResultChars), '```', '');
				break;
			}
			case 'todo/write': {
				if (event.data.todos.length === 0) break;
				out.push('#### 任务清单', '');
				for (const todo of event.data.todos) {
					const mark = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '>' : ' ';
					out.push(`- [${mark}] ${todo.content}`);
				}
				out.push('');
				break;
			}
			default:
				break;
		}
	}

	if (stats.errors.length > 0) {
		out.push('## 错误记录', '');
		for (const error of stats.errors) out.push(`- \`${error}\``);
		out.push('');
	}

	if (inTurn) out.push('> 会话在 turn 进行中导出（进程退出或中断）。', '');

	return out.join('\n');
}
