#include <string.h>
#include "intern.h"

static unsigned hash(const char *s) {
	unsigned h = 0;
	while (*s)
		h += (unsigned char)*s++;
	return h;
}

// The id of name: its slot, which it takes if it is new. Linear probing.
int intern(struct table *t, const char *name) {
	unsigned i = hash(name) & (CAP - 1);
	t->lookups++;
	for (;;) {
		t->probes++;
		if (!t->names[i]) {
			t->names[i] = name;
			return (int)i;
		}
		if (strcmp(t->names[i], name) == 0)
			return (int)i;
		i = (i + 1) & (CAP - 1);
	}
}
