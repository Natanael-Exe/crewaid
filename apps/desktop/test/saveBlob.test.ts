import { describe, expect, it, vi } from 'vitest';
import { saveBlobAs, type BlobSaverPorts } from '../src/renderer/components/attachments/saveBlob';

function ports(overrides: Partial<BlobSaverPorts> = {}) {
  const calls: string[] = [];
  const base: BlobSaverPorts = {
    createObjectURL: vi.fn(() => {
      calls.push('create');
      return 'blob:crewaid/1';
    }),
    revokeObjectURL: vi.fn(() => calls.push('revoke')),
    startDownload: vi.fn(() => calls.push('start')),
    // Runs the timer body inline so the ordering assertions stay synchronous.
    setTimeoutFn: vi.fn((handler: () => void) => handler()),
    ...overrides,
  };
  return { ports: base, calls };
}

describe('saveBlobAs', () => {
  it('hands the blob URL and the filename to the download, then releases the URL', () => {
    const { ports: p, calls } = ports();
    saveBlobAs(new Blob(['x']), 'leads.csv', p);

    expect(p.startDownload).toHaveBeenCalledWith('blob:crewaid/1', 'leads.csv');
    expect(calls).toEqual(['create', 'start', 'revoke']);
  });

  it('defers revocation to a later task — a URL freed in this one truncates the file', () => {
    const deferred: (() => void)[] = [];
    const { ports: p } = ports({
      setTimeoutFn: vi.fn((handler: () => void) => {
        deferred.push(handler);
      }),
    });
    saveBlobAs(new Blob(['x']), 'leads.csv', p);

    // The transfer has started and the URL is still alive.
    expect(p.startDownload).toHaveBeenCalled();
    expect(p.revokeObjectURL).not.toHaveBeenCalled();

    deferred.forEach((run) => run());
    expect(p.revokeObjectURL).toHaveBeenCalledWith('blob:crewaid/1');
  });

  it('releases the URL immediately when the download never started', () => {
    const { ports: p } = ports({
      startDownload: vi.fn(() => {
        throw new Error('no document');
      }),
    });

    expect(() => saveBlobAs(new Blob(['x']), 'leads.csv', p)).toThrow('no document');
    expect(p.revokeObjectURL).toHaveBeenCalledWith('blob:crewaid/1');
    expect(p.setTimeoutFn).not.toHaveBeenCalled();
  });
});
