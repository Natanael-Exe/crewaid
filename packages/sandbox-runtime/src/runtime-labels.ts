export const COMPUTER_NAME_PREFIX = 'crewaid-';
export const COMPUTER_LABEL = Object.freeze({ key: 'crewaid', value: 'computer' });
export const FIRST_START_LABEL = 'crewaid-first-start';
export const ORPHANED_AT_LABEL = 'crewaid-orphaned-at';
export const IMAGE_LABEL = 'crewaid-image';
export const IMAGE_REFUSED_LABEL = 'crewaid-image-refused';
export const IMAGE_REFUSED_REASON_LABEL = 'crewaid-image-refused-reason';
export const UPGRADE_COMPUTER_LABEL = 'crewaid-upgrade-computer';
export const UPGRADE_SOURCE_LABEL = 'crewaid-upgrade-source';
export const UPGRADE_REPLACEMENT_LABEL = 'crewaid-upgrade-replacement';
export const UPGRADE_READY_LABEL = 'crewaid-upgrade-ready';
export const UPGRADE_STAGE_ROLE = 'upgrade-stage';
export const UPGRADE_BACKUP_ROLE = 'upgrade-backup';

export function sandboxNameFor(computerId: string): string {
  return `${COMPUTER_NAME_PREFIX}${computerId}`;
}

/** What a computer's snapshot carries, and the backup a restore discards. */
export const SNAPSHOT_ROLE = 'snapshot';
export const RESTORE_DISCARD_LABEL = 'crewaid-restore-discard';

/** The computer's one snapshot. */
export function snapshotNameFor(computerId: string): string {
  return `crewaid-snapshot-${computerId}`;
}

/** A replacement being taken; renamed to `snapshotNameFor` once ready. */
export function pendingSnapshotNameFor(computerId: string): string {
  return `${snapshotNameFor(computerId)}-next`;
}
