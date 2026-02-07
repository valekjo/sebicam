// RTCDataChannel wrapper with the same event API as SignalingClient
//
// Used for post-connection signaling: renegotiation, status updates, etc.

export class DataChannelSignaling {
  /** @type {RTCDataChannel} */
  #channel;
  /** @type {Map<string, Function[]>} */
  #listeners = new Map();
  #ready = false;

  /**
   * @param {RTCDataChannel} channel - an open (or opening) RTCDataChannel
   */
  constructor(channel) {
    this.#channel = channel;

    channel.onopen = () => {
      this.#ready = true;
      this.#emit('connected');
    };

    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.#emit(msg.type, msg);
      } catch {
        console.error('Invalid data channel message');
      }
    };

    channel.onclose = () => {
      this.#ready = false;
      this.#emit('disconnected');
    };

    channel.onerror = () => {
      this.#ready = false;
    };

    // Channel may already be open (e.g. created by remote)
    if (channel.readyState === 'open') {
      this.#ready = true;
    }
  }

  /**
   * @param {object} msg
   */
  send(msg) {
    if (this.#ready && this.#channel.readyState === 'open') {
      this.#channel.send(JSON.stringify(msg));
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
      for (const cb of cbs) cb(data);
    }
  }

  get connected() {
    return this.#ready && this.#channel.readyState === 'open';
  }

  close() {
    this.#channel.close();
    this.#ready = false;
  }
}
