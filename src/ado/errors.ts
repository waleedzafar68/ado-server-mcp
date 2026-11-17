export type AdoErrorKind =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'version'
  | 'network'
  | 'tls'
  | 'bad_request'
  | 'conflict'
  | 'server'
  | 'credential'
  | 'read_only'
  | 'too_large'
  | 'confirmation_required'
  | 'declined';

export class AdoError extends Error {
  constructor(
    readonly kind: AdoErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AdoError';
  }
}

export interface DisambiguationOption {
  collection: string;
  project?: string;
  repository?: string;
  projects?: string[];
  note?: string;
}

export interface DisambiguationPayload {
  status: 'disambiguation_required';
  missing: 'collection' | 'project' | 'repository';
  message: string;
  options: DisambiguationOption[];
}

export class DisambiguationRequired extends Error {
  constructor(readonly payload: DisambiguationPayload) {
    super(payload.message);
    this.name = 'DisambiguationRequired';
  }
}

const MAX_MESSAGE_LENGTH = 500;

export function extractAdoMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return 'The response body was empty.';
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim().slice(0, MAX_MESSAGE_LENGTH);
    }
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return trimmed.slice(0, MAX_MESSAGE_LENGTH);
}