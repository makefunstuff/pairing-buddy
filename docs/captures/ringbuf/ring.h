// A ring of ints over a buffer the caller owns.
#ifndef RING_H
#define RING_H

struct ring {
	int *buf;
	int cap;
	int head; // the oldest value
	int len;
};

void ring_init(struct ring *r, int *buf, int cap);
int ring_push(struct ring *r, int value);
int ring_pop(struct ring *r, int *out);

#endif
