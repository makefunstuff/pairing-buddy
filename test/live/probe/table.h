#ifndef TABLE_H
#define TABLE_H
#include <stddef.h>

typedef struct {
    unsigned *keys;
    unsigned char *used;
    size_t len, cap;
    size_t probes; // slots looked at by every put so far
} Table;

Table table_new(size_t cap);
void table_put(Table *t, unsigned key);
void table_free(Table *t);

#endif
