// A client of the daemon's socket for the tests, as Neovim, the chat pane or the shell hook would be.
import {connect} from 'node:net';
import {readMessages, sendMessage} from '../src/protocol.mjs';

/** A socket client that collects what the daemon sends and can wait for a message. */
export function client(socketPath, hello) {
  const socket = connect(socketPath);
  const received = [];
  const waiters = [];
  readMessages(socket, message => {
    received.push(message);
    for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
  });
  socket.on('connect', () => sendMessage(socket, hello));
  return {
    received,
    send: message => sendMessage(socket, message),
    next: match => new Promise(resolve => {
      const found = received.find(match);
      if (found) resolve(found); else waiters.push({match, resolve});
    }),
    close: () => socket.destroy(),
  };
}
