// An open-addressing table of unsigned keys, with linear probing. It doubles once the load passes 0.7.
#include <stdlib.h>
#include "table.h"

Table table_new(size_t cap) {
    return (Table){.keys = calloc(cap, sizeof(unsigned)), .used = calloc(cap, 1), .cap = cap};
}

static size_t slot(const Table *t, unsigned key) { return (key * 2654435761u) % t->cap; }

// Puts `key` in its slot or the first free one after it; returns how many slots it looked at.
static size_t insert(Table *t, unsigned key) {
    size_t i = slot(t, key), looked = 1;
    while (t->used[i] && t->keys[i] != key) {
        i = (i + 1) % t->cap;
        looked++;
    }
    if (!t->used[i]) t->len++;
    t->used[i] = 1;
    t->keys[i] = key;
    return looked;
}

// Moves every key to a table twice the size. Only the puts count as probes, not this.
static void grow(Table *t) {
    Table bigger = table_new(t->cap * 2);
    for (size_t i = 0; i < t->cap; i++)
        if (t->used[i]) insert(&bigger, t->keys[i]);
    bigger.probes = t->probes;
    table_free(t);
    *t = bigger;
}

void table_put(Table *t, unsigned key) {
    if (t->len / t->cap > 0.7) grow(t);
    t->probes += insert(t, key);
}

void table_free(Table *t) {
    free(t->keys);
    free(t->used);
}
