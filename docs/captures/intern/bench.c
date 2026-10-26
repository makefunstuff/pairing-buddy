// Interns 4000 symbol names twice, as a compiler's lexer would, and says how far the lookups probe.
#include <stdio.h>
#include <stdlib.h>
#include "intern.h"

#define NAMES 4000

int main(void) {
	static struct table t;
	static char names[NAMES][16];
	for (int i = 0; i < NAMES; i++)
		snprintf(names[i], sizeof names[i], "sym_%d", i);
	for (int round = 0; round < 2; round++)
		for (int i = 0; i < NAMES; i++)
			intern(&t, names[i]);
	printf("interned %d names, %d slots\n", NAMES, CAP);
	printf("avg probe %.1f\n", (double)t.probes / t.lookups);
	return 0;
}
