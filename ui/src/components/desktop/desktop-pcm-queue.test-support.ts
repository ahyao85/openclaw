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
