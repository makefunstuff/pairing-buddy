// probe: how well does the entity table spread its keys?
#include <stdint.h>
#include <stdio.h>
#include <time.h>

#define CAP (1u << 18)
#define N 190000

static uint32_t keys[CAP];
static uint8_t used[CAP];

static uint32_t hash(uint32_t key) {
    return key & (CAP - 1);
}

static uint32_t insert(uint32_t key) {
    uint32_t i = hash(key), probes = 1;
    while (used[i]) { i = (i + 1) & (CAP - 1); probes++; }
    used[i] = 1; keys[i] = key;
    return probes;
}

static int find(uint32_t key) {
    for (uint32_t i = hash(key); used[i]; i = (i + 1) & (CAP - 1))
        if (keys[i] == key) return 1;
    return 0;
}

int main(void) {
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    uint64_t total = 0; uint32_t worst = 0;
    for (uint32_t e = 0; e < N; e++) {
        uint32_t id = e * 64; // entity ids come from the slab allocator
        uint32_t p = insert(id);
        total += p; if (p > worst) worst = p;
    }
    uint32_t found = 0;
    for (int round = 0; round < 20; round++)
        for (uint32_t e = 0; e < N; e++) found += find(e * 64);
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double ms = (t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6;
    printf("%d keys  load %.2f  avg probe %.1f  worst %u  %.0f ms\n", N, (double)N / CAP, (double)total / N, worst, ms);
    return found == 20 * N ? 0 : 1;
}
