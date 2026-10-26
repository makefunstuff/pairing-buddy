// Interns names: each distinct name gets one id, kept in an open-addressing table.
#ifndef INTERN_H
#define INTERN_H

#define CAP 8192 // slots; a power of two

struct table {
	const char *names[CAP];
	long probes; // slots looked at, over all lookups
	long lookups;
};

int intern(struct table *t, const char *name);

#endif
