import { useSyncExternalStore } from 'react';

/**
 * Which microphone dictation, voice messages and calls use.
 *
 * A device id names a device on THIS computer and nothing on another, so the
 * choice lives in the renderer's storage like the theme, not on the account.
 * Null is "System default". A chosen device that is not plugged in is
 * skipped rather than demanded: asking for it would fail every recording with
 * an `OverconstrainedError` until the person found this setting again.
 */
const KEY = 'crewaid.voice.microphone';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readMicrophoneChoice(store: StorageLike | null): string | null {
  try {
    const value = store?.getItem(KEY);
    return value === null || value === undefined || value === '' ? null : value;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let current: string | null | undefined;

export function currentMicrophoneChoice(): string | null {
  if (current === undefined) current = readMicrophoneChoice(storage());
  return current;
}

export function setMicrophoneChoice(deviceId: string | null): void {
  current = deviceId;
  try {
    if (deviceId === null) storage()?.removeItem(KEY);
    else storage()?.setItem(KEY, deviceId);
  } catch {
    // Kept for this session even when it cannot be kept for the next.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMicrophoneChoice(): string | null {
  return useSyncExternalStore(subscribe, currentMicrophoneChoice, () => null);
}

/** The part of `navigator.mediaDevices` this module uses. */
export type MediaDevicesPort = {
  enumerateDevices(): Promise<ReadonlyArray<Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>>>;
  getUserMedia(constraints: {
    audio: true;
  }): Promise<{ getTracks(): ReadonlyArray<{ stop(): void }> }>;
};

export type Microphone = {
  readonly id: string;
  /** Empty until the app has been allowed the microphone once. */
  readonly label: string;
};

function browserDevices(): MediaDevicesPort | null {
  return typeof navigator === 'undefined' || navigator.mediaDevices === undefined
    ? null
    : navigator.mediaDevices;
}

/**
 * The microphones plugged in now. Chromium also lists "default" and, on
 * Windows, "communications": aliases of a real device, which "System
 * default" already stands for — offering them would list one microphone
 * twice under two names.
 */
async function inputs(devices: MediaDevicesPort): Promise<Microphone[]> {
  return (await devices.enumerateDevices())
    .filter(
      (device) =>
        device.kind === 'audioinput' &&
        device.deviceId !== '' &&
        device.deviceId !== 'default' &&
        device.deviceId !== 'communications',
    )
    .map((device) => ({ id: device.deviceId, label: device.label }));
}

/**
 * The microphones to offer. Names are hidden until the app has been allowed
 * the microphone, so with `askForNames` blank names make this ask once and
 * list again — a list of "Microphone 1, Microphone 2" is no help choosing.
 * Only on request, so opening Settings never raises a permission prompt by
 * itself; opening the list does.
 */
export async function listMicrophones(
  devices: MediaDevicesPort | null = browserDevices(),
  { askForNames = false }: { readonly askForNames?: boolean } = {},
): Promise<Microphone[]> {
  if (devices === null) return [];
  const listed = await inputs(devices);
  if (!askForNames || (listed.length > 0 && listed.every((mic) => mic.label !== ''))) {
    return listed;
  }
  try {
    const stream = await devices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  } catch {
    return listed;
  }
  return inputs(devices);
}

/**
 * The device a recording should ask for: the chosen one while it is plugged
 * in, otherwise undefined, which means the system default.
 */
export async function resolveMicrophone(
  choice: string | null = currentMicrophoneChoice(),
  devices: MediaDevicesPort | null = browserDevices(),
): Promise<string | undefined> {
  if (choice === null || devices === null) return undefined;
  try {
    return (await inputs(devices)).some((mic) => mic.id === choice) ? choice : undefined;
  } catch {
    return undefined;
  }
}
