#include <stdio.h>
#include "ring.h"

int main(void) {
	int buf[3];
	struct ring r;
	ring_init(&r, buf, 3);
	for (int i = 1; i <= 5; i++)
		ring_push(&r, i);
	int v;
	while (ring_pop(&r, &v) == 0)
		printf("%d\n", v);
	return 0;
}
