#include "ring.h"

void ring_init(struct ring *r, int *buf, int cap) {
	r->buf = buf;
	r->cap = cap;
	r->head = 0;
	r->len = 0;
}

// Adds value after the newest; a full ring drops its oldest.
int ring_push(struct ring *r, int value) {
	if (r->len == r->cap) {
		r->head = (r->head + 1) % r->cap;
		r->len--;
	}
	r->buf[(r->head + r->len) % r->cap] = value;
	r->len++;
	return 0;
}
