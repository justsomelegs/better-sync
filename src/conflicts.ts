import type { MutationInput } from './types';

/**
 * Server-wins conflict policy: on version mismatch, keep server state, reject the incoming.
 * This module exists to make policy explicit and easily swappable in the future.
 */
export function shouldApplyMutation(
  currentServerVersion: number,
  mutation: MutationInput,
): { apply: boolean; reason?: string } {
  if (currentServerVersion === mutation.clientVersion) return { apply: true };
  return { apply: false, reason: 'version_mismatch' };
}

