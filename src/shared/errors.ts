export type ErrorCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';

export class SyncError extends Error {
	code: ErrorCode;
	status: number;
	details?: unknown;

	constructor(code: ErrorCode, message: string, details?: unknown, status?: number) {
		super(message);
		this.code = code;
		this.details = details;
		this.status = status ?? httpStatusFor(code);
	}
}

export function httpStatusFor(code: ErrorCode): number {
	if (code === 'BAD_REQUEST') return 400;
	if (code === 'NOT_FOUND') return 404;
	if (code === 'CONFLICT') return 409;
	return 500;
}

export function toSyncError(e: unknown): SyncError {
	if (e instanceof SyncError) return e;
	const anyErr = e as any;
	const code = normalizeCode(anyErr?.code);
	const message = anyErr?.message ?? 'Internal error';
	return new SyncError(code, message, anyErr?.details);
}

function normalizeCode(code: any): ErrorCode {
	if (code === 'BAD_REQUEST' || code === 'NOT_FOUND' || code === 'CONFLICT' || code === 'INTERNAL') return code;
	return 'INTERNAL';
}

export function responseFromError(e: unknown, extraDetails?: Record<string, unknown>): Response {
	const err = toSyncError(e);
	const headers = { 'Content-Type': 'application/json' };
	const body = { code: err.code, message: err.message, details: { ...(err.details ?? {}), ...(extraDetails ?? {}) } };
	return new Response(JSON.stringify(body), { status: err.status, headers });
}

