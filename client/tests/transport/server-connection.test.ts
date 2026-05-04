import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import { generateKeyPair, SignJWT } from "jose";
import { ServerConnection } from "../../src/transport/server-connection.js";
import { mintClientJwt } from "../../src/identity/jwt.js";
import type { Logger } from "../../src/core/log.js";

// Minimal no-op logger for tests
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as unknown as Logger;

// Helper: wait a given number of ms
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type FakeServer = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

async function startFakeServer(opts: {
  serverPriv: CryptoKey;
  onConnection: (ws: WsClient, sendHello: () => Promise<void>) => void;
}): Promise<FakeServer> {
  const httpServer: HttpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = httpServer.address() as { port: number };
  const port = addr.port;

  wss.on("connection", (ws: WsClient) => {
    const sendHello = async (): Promise<void> => {
      const helloJwt = await new SignJWT({})
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer("test-server")
        .setSubject("server")
        .setJti(crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime("1m")
        .sign(opts.serverPriv);
      ws.send(JSON.stringify({ type: "server_hello", jwt: helloJwt }));
    };
    opts.onConnection(ws, sendHello);
  });

  return {
    url: `ws://127.0.0.1:${port}/`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      }),
  };
}

async function makeClientKeypair() {
  return generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
}

describe("ServerConnection", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup().catch(() => {});
    }
  });

  it("happy path: receives server_hello then forwards subsequent messages", async () => {
    const { privateKey: serverPriv, publicKey: serverPub } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const { privateKey: clientPriv } = await makeClientKeypair();

    const receivedMessages: any[] = [];
    let serverSocket: WsClient | null = null;

    const fakeServer = await startFakeServer({
      serverPriv: serverPriv as CryptoKey,
      onConnection: (ws, sendHello) => {
        serverSocket = ws;
        void sendHello();
      },
    });
    cleanups.push(fakeServer.close);

    const conn = new ServerConnection({
      initialUrl: fakeServer.url,
      machineId: "test-machine",
      privateKey: clientPriv,
      serverPublicKey: serverPub,
      persistServerUrl: vi.fn(async () => {}),
      onMessage: (msg) => receivedMessages.push(msg),
      onFatal: vi.fn(),
      log: noopLogger,
    });

    conn.start();
    // Wait for connection + hello processing
    await wait(150);

    // Send a slack_event from the fake server
    serverSocket!.send(JSON.stringify({ type: "slack_event", event: { kind: "app_mention", userId: "U1" } }));
    await wait(50);

    conn.stop();

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0]?.type).toBe("slack_event");
    expect(receivedMessages[0]?.event?.userId).toBe("U1");
  });

  it("migrate: calls persistServerUrl with new URL", async () => {
    const { privateKey: serverPriv, publicKey: serverPub } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const { privateKey: clientPriv } = await makeClientKeypair();

    const persistServerUrl = vi.fn(async (_url: string) => {});
    let serverSocket: WsClient | null = null;

    const fakeServer = await startFakeServer({
      serverPriv: serverPriv as CryptoKey,
      onConnection: (ws, sendHello) => {
        serverSocket = ws;
        void sendHello();
      },
    });
    cleanups.push(fakeServer.close);

    const conn = new ServerConnection({
      initialUrl: fakeServer.url,
      machineId: "test-machine",
      privateKey: clientPriv,
      serverPublicKey: serverPub,
      persistServerUrl,
      onMessage: vi.fn(),
      onFatal: vi.fn(),
      log: noopLogger,
    });

    conn.start();
    await wait(150);

    // Send migrate message
    serverSocket!.send(JSON.stringify({ type: "migrate", new_url: "ws://127.0.0.1:9999/ws" }));
    await wait(100);

    conn.stop();

    expect(persistServerUrl).toHaveBeenCalledWith("ws://127.0.0.1:9999/ws");
  });

  it("fatal close 4403: calls onFatal('revoked') and does not retry", async () => {
    const { privateKey: serverPriv, publicKey: serverPub } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const { privateKey: clientPriv } = await makeClientKeypair();

    const onFatal = vi.fn();
    let serverSocket: WsClient | null = null;

    const fakeServer = await startFakeServer({
      serverPriv: serverPriv as CryptoKey,
      onConnection: (ws, sendHello) => {
        serverSocket = ws;
        void sendHello();
      },
    });
    cleanups.push(fakeServer.close);

    const conn = new ServerConnection({
      initialUrl: fakeServer.url,
      machineId: "test-machine",
      privateKey: clientPriv,
      serverPublicKey: serverPub,
      persistServerUrl: vi.fn(async () => {}),
      onMessage: vi.fn(),
      onFatal,
      log: noopLogger,
    });

    conn.start();
    await wait(150);

    // Close with code 4403 (revoked)
    serverSocket!.close(4403);
    await wait(100);

    expect(onFatal).toHaveBeenCalledWith("revoked");
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it("fatal close 4401: calls onFatal('auth_failed')", async () => {
    const { privateKey: serverPriv, publicKey: serverPub } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const { privateKey: clientPriv } = await makeClientKeypair();

    const onFatal = vi.fn();
    let serverSocket: WsClient | null = null;

    const fakeServer = await startFakeServer({
      serverPriv: serverPriv as CryptoKey,
      onConnection: (ws, sendHello) => {
        serverSocket = ws;
        void sendHello();
      },
    });
    cleanups.push(fakeServer.close);

    const conn = new ServerConnection({
      initialUrl: fakeServer.url,
      machineId: "test-machine",
      privateKey: clientPriv,
      serverPublicKey: serverPub,
      persistServerUrl: vi.fn(async () => {}),
      onMessage: vi.fn(),
      onFatal,
      log: noopLogger,
    });

    conn.start();
    await wait(150);

    // Close with code 4401 (auth_failed)
    serverSocket!.close(4401);
    await wait(100);

    expect(onFatal).toHaveBeenCalledWith("auth_failed");
    expect(onFatal).toHaveBeenCalledTimes(1);
  });
});
