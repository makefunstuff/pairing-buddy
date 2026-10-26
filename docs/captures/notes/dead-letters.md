# Dead letters

A webhook that can't be delivered should not vanish. Today `Deliver` gives
up and returns `ErrBudget`, and the job is dropped.

## What we want

- A failed webhook goes to a dead-letter table after its last attempt.
- An operator can see them on the admin page and replay one.
- Replay sends the same payload with the same id.

## How

Keep at most 5 attempts per webhook, then park it in `dead_letters`.
The admin page lists the parked ones, newest first.

Replay puts the job back on the queue as a new attempt 1, so it gets
the full budget again.

We park after 6 attempts so a receiver that is down for a minute
still gets the webhook.

## Open

- How long do we keep dead letters?
- Operators should be able to see the failed webhooks and replay them.
