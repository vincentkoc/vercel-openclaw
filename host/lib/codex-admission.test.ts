import { describe, expect, it, vi } from 'vitest';
import { admitCodexEvent } from './codex-admission';

describe('Codex admission', () => {
  it('atomically claims the event and one sandbox lease, releasing only the owner', async () => {
    const command = vi.fn().mockResolvedValueOnce('accepted').mockResolvedValueOnce(1);
    const admitted = await admitCodexEvent('sandbox', 'Ev123', { command });
    expect(admitted.status).toBe('accepted');
    const claim = command.mock.calls[0][0];
    expect(claim.slice(0, 3)).toEqual(['EVAL', expect.any(String), 2]);
    expect(claim[3]).toContain(':event:Ev123');
    await admitted.release();
    expect(command.mock.calls[1][0].slice(2)).toEqual([1, claim[4], claim[5]]);
  });
  it.each(['duplicate', 'busy'])('does not release another owner for %s', async status => {
    const command = vi.fn().mockResolvedValue(status);
    const admitted = await admitCodexEvent('sandbox', 'Ev123', { command });
    await admitted.release();
    expect(command).toHaveBeenCalledTimes(1);
  });
  it('fails closed on missing identity or unavailable storage', async () => {
    const command = vi.fn().mockRejectedValue(new Error('unavailable'));
    await expect(admitCodexEvent('sandbox', undefined, { command })).rejects.toThrow();
    expect(command).not.toHaveBeenCalled();
    await expect(admitCodexEvent('sandbox', 'Ev123', { command })).rejects.toThrow('unavailable');
  });
});
