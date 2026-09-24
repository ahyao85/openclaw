import type { DesktopObserveResult } from "@openclaw/gateway-protocol";
import { resolveGatewayWebSocketUrl } from "../../lib/gateway-websocket-url.ts";
import { DesktopPcmQueue } from "./desktop-pcm-queue.ts";

type DesktopAudioStream = NonNullable<DesktopObserveResult["audio"]>;

export type DesktopAudioState =
  | "unavailable"
  | "retired"
  | "connecting"
  | "muted"
  | "starting"
  | "playing"
  | "blocked"
  | "unsupported"
  | "error";

const SAMPLE_RATE = 48_000;

/** One desktop observation's receive-only audio socket and playback intent. */
export class DesktopAudio {
  state: DesktopAudioState = "unavailable";
  private socket: WebSocket | null = null;
  private context: AudioContext | null = null;
  private queue: DesktopPcmQueue | null = null;
  private generation = 0;
  private intent = 0;
  private pendingStops = 0;
  private startReady = false;
  private startRequested = false;

  constructor(private readonly onChange: () => void) {}

  connect(stream: DesktopAudioStream | undefined, gatewayUrl: string): void {
    this.close();
    if (!stream) {
      return;
    }
    if (typeof AudioContext !== "function") {
      this.setState("unsupported");
      return;
    }
    const generation = this.generation;
    this.pendingStops = 0;
    try {
      const socket = new WebSocket(resolveGatewayWebSocketUrl(stream.wsPath, gatewayUrl));
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      const current = () => generation === this.generation && this.socket === socket;
      socket.onopen = () => {
        if (current()) {
          this.setState("muted");
        }
      };
      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (!current()) {
          return;
        }
        if (typeof event.data === "string") {
          this.handleStatus(event.data);
        } else if (event.data instanceof ArrayBuffer && this.state === "playing") {
          if (this.context?.state !== "running") {
            this.stop("blocked");
            return;
          }
          try {
            this.queue?.play(new Uint8Array(event.data));
          } catch {
            this.stop("error");
          }
        }
      };
      const failed = () => {
        if (current()) {
          this.close();
          this.setState("error");
        }
      };
      socket.onerror = failed;
      socket.onclose = failed;
      this.setState("connecting");
    } catch {
      this.close();
      this.setState("error");
    }
  }

  /** Called directly by the button handler: resume must retain user activation. */
  unmute(): void {
    const socket = this.socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      this.state === "starting" ||
      this.state === "playing"
    ) {
      return;
    }
    const generation = this.generation;
    const intent = ++this.intent;
    try {
      const context = new AudioContext({ latencyHint: "interactive", sampleRate: SAMPLE_RATE });
      this.context = context;
      const resumed = context.resume();
      this.setState("starting");
      void resumed.then(
        () => {
          if (
            generation !== this.generation ||
            intent !== this.intent ||
            this.context !== context
          ) {
            return;
          }
          if (context.state !== "running") {
            this.stop("blocked");
            return;
          }
          this.startReady = true;
          this.startCapture();
        },
        () => {
          if (generation === this.generation && intent === this.intent) {
            this.stop("blocked");
          }
        },
      );
    } catch {
      this.stop("blocked");
    }
  }

  mute(): void {
    this.stop("muted");
  }

  retire(advertised = this.state !== "unavailable"): void {
    this.close();
    if (advertised) {
      this.setState("retired");
    }
  }

  close(): void {
    ++this.generation;
    this.stop("unavailable");
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }

  private stop(state: DesktopAudioState): void {
    ++this.intent;
    this.startReady = false;
    this.startRequested = false;
    this.queue?.stop();
    this.queue = null;
    const context = this.context;
    this.context = null;
    if (context) {
      void context.close().catch(() => undefined);
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.pendingStops += 1;
        this.socket.send(JSON.stringify({ action: "stop" }));
      } catch {
        // Local teardown must still silence playback after a transport failure.
      }
    }
    this.setState(state);
  }

  private startCapture(): void {
    // A stopped acknowledgment is the ordered barrier for the old capture.
    // Do not send the new start until every prior stop has crossed that barrier:
    // a superseded start may still acknowledge, or be canceled without an ack.
    const socket = this.socket;
    if (!socket || !this.startReady || this.pendingStops > 0) {
      return;
    }
    this.startReady = false;
    this.startRequested = true;
    try {
      socket.send(JSON.stringify({ action: "start" }));
    } catch {
      this.stop("error");
    }
  }

  private handleStatus(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null || !("state" in message)) {
      return;
    }
    if (this.pendingStops > 0) {
      if (message.state === "stopped") {
        this.pendingStops -= 1;
        this.startCapture();
      }
      return;
    }
    if (message.state === "started" && this.state === "starting" && this.startRequested) {
      this.startRequested = false;
      if (this.context?.state !== "running") {
        this.stop("blocked");
        return;
      }
      // PCM before this acknowledgment belongs to an old capture. Start with a
      // fresh stereo-frame remainder exactly at the accepted capture boundary.
      this.queue = new DesktopPcmQueue(this.context);
      this.setState("playing");
    } else if (
      (this.state === "starting" || this.state === "playing") &&
      (message.state === "error" || message.state === "stopped")
    ) {
      this.stop("error");
    }
  }

  private setState(state: DesktopAudioState): void {
    this.state = state;
    this.onChange();
  }
}
