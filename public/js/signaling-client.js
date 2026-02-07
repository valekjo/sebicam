// WebSocket signaling client wrapper

export class SignalingClient {
  /** @type {WebSocket | null} */
  #ws = null;
  /** @type {Map<string, Function[]>} */
  #listeners = new Map();
  #url;
  #reconnectTimer = null;
  #shouldReconnect = false;

  /**
   * @param {string} url - WebSocket URL (wss://...)
   */
  constructor(url) {
    this.#url = url;
  }

  connect() {
    this.#shouldReconnect = true;
    this.#doConnect();
  }

  #doConnect() {
    if (this.#ws && (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.#ws = new WebSocket(this.#url);

    this.#ws.onopen = () => {
      this.#emit('connected');
    };

    this.#ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.#emit(msg.type, msg);
      } catch {
        console.error('Invalid message from server');
      }
    };

    this.#ws.onclose = () => {
      this.#emit('disconnected');
      if (this.#shouldReconnect) {
        this.#reconnectTimer = setTimeout(() => this.#doConnect(), 2000);
      }
    };

    this.#ws.onerror = () => {
      // onclose will fire after this
    };
  }

  disconnect() {
    this.#shouldReconnect = false;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  /**
   * @param {object} msg
   */
  send(msg) {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg));
    }
  }

  /**
   * @param {string} event
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, []);
    }
    this.#listeners.get(event).push(callback);
  }

  /**
   * @param {string} event
   * @param {Function} callback
   */
  off(event, callback) {
    const cbs = this.#listeners.get(event);
    if (cbs) {
      this.#listeners.set(event, cbs.filter(cb => cb !== callback));
    }
  }

  /**
   * @param {string} event
   * @param {*} [data]
   */
  #emit(event, data) {
    const cbs = this.#listeners.get(event);
    if (cbs) {
      for (const cb of cbs) {
        cb(data);
      }
    }
  }

  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }
}
