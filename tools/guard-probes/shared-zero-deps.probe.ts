// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: M0 acceptance criterion
// Both apps import shared; it must stay dependency-free.
import { PrismaClient } from '@prisma/client';

export const probe = PrismaClient;
