/**
 * shared/lifecycle-bus.cjs - Cordis-inspired Agent Lifecycle & Event Bus
 *
 * Provides a lightweight, zero-dependency event bus and middleware pipeline for
 * the harness. Allows intercepting pre/post tool execution, prompt mutations, context filtering,
 * and error/divergence events with priority ordering and async cancellation.
 */

'use strict';

class LifecycleBus {
  constructor() {
    this.listeners = new Map(); // eventName -> Array<{ priority: number, handler: Function }>
    this.middlewares = []; // Array<{ name: string, phase: string, fn: Function }>
  }

  /**
   * Subscribe to a lifecycle event with optional priority (higher runs first).
   */
  on(event, handler, priority = 0) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    const list = this.listeners.get(event);
    list.push({ priority, handler });
    list.sort((a, b) => b.priority - a.priority);
    return () => this.off(event, handler);
  }

  /**
   * Unsubscribe a handler.
   */
  off(event, handler) {
    if (!this.listeners.has(event)) return;
    const list = this.listeners.get(event).filter(item => item.handler !== handler);
    this.listeners.set(event, list);
  }

  /**
   * Emit an event asynchronously to all registered handlers.
   */
  async emit(event, payload = {}) {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return payload;

    let currentPayload = { ...payload, _event: event, _timestamp: Date.now() };
    for (const item of list) {
      try {
        const result = await item.handler(currentPayload);
        if (result && typeof result === 'object') {
          currentPayload = { ...currentPayload, ...result };
        }
      } catch (err) {
        console.error(`[LifecycleBus] Error in handler for event "${event}":`, err.message);
        currentPayload._error = err;
      }
    }
    return currentPayload;
  }

  /**
   * Register a middleware for a specific execution phase (e.g. 'pre-tool', 'post-tool', 'transform-prompt')
   */
  use(phase, fn, name = 'anonymous') {
    this.middlewares.push({ name, phase, fn });
  }

  /**
   * Pipeline execution for a phase with request/response modification context.
   */
  async pipeline(phase, ctx) {
    const matching = this.middlewares.filter(m => m.phase === phase);
    let currentCtx = ctx;

    for (const mw of matching) {
      try {
        const nextCtx = await mw.fn(currentCtx);
        if (nextCtx) currentCtx = nextCtx;
      } catch (err) {
        console.error(`[LifecycleBus] Middleware "${mw.name}" error during phase "${phase}":`, err.message);
        currentCtx.error = err;
        break;
      }
    }
    return currentCtx;
  }
}

// Global default bus instance
const globalBus = new LifecycleBus();

module.exports = {
  LifecycleBus,
  globalBus
};
