import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const peers = vi.hoisted(() => ({ next: undefined as unknown }));
vi.mock("../../../packages/gateway-client/src/websocket.js", () => ({
  WebSocket: { OPEN: 1 },
  WebSocketServer: class {
    handleUpgrade(
      _req: unknown,
      _socket: unknown,
      _head: unknown,
      callback: (ws: unknown) => void,
    ) {
      callback(peers.next);
    }
  },
}));
vi.mock("../websocket-keepalive.js", () => ({ startWebSocketKeepalive: () => () => {} }));
import { handleDesktopAudioUpgrade, mintDesktopAudioObserver } from "./audio-bridge.js";

class Peer extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | Buffer> = [];
  closed: Array<[number, string]> = [];
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close(code: number, reason: string) {
    this.closed.push([code, reason]);
    this.readyState = 3;
  }
  command(action: string) {
    this.emit("message", Buffer.from(JSON.stringify({ action })), false);
  }
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.useRealTimers();
});
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};

function fixture(requester?: { isCurrent(): boolean; signal?: AbortSignal }) {
  const captures: Array<{
    stream: PassThrough;
    stop: ReturnType<typeof vi.fn>;
    signal: AbortSignal;
  }> = [];
  const start = vi.fn(async (signal: AbortSignal) => {
    const stream = new PassThrough();
    const stop = vi.fn(async () => {
      stream.destroy();
    });
    const capture = { stream, stop, signal };
    captures.push(capture);
    return capture;
  });
  const observation = mintDesktopAudioObserver({ source: { start }, requester });
  cleanups.push(observation.close);
  const peer = new Peer();
  const attach = (path = observation.descriptor.wsPath) => {
    peers.next = peer;
    const transport = new PassThrough();
    handleDesktopAudioUpgrade({ url: path } as IncomingMessage, transport, Buffer.alloc(0));
    return transport;
  };
  return { observation, peer, start, captures, attach };
}

describe("screen-owned desktop audio", () => {
  it("does not capture on attach or before screen authentication, then delivers remote PCM", async () => {
    const f = fixture();
    f.attach();
    await flush();
    expect(f.start).not.toHaveBeenCalled();
    f.peer.command("start");
    await flush();
    expect(f.start).not.toHaveBeenCalled();
    f.observation.activate();
    await flush();
    expect(f.start).toHaveBeenCalledTimes(1);
    const pcm = Buffer.from([0, 1, 0, 2]);
    f.captures[0].stream.write(pcm);
    expect(f.peer.sent).toContainEqual(pcm);
    f.observation.close();
    await flush();
    expect(f.captures[0].signal.aborted).toBe(true);
    expect(f.captures[0].stop).toHaveBeenCalledTimes(1);
  });

  it("mutes immediately and serializes re-enable without overlapping recorders", async () => {
    const f = fixture();
    f.attach();
    f.observation.activate();
    f.peer.command("start");
    await flush();
    f.peer.command("start");
    await flush();
    expect(f.start).toHaveBeenCalledTimes(1);
    f.peer.command("stop");
    const before = f.peer.sent.length;
    f.captures[0].stream.write(Buffer.alloc(4, 10));
    expect(f.peer.sent).toHaveLength(before);
    f.peer.command("start");
    await flush();
    expect(f.captures[0].stop).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it("coalesces pending intent while screen authentication is incomplete", async () => {
    const f = fixture();
    f.attach();
    for (let n = 0; n < 100; n++) {
      f.peer.command("start");
      f.peer.command("stop");
    }
    f.peer.command("start");
    f.observation.activate();
    await flush();
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("rejects replay and retires abandoned screen grants", async () => {
    const f = fixture();
    f.attach();
    const replay = f.attach();
    expect(replay.read()?.toString()).toContain("401");
    f.peer.command("start");
    f.observation.close();
    f.observation.activate();
    await flush();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("revokes audio when requester authority changes, including in-flight capture", async () => {
    let current = true;
    const f = fixture({ isCurrent: () => current });
    f.attach();
    f.observation.activate();
    f.peer.command("start");
    await flush();
    current = false;
    f.captures[0].stream.write(Buffer.alloc(4, 1));
    await flush();
    expect(f.peer.sent.some(Buffer.isBuffer)).toBe(false);
    expect(f.captures[0].stop).toHaveBeenCalledTimes(1);
  });

  it("reports unexpected recorder close and permits a new capture", async () => {
    const f = fixture();
    f.attach();
    f.observation.activate();
    f.peer.command("start");
    await flush();
    f.captures[0].stream.destroy();
    f.captures[0].stream.emit("close");
    await flush();
    expect(
      f.peer.sent.some((item) => typeof item === "string" && JSON.parse(item).state === "error"),
    ).toBe(true);
    expect(f.captures[0].stop).toHaveBeenCalledTimes(1);
    expect(f.captures[0].stream.listenerCount("data")).toBe(0);
    f.peer.command("start");
    await flush();
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it("bounds slow-reader buffers instead of accumulating delayed sound", async () => {
    const f = fixture();
    f.attach();
    f.observation.activate();
    f.peer.command("start");
    await flush();
    f.peer.bufferedAmount = 48_000;
    f.captures[0].stream.write(Buffer.alloc(4));
    await flush();
    expect(f.peer.closed).toContainEqual([1013, "desktop audio backpressure"]);
    expect(f.captures[0].signal.aborted).toBe(true);
    expect(f.captures[0].stop).toHaveBeenCalledTimes(1);
  });

  it("rejects binary or unknown commands without starting capture", async () => {
    const f = fixture();
    f.attach();
    f.observation.activate();
    f.peer.emit("message", Buffer.alloc(4), true);
    await flush();
    expect(f.peer.closed[0]?.[0]).toBe(1008);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("expires unused audio tickets and closes with requester cancellation", async () => {
    vi.useFakeTimers();
    const expired = fixture();
    vi.advanceTimersByTime(60_001);
    const transport = expired.attach();
    expect(transport.read()?.toString()).toContain("401");
    const abort = new AbortController();
    const f = fixture({ isCurrent: () => true, signal: abort.signal });
    f.attach();
    abort.abort();
    f.peer.command("start");
    await flush();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.peer.closed.length).toBeGreaterThan(0);
  });
});
