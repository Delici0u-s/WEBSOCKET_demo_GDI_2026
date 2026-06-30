// messageBus.js
// A tiny in-memory pub/sub that simulates a chat backend.
// Both the WebSocket endpoint and the HTTP-polling endpoint read from the
// SAME source, so any benchmark comparison is apples-to-apples: identical
// payloads, identical timing of "new message" events.

import { EventEmitter } from "node:events";

class MessageBus extends EventEmitter {
  constructor() {
    super();
    this.log = []; // append-only message history; index == message id
  }

  /**
   * Publish a new chat message.
   * @param {string} text
   * @returns {{id:number, text:string, ts:number}}
   */
  publish(text) {
    const msg = { id: this.log.length, text, ts: Date.now() };
    this.log.push(msg);
    this.emit("message", msg); // WS path listens to this
    return msg;
  }

  /**
   * Return every message with id strictly greater than `sinceId`.
   * This is what an HTTP poll request asks for ("give me what's new").
   * @param {number} sinceId
   */
  since(sinceId) {
    if (sinceId < 0) sinceId = -1;
    return this.log.slice(sinceId + 1);
  }

  get lastId() {
    return this.log.length - 1;
  }
}

export const bus = new MessageBus();
