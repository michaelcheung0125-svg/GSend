import type { ClientMessage, ServerMessage } from "../../shared/protocol";

export interface SignalingHandlers {
  onOpen(): void;
  onMessage(msg: ServerMessage): void;
  onClose(code: number): void;
}

/** Thin typed wrapper over the WebSocket to the Worker. Reconnection lives in the client. */
export class Signaling {
  private socket: WebSocket | null = null;

  constructor(private readonly handlers: SignalingHandlers) {}

  connect(params: Record<string, string>): void {
    this.close();

    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams(params).toString();
    const socket = new WebSocket(`${scheme}//${location.host}/api/ws?${query}`);
    this.socket = socket;

    socket.addEventListener("open", () => this.handlers.onOpen());
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        this.handlers.onMessage(JSON.parse(event.data) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    });
    socket.addEventListener("close", (event) => {
      if (this.socket === socket) this.socket = null;
      this.handlers.onClose(event.code);
    });
    socket.addEventListener("error", () => {
      /* the close handler runs next and carries the outcome */
    });
  }

  send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, "client closed");
  }
}
