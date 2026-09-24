import type { GatewayWsClient } from "./ws-types.js";

type IndexedClient = {
  client: GatewayWsClient;
  order: number;
};

export class GatewayClientRegistry extends Set<GatewayWsClient> {
  readonly #byConnectionId = new Map<string, IndexedClient>();
  readonly #subscribers = new Set<() => void>();
  #nextOrder = 0;

  constructor(clients?: Iterable<GatewayWsClient>) {
    super();
    for (const client of clients ?? []) {
      this.add(client);
    }
  }

  override add(client: GatewayWsClient): this {
    if (!this.has(client)) {
      this.#byConnectionId.set(client.connId, { client, order: this.#nextOrder++ });
      super.add(client);
      this.#publish();
    }
    return this;
  }

  override delete(client: GatewayWsClient): boolean {
    if (!super.delete(client)) {
      return false;
    }
    if (this.#byConnectionId.get(client.connId)?.client === client) {
      this.#byConnectionId.delete(client.connId);
    }
    this.#publish();
    return true;
  }

  override clear(): void {
    if (this.size === 0) {
      return;
    }
    super.clear();
    this.#byConnectionId.clear();
    this.#publish();
  }

  subscribe(listener: () => void): () => void {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  #publish(): void {
    for (const listener of this.#subscribers) {
      listener();
    }
  }

  getByConnectionId(connId: string): GatewayWsClient | undefined {
    return this.#byConnectionId.get(connId)?.client;
  }

  getByConnectionIds(connIds: ReadonlySet<string>): GatewayWsClient[] {
    const indexed: IndexedClient[] = [];
    for (const connId of connIds) {
      const entry = this.#byConnectionId.get(connId);
      if (entry) {
        indexed.push(entry);
      }
    }
    // Targeted fanout keeps authenticated-client insertion order without
    // walking unrelated sockets.
    if (indexed.length > 1) {
      indexed.sort((a, b) => a.order - b.order);
    }
    return indexed.map((entry) => entry.client);
  }
}
