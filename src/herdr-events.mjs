// herdr's push stream: one connection that stays open after `events.subscribe` and carries an event per line.
// It says when focus moves, panes come and go or change, and when a pane's scroll changes; it says nothing about
// commands or keystrokes (see docs/herdr.md).
import {connect} from 'node:net';
import {readMessages, sendMessage} from './protocol.mjs';

const RETRY_MS = 2000;

/**
 * Subscribes to `subscriptions` and calls `onEvent({event, data})` for each event. `onStart()` runs each time the
 * subscription (re)starts, so the caller can look at what it missed; `onError(error)` when the connection fails
 * or drops, after which it is tried again every RETRY_MS. Returns `{close}`.
 */
export function subscribe(socketPath, subscriptions, {onEvent, onStart = () => {}, onError = () => {}}) {
  let socket = null;
  let retry = null;
  let closed = false;

  const again = error => {
    if (closed || retry) return;
    socket?.destroy();
    onError(error);
    retry = setTimeout(() => { retry = null; open(); }, RETRY_MS);
  };

  function open() {
    socket = connect(socketPath);
    socket.on('error', again);
    socket.on('close', () => again(new Error('herdr closed the event stream')));
    socket.on('connect', () => sendMessage(socket, {id: 'subscribe', method: 'events.subscribe', params: {subscriptions}}));
    readMessages(socket, message => {
      if (message.id === 'subscribe') return message.error ? again(new Error(`herdr events.subscribe: ${message.error.message}`)) : onStart();
      if (message.event) onEvent(message);
    });
  }

  open();
  return {
    close() {
      closed = true;
      clearTimeout(retry);
      socket?.destroy();
    },
  };
}
