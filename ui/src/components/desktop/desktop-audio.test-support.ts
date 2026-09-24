import { vi } from "vitest";

class AudioSourceMock {
  buffer: { duration: number; getChannelData(channel: number): Float32Array } | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

export class AudioContextMock {
  static instances: AudioContextMock[] = [];
  state = "running";
  currentTime = 0;
  destination = {};
  sources: AudioSourceMock[] = [];
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(async () => {
    this.state = "closed";
  });
  constructor() {
    AudioContextMock.instances.push(this);
  }
  createBuffer(channels: number, length: number, rate: number) {
    const samples = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / rate, getChannelData: (channel: number) => samples[channel]! };
  }
  createBufferSource() {
    const source = new AudioSourceMock();
    this.sources.push(source);
    return source;
  }
}

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
