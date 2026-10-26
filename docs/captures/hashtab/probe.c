// A hash table with linear probing, and a probe that times a million inserts and lookups.
#include <stdint.h>
#include <stdio.h>
#include <time.h>

#define CAP (1u << 21)

static uint64_t keys[CAP];
static uint32_t probes;

static uint32_t hash(uint64_t key) {
    return (uint32_t)(key * 0x9E3779B97F4A7C15ull >> 43);
}

static void put(uint64_t key) {
    uint32_t i = hash(key) & (CAP - 1);
    while (keys[i] && keys[i] != key) {
        i = (i + 1) & (CAP - 1);
        probes++;
    }
    keys[i] = key;
}

static double ms(clock_t from) {
    return 1000.0 * (double)(clock() - from) / CLOCKS_PER_SEC;
}

int main(void) {
    clock_t start = clock();
    for (uint64_t k = 1; k <= 1000000; k++) put(k * 4096);
    printf("insert 1M: %.1f ms, %u probes\n", ms(start), probes);
    return 0;
}
