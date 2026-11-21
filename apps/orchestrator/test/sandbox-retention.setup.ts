import { vi } from 'vitest';
import { SandboxRetentionService } from '../src/sandbox/sandbox-retention.service.js';

// Tests share a daemon with the developer. Never start a host-wide destructive
// timer here; dedicated retention tests drive sweep() with a scoped inventory.
vi.spyOn(SandboxRetentionService.prototype, 'onApplicationBootstrap').mockImplementation(() => {});
