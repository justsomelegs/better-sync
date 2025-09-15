import { describe, it, expect } from 'vitest';
import { createAdapterFromUrl } from '../server';

describe('adapter builder', () => {
	it('returns sqlite adapter for file: URL', async () => {
		const a = await createAdapterFromUrl('file:/tmp/test.sqlite');
		expect(typeof a.begin).toBe('function');
	});
	it('returns sqlite memory adapter for memory URL', async () => {
		const a = await createAdapterFromUrl('memory');
		expect(typeof a.selectWindow).toBe('function');
	});
	it('throws for unknown scheme', async () => {
		await expect(createAdapterFromUrl('unknown://')).rejects.toBeInstanceOf(Error);
	});
});