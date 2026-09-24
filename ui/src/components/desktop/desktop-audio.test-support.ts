import { vi } from "vitest";
import { AudioContextMock } from "./desktop-pcm-queue.test-support.ts";

export class AudioSocketMock {
  static OPEN = 1;
  static instances: AudioSocketMock[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor(readonly url: string) {
    AudioSocketMock.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
}

export function stubDesktopAudio() {
  AudioSocketMock.instances = [];
  AudioContextMock.instances = [];
  vi.stubGlobal("WebSocket", AudioSocketMock);
  vi.stubGlobal("AudioContext", AudioContextMock);
}

export const desktopAudioStream = {
  wsPath: "/desktop/audio",
  encoding: "pcm-s16le",
  sampleRate: 48000,
  channels: 2,
} as const;
